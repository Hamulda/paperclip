import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, executionWorkspaces, workspaceRuntimeServices, issues } from "@paperclipai/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { asString, parseObject } from "../adapters/utils.js";

export interface SwarmDigestAgent {
  id: string;
  name: string;
  status: string;
}

export interface SwarmDigestRun {
  id: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  startedAt: string | null;
}

export interface SwarmDigestWorkspace {
  id: string;
  name: string;
  branchName: string | null;
  worktreePath: string | null;
  status: string;
  sourceIssueId: string | null;
}

export interface SwarmDigestService {
  id: string;
  serviceName: string;
  status: string;
  url: string | null;
  ownerAgentId: string | null;
}

export interface SwarmDigestFileClaimConflict {
  claimPath: string;
  claimType: string;
  conflictingAgentId: string;
  conflictingRunId: string;
}

export interface SwarmDigest {
  companyId: string;
  projectId: string | null;
  generatedAt: string;
  activeAgents: SwarmDigestAgent[];
  activeRuns: SwarmDigestRun[];
  workspaces: SwarmDigestWorkspace[];
  services: SwarmDigestService[];
  fileClaimConflicts: SwarmDigestFileClaimConflict[];
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim() || "";
}

function buildEmptyDigest(companyId: string, projectId: string | null): SwarmDigest {
  return {
    companyId,
    projectId,
    generatedAt: new Date().toISOString(),
    activeAgents: [],
    activeRuns: [],
    workspaces: [],
    services: [],
    fileClaimConflicts: [],
  };
}

export async function buildSwarmDigest(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null;
    currentRunId?: string | null;
    currentAgentId?: string | null;
  },
): Promise<SwarmDigest> {
  const { companyId, projectId, currentRunId = null, currentAgentId = null } = input;

  if (!companyId) {
    return buildEmptyDigest(companyId, projectId);
  }

  // 1. Active agents in the company
  const activeAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "deleted")))
    .then((rows) =>
      rows.map((row): SwarmDigestAgent => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
    );

  // 2. Active runs (running or queued) for the company, optionally scoped to project
  const activeRunConditions = [
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.status, ["running", "queued"]),
  ];

  // Filter out the current run itself
  if (currentRunId) {
    activeRunConditions.push(ne(heartbeatRuns.id, currentRunId));
  }

  // Get runs scoped to project via contextSnapshot projectId
  let activeRuns: SwarmDigestRun[] = [];
  if (activeAgents.length > 0) {
    const agentIds = activeAgents.map((a) => a.id);

    const runRows = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.agentId, agentIds), inArray(heartbeatRuns.status, ["running", "queued"])))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(50);

    // Extract issue info from contextSnapshot
    const issueIds = new Set<string>();
    for (const run of runRows) {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId) issueIds.add(issueId);
    }

    // Batch fetch issue identifiers and titles
    const issueRows = issueIds.size > 0
      ? await db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
          .from(issues)
          .where(inArray(issues.id, Array.from(issueIds)))
      : [];
    const issueMap = new Map(issueRows.map((i) => [i.id, { identifier: i.identifier, title: i.title }]));

    activeRuns = runRows
      .map((run): SwarmDigestRun => {
        const context = parseObject(run.contextSnapshot);
        const issueId = readNonEmptyString(context.issueId) || null;
        const issueInfo = issueId ? issueMap.get(issueId) : null;
        return {
          id: run.id,
          agentId: run.agentId,
          issueId,
          issueIdentifier: issueInfo?.identifier ?? null,
          issueTitle: issueInfo?.title ?? null,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
        };
      })
      .filter((run) => run.agentId !== currentAgentId || run.id !== currentRunId);
  }

  // 3. Execution workspaces for the project/company
  let workspaces: SwarmDigestWorkspace[] = [];
  if (projectId) {
    const workspaceRows = await db
      .select({
        id: executionWorkspaces.id,
        name: executionWorkspaces.name,
        branchName: executionWorkspaces.branchName,
        worktreePath: executionWorkspaces.providerRef,
        status: executionWorkspaces.status,
        sourceIssueId: executionWorkspaces.sourceIssueId,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.projectId, projectId),
          eq(executionWorkspaces.status, "active"),
        ),
      )
      .orderBy(desc(executionWorkspaces.lastUsedAt))
      .limit(20);

    workspaces = workspaceRows.map((w): SwarmDigestWorkspace => ({
      id: w.id,
      name: w.name,
      branchName: w.branchName,
      worktreePath: w.worktreePath,
      status: w.status,
      sourceIssueId: w.sourceIssueId,
    }));
  }

  // 4. Runtime services for active execution workspaces
  let services: SwarmDigestService[] = [];
  const activeWorkspaceIds = workspaces.map((w) => w.id);
  if (activeWorkspaceIds.length > 0) {
    const serviceRows = await db
      .select({
        id: workspaceRuntimeServices.id,
        serviceName: workspaceRuntimeServices.serviceName,
        status: workspaceRuntimeServices.status,
        url: workspaceRuntimeServices.url,
        ownerAgentId: workspaceRuntimeServices.ownerAgentId,
      })
      .from(workspaceRuntimeServices)
      .where(
        and(
          inArray(workspaceRuntimeServices.executionWorkspaceId, activeWorkspaceIds),
          inArray(workspaceRuntimeServices.status, ["running", "starting"]),
        ),
      )
      .orderBy(desc(workspaceRuntimeServices.lastUsedAt))
      .limit(30);

    services = serviceRows.map((s): SwarmDigestService => ({
      id: s.id,
      serviceName: s.serviceName,
      status: s.status,
      url: s.url,
      ownerAgentId: s.ownerAgentId,
    }));
  }

  return {
    companyId,
    projectId,
    generatedAt: new Date().toISOString(),
    activeAgents,
    activeRuns,
    workspaces,
    services,
    fileClaimConflicts: [],
  };
}

export function formatSwarmDigestForPrompt(digest: SwarmDigest): string {
  const lines: string[] = [];

  lines.push("## Coding Swarm Status");
  lines.push("");

  // Active agents
  if (digest.activeAgents.length > 0) {
    const otherAgents = digest.activeAgents.filter((a) => a.status === "running");
    if (otherAgents.length > 0) {
      lines.push("### Active Agents");
      for (const agent of otherAgents) {
        lines.push(`- **${agent.name}** (${agent.status})`);
      }
      lines.push("");
    }
  }

  // Active runs with issues
  if (digest.activeRuns.length > 0) {
    lines.push("### Active Runs");
    for (const run of digest.activeRuns.slice(0, 10)) {
      const issueInfo = run.issueIdentifier
        ? `[${run.issueIdentifier}] ${run.issueTitle ?? "Unknown issue"}`
        : "No issue";
      lines.push(`- Run ${run.id.slice(0, 8)}: ${issueInfo} (${run.status})`);
    }
    lines.push("");
  }

  // Workspaces
  if (digest.workspaces.length > 0) {
    lines.push("### Active Workspaces");
    for (const ws of digest.workspaces.slice(0, 5)) {
      const branch = ws.branchName ? ` branch:${ws.branchName}` : "";
      lines.push(`- ${ws.name}${branch} (${ws.status})`);
    }
    lines.push("");
  }

  // Runtime services
  if (digest.services.length > 0) {
    lines.push("### Runtime Services");
    for (const svc of digest.services.slice(0, 10)) {
      const url = svc.url ? ` → ${svc.url}` : ` (${svc.status})`;
      lines.push(`- ${svc.serviceName}:${url}`);
    }
    lines.push("");
  }

  // File claim conflicts (warnings)
  if (digest.fileClaimConflicts.length > 0) {
    lines.push("### File Claim Conflicts");
    for (const conflict of digest.fileClaimConflicts.slice(0, 10)) {
      lines.push(`- ⚠️ ${conflict.claimPath} (${conflict.claimType}) claimed by another agent`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Structured Handoff Comment Template & Parser
// =============================================================================

export const HANDOFF_COMMENT_PREFIX = "<!-- SWARM_HANDOFF";
export const HANDOFF_COMMENT_VERSION = "1.0";

export interface StructuredHandoff {
  version: string;
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
  emittedAt: string;
}

function escapeHandoffValue(value: string): string {
  return value.replace(/<!--/g, "<!--~").replace(/-->/g, "~-->");
}

function unescapeHandoffValue(value: string): string {
  return value.replace(/<!--~/g, "<!--").replace(/~-->/g, "-->");
}

function parseHandoffList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.replace(/^[\s-]+/, "").trim())
    .filter(Boolean);
}

export function buildHandoffComment(input: {
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
}): string {
  const escaped = {
    summary: escapeHandoffValue(input.summary),
    currentState: escapeHandoffValue(input.currentState),
    recommendedNextStep: escapeHandoffValue(input.recommendedNextStep),
  };

  const lines: string[] = [
    `<!-- SWARM_HANDOFF v${HANDOFF_COMMENT_VERSION} -->`,
    `<!-- AGENT_ID:${input.agentId} -->`,
    `<!-- AGENT_NAME:${input.agentName} -->`,
    `<!-- RUN_ID:${input.runId} -->`,
    `<!-- ISSUE_ID:${input.issueId ?? ""} -->`,
    ``,
    `## Summary`,
    `${escaped.summary}`,
    ``,
    `## Files touched`,
    ...input.filesTouched.map((f) => `- ${f}`),
    ``,
    `## Current state`,
    `${escaped.currentState}`,
    ``,
    `## Remaining work`,
    ...input.remainingWork.map((r) => `- ${r}`),
    ``,
    ...(input.blockers.length > 0
      ? [`## Blockers`, ...input.blockers.map((b) => `- ${b}`), ``]
      : []),
    `## Recommended next step`,
    `${escaped.recommendedNextStep}`,
    ``,
    `<!-- EMITTED_AT:${new Date().toISOString()} -->`,
  ];

  return lines.join("\n");
}

export function parseHandoffComment(body: string): StructuredHandoff | null {
  if (!body.includes(HANDOFF_COMMENT_PREFIX)) {
    return null;
  }

  const lines = body.split("\n");
  const metadata: Record<string, string> = {};
  const sectionOrder: string[] = [];
  const sections: Record<string, string[]> = {};

  let currentSection: string | null = null;
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Parse SWARM_HANDOFF version line: <!-- SWARM_HANDOFF v1.0 -->
    const versionMatch = line.match(/^<!--\s*SWARM_HANDOFF\s+v([\d.]+)\s*-->$/);
    if (versionMatch) {
      metadata["VERSION"] = versionMatch[1];
      continue;
    }

    // Parse metadata comments: <!-- KEY:value -->
    const metaMatch = line.match(/^<!--\s*([A-Z_]+):(.+)\s*-->$/);
    if (metaMatch) {
      metadata[metaMatch[1]] = metaMatch[2].trim();
      continue;
    }

    // Section headers
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sectionOrder.push(currentSection);
      sections[currentSection] = [];
      inSection = true;
      continue;
    }

    // Content lines
    if (inSection && currentSection) {
      if (line.match(/^<!-- .+ -->$/)) {
        // End marker or other metadata comment
        continue;
      }
      sections[currentSection].push(line);
    }
  }

  // Extract raw section content and unescape
  const getRawSection = (name: string): string =>
    unescapeHandoffValue(sections[name]?.join("\n").trim() ?? "");

  const getListSection = (name: string): string[] => {
    const raw = getRawSection(name);
    return parseHandoffList(raw);
  };

  return {
    version: metadata["VERSION"] ?? "1.0",
    agentId: metadata["AGENT_ID"] ?? "",
    agentName: metadata["AGENT_NAME"] ?? "",
    runId: metadata["RUN_ID"] ?? "",
    issueId: metadata["ISSUE_ID"] || null,
    summary: getRawSection("Summary"),
    filesTouched: getListSection("Files touched"),
    currentState: getRawSection("Current state"),
    remainingWork: getListSection("Remaining work"),
    blockers: getListSection("Blockers"),
    recommendedNextStep: getRawSection("Recommended next step"),
    emittedAt: metadata["EMITTED_AT"] ?? "",
  };
}

export function isHandoffComment(body: string): boolean {
  return body.includes(HANDOFF_COMMENT_PREFIX);
}
