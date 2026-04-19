// Re-export handoff comments for backward compatibility
export {
  buildHandoffComment,
  parseHandoffComment,
  isHandoffComment,
  HANDOFF_COMMENT_PREFIX,
  HANDOFF_COMMENT_VERSION,
  type StructuredHandoff,
} from "./handoff-comments.js";

import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, executionWorkspaces, workspaceRuntimeServices, issues, fileClaims, issueComments } from "@paperclipai/db";
import { and, asc, desc, eq, gte, inArray, ne, sql, lt, isNotNull, or } from "drizzle-orm";
import { asString, parseObject } from "../adapters/utils.js";
import { getActiveClaimsForRun, listConflicts } from "./file-claims.js";
import { parseHandoffComment, isHandoffComment, HANDOFF_COMMENT_PREFIX } from "./handoff-comments.js";

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

export interface SwarmDigestFileClaimStale {
  id: string;
  claimPath: string;
  claimType: string;
  agentId: string | null;
  runId: string | null;
  expiresAt: string;
  minutesUntilExpiry: number;
}

export interface SwarmDigestServiceDegraded {
  id: string;
  serviceName: string;
  status: string;
  healthStatus: string;
  url: string | null;
  ownerAgentId: string | null;
}

export interface SwarmDigestRunStuck {
  id: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  startedAt: string | null;
  minutesWaiting: number;
}

export interface SwarmDigestHandoff {
  id: string;
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
  emittedAt: string;
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
  fileClaimStale: SwarmDigestFileClaimStale[];
  servicesDegraded: SwarmDigestServiceDegraded[];
  runsStuck: SwarmDigestRunStuck[];
  recentHandoffs: SwarmDigestHandoff[];
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
    fileClaimStale: [],
    servicesDegraded: [],
    runsStuck: [],
    recentHandoffs: [],
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

  // 1. Active (running) agents in the company
  const activeAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
    })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      eq(agents.status, "running"),
    ))
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

  // Filter by projectId from contextSnapshot when provided
  if (projectId) {
    activeRunConditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'projectId' = ${projectId}`);
  }

  // Filter out the current run itself
  if (currentRunId) {
    activeRunConditions.push(ne(heartbeatRuns.id, currentRunId));
  }

  // Get runs scoped to project via contextSnapshot projectId
  let activeRuns: SwarmDigestRun[] = [];
  if (activeAgents.length > 0) {
    const agentIds = activeAgents.map((a) => a.id);
    activeRunConditions.push(inArray(heartbeatRuns.agentId, agentIds));

    const runRows = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(and(...activeRunConditions))
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

  // 5. File claim conflicts
  // When currentRunId is provided, find conflicts with the current run's claims.
  // Otherwise, find all active conflicts in the project (for overview/diagnostics).
  let fileClaimConflicts: SwarmDigestFileClaimConflict[] = [];

  if (currentRunId) {
    // Current run context: get claims for this run and find what they conflict with
    const currentClaims = await getActiveClaimsForRun(db, companyId, currentRunId, projectId);
    const paths = currentClaims.map((c) => c.claimPath);

    if (paths.length > 0) {
      const currentRunIds = [...new Set(currentClaims.map((c) => c.runId))];

      const conflicts = await listConflicts(db, {
        companyId,
        projectId,
        paths,
        excludeAgentId: currentAgentId,
        excludeRunId: currentRunId,
      });

      // Filter out same-run conflicts
      const crossRunConflicts = conflicts.filter(
        (c) => !currentRunIds.includes(c.runId),
      );

      fileClaimConflicts = crossRunConflicts.map((c): SwarmDigestFileClaimConflict => ({
        claimPath: c.claimPath,
        claimType: c.claimType,
        conflictingAgentId: c.conflictingClaims[0]?.agentId ?? "",
        conflictingRunId: c.conflictingClaims[0]?.runId ?? "",
      }));
    }
  } else if (projectId) {
    // No current run context: show all active conflicts in the project for diagnostics
    // Get all paths with active claims in this project
    const allProjectClaims = await db
      .select({
        id: fileClaims.id,
        claimPath: fileClaims.claimPath,
        claimType: fileClaims.claimType,
        agentId: fileClaims.agentId,
        runId: fileClaims.runId,
      })
      .from(fileClaims)
      .where(
        and(
          eq(fileClaims.companyId, companyId),
          eq(fileClaims.projectId, projectId),
          eq(fileClaims.status, "active"),
          gte(fileClaims.expiresAt, new Date()),
        ),
      );

    // Find all paths that have claims
    const pathsWithClaims = [...new Set(allProjectClaims.map((c) => c.claimPath))];

    if (pathsWithClaims.length > 0) {
      // Get all conflicts for these paths (excluding nothing since no current run)
      const conflicts = await listConflicts(db, {
        companyId,
        projectId,
        paths: pathsWithClaims,
        excludeAgentId: null,
        excludeRunId: null,
      });

      fileClaimConflicts = conflicts.map((c): SwarmDigestFileClaimConflict => ({
        claimPath: c.claimPath,
        claimType: c.claimType,
        conflictingAgentId: c.conflictingClaims[0]?.agentId ?? "",
        conflictingRunId: c.conflictingClaims[0]?.runId ?? "",
      }));
    }
  }

  // 6. Stale/expiring file claims (expiring within 5 minutes or already expired but still marked active)
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  const staleClaimRows = await db
    .select({
      id: fileClaims.id,
      claimPath: fileClaims.claimPath,
      claimType: fileClaims.claimType,
      agentId: fileClaims.agentId,
      runId: fileClaims.runId,
      expiresAt: fileClaims.expiresAt,
    })
    .from(fileClaims)
    .where(
      and(
        eq(fileClaims.companyId, companyId),
        eq(fileClaims.status, "active"),
        lt(fileClaims.expiresAt, fiveMinutesFromNow),
      ),
    )
    .limit(20);

  const fileClaimStale: SwarmDigestFileClaimStale[] = staleClaimRows.map((c) => {
    const expiresAt = c.expiresAt;
    const minutesUntilExpiry = Math.round((expiresAt.getTime() - now.getTime()) / 60000);
    return {
      id: c.id,
      claimPath: c.claimPath,
      claimType: c.claimType,
      agentId: c.agentId,
      runId: c.runId,
      expiresAt: expiresAt.toISOString(),
      minutesUntilExpiry,
    };
  });

  // 7. Failed or degraded runtime services
  const degradedServiceRows = await db
    .select({
      id: workspaceRuntimeServices.id,
      serviceName: workspaceRuntimeServices.serviceName,
      status: workspaceRuntimeServices.status,
      healthStatus: workspaceRuntimeServices.healthStatus,
      url: workspaceRuntimeServices.url,
      ownerAgentId: workspaceRuntimeServices.ownerAgentId,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        or(
          eq(workspaceRuntimeServices.healthStatus, "degraded"),
          eq(workspaceRuntimeServices.healthStatus, "unhealthy"),
          eq(workspaceRuntimeServices.status, "stopped"),
          eq(workspaceRuntimeServices.status, "failed"),
        ),
      ),
    )
    .limit(20);

  const servicesDegraded: SwarmDigestServiceDegraded[] = degradedServiceRows.map((s) => ({
    id: s.id,
    serviceName: s.serviceName,
    status: s.status,
    healthStatus: s.healthStatus,
    url: s.url,
    ownerAgentId: s.ownerAgentId,
  }));

  // 8. Stuck runs (queued for more than 5 minutes)
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const stuckRunRows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "queued"),
        isNotNull(heartbeatRuns.startedAt),
        lt(heartbeatRuns.startedAt, fiveMinutesAgo),
      ),
    )
    .orderBy(asc(heartbeatRuns.startedAt))
    .limit(20);

  // Extract issue IDs from stuck runs
  const stuckIssueIds = new Set<string>();
  for (const run of stuckRunRows) {
    const context = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) stuckIssueIds.add(issueId);
  }

  const stuckIssueRows = stuckIssueIds.size > 0
    ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, Array.from(stuckIssueIds)))
    : [];
  const stuckIssueMap = new Map(stuckIssueRows.map((i) => [i.id, { identifier: i.identifier, title: i.title }]));

  const runsStuck: SwarmDigestRunStuck[] = stuckRunRows.map((run) => {
    const context = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId) || null;
    const issueInfo = issueId ? stuckIssueMap.get(issueId) : null;
    const minutesWaiting = run.startedAt
      ? Math.round((now.getTime() - run.startedAt.getTime()) / 60000)
      : 0;
    return {
      id: run.id,
      agentId: run.agentId,
      issueId,
      issueIdentifier: issueInfo?.identifier ?? null,
      issueTitle: issueInfo?.title ?? null,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      minutesWaiting,
    };
  });

  // 9. Recent handoff comments (last 30 minutes)
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  const handoffCommentRows = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      authorAgentId: issueComments.authorAgentId,
      createdByRunId: issueComments.createdByRunId,
      issueId: issueComments.issueId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        gte(issueComments.createdAt, thirtyMinutesAgo),
        isNotNull(issueComments.authorAgentId),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(20);

  // Filter to only handoff comments and parse them
  const recentHandoffs: SwarmDigestHandoff[] = [];
  for (const row of handoffCommentRows) {
    if (!isHandoffComment(row.body)) continue;

    const parsed = parseHandoffComment(row.body);
    if (!parsed) continue;

    // Get issue identifier if we have issueId
    let issueIdentifier: string | null = null;
    if (parsed.issueId) {
      const issueRows = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, parsed.issueId))
        .limit(1);
      issueIdentifier = issueRows[0]?.identifier ?? null;
    }

    recentHandoffs.push({
      id: row.id,
      agentId: parsed.agentId,
      agentName: parsed.agentName,
      runId: parsed.runId,
      issueId: parsed.issueId,
      issueIdentifier,
      summary: parsed.summary,
      filesTouched: parsed.filesTouched,
      currentState: parsed.currentState,
      remainingWork: parsed.remainingWork,
      blockers: parsed.blockers,
      recommendedNextStep: parsed.recommendedNextStep,
      emittedAt: parsed.emittedAt,
    });
  }

  return {
    companyId,
    projectId,
    generatedAt: new Date().toISOString(),
    activeAgents,
    activeRuns,
    workspaces,
    services,
    fileClaimConflicts,
    fileClaimStale,
    servicesDegraded,
    runsStuck,
    recentHandoffs,
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
