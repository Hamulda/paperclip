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
import type {
  SwarmDigest,
  SwarmDigestAgent,
  SwarmDigestRun,
  SwarmDigestWorkspace,
  SwarmDigestService,
  SwarmDigestFileClaimConflict,
  SwarmDigestFileClaimStale,
  SwarmDigestServiceDegraded,
  SwarmDigestRunStuck,
  SwarmDigestHandoff,
  SwarmDigestClaimedPathsSummary,
  SwarmDigestRecommendedAvoidPaths,
} from "@paperclipai/shared";

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
    latestHandoff: null,
    claimedPathsSummary: { byAgent: [] },
    recommendedAvoidPaths: { paths: [], reasons: [] },
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
      role: agents.role,
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
        role: row.role ?? null,
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
        const swarmRole = activeAgents.find((a) => a.id === run.agentId)?.role ?? null;
        return {
          id: run.id,
          agentId: run.agentId,
          issueId,
          issueIdentifier: issueInfo?.identifier ?? null,
          issueTitle: issueInfo?.title ?? null,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          swarmRole,
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
      swarmRole: parsed.swarmRole,
      runId: parsed.runId,
      issueId: parsed.issueId,
      issueIdentifier,
      summary: parsed.summary,
      filesTouched: parsed.filesTouched,
      currentState: parsed.currentState,
      remainingWork: parsed.remainingWork,
      blockers: parsed.blockers,
      recommendedNextStep: parsed.recommendedNextStep,
      avoidPaths: parsed.avoidPaths,
      emittedAt: parsed.emittedAt,
    });
  }

  // 10. Build claimed paths summary (aggregate active claims by agent)
  const allActiveClaims = projectId
    ? await db
        .select({
          claimPath: fileClaims.claimPath,
          claimType: fileClaims.claimType,
          agentId: fileClaims.agentId,
          issueId: fileClaims.issueId,
        })
        .from(fileClaims)
        .where(
          and(
            eq(fileClaims.companyId, companyId),
            eq(fileClaims.projectId, projectId),
            eq(fileClaims.status, "active"),
            gte(fileClaims.expiresAt, new Date()),
          ),
        )
    : [];

  // Build agent name map from activeAgents
  const agentNameMap = new Map(activeAgents.map((a) => [a.id, a.name]));
  const agentRoleMap = new Map(activeAgents.map((a) => [a.id, a.role]));

  // Group claims by agent (filter out claims with null agentId)
  const claimsByAgent = new Map<string, string[]>();
  for (const claim of allActiveClaims) {
    if (!claim.agentId) continue;
    if (!claimsByAgent.has(claim.agentId)) {
      claimsByAgent.set(claim.agentId, []);
    }
    claimsByAgent.get(claim.agentId)!.push(claim.claimPath);
  }

  const claimedPathsSummary: SwarmDigestClaimedPathsSummary = {
    byAgent: Array.from(claimsByAgent.entries()).map(([agentId, paths]) => ({
      agentId,
      agentName: agentNameMap.get(agentId) ?? "Unknown",
      role: agentRoleMap.get(agentId) ?? null,
      paths: [...new Set(paths)].slice(0, 50), // dedupe and limit
    })),
  };

  // 11. Build recommended avoid paths from recent handoffs
  const avoidPathSet = new Set<string>();
  const avoidPathReasons = new Map<string, string>();

  for (const handoff of recentHandoffs) {
    for (const avoidPath of handoff.avoidPaths) {
      avoidPathSet.add(avoidPath);
      const reason = `${handoff.agentName} is actively working on this area`;
      if (!avoidPathReasons.has(avoidPath)) {
        avoidPathReasons.set(avoidPath, reason);
      }
    }
  }

  const recommendedAvoidPaths: SwarmDigestRecommendedAvoidPaths = {
    paths: Array.from(avoidPathSet).slice(0, 20),
    reasons: Array.from(avoidPathReasons.values()).slice(0, 20),
  };

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
    latestHandoff: recentHandoffs[0] ?? null,
    claimedPathsSummary,
    recommendedAvoidPaths,
  };
}

export function formatSwarmDigestForPrompt(digest: SwarmDigest): string {
  const lines: string[] = [];

  lines.push("## Coding Swarm Status");
  lines.push("");

  // Active agents with roles
  if (digest.activeAgents.length > 0) {
    const otherAgents = digest.activeAgents.filter((a) => a.status === "running");
    if (otherAgents.length > 0) {
      lines.push("### Active Agents");
      for (const agent of otherAgents) {
        const roleTag = agent.role ? ` [${agent.role}]` : "";
        lines.push(`- **${agent.name}**${roleTag} (${agent.status})`);
      }
      lines.push("");
    }
  }

  // Claimed paths summary
  if (digest.claimedPathsSummary.byAgent.length > 0) {
    lines.push("### Claimed Paths");
    for (const agentEntry of digest.claimedPathsSummary.byAgent.slice(0, 5)) {
      const roleTag = agentEntry.role ? ` [${agentEntry.role}]` : "";
      lines.push(`- **${agentEntry.agentName}**${roleTag}:`);
      for (const path of agentEntry.paths.slice(0, 5)) {
        lines.push(`  - ${path}`);
      }
    }
    lines.push("");
  }

  // Recommended avoid paths
  if (digest.recommendedAvoidPaths.paths.length > 0) {
    lines.push("### Recommended Avoid Paths");
    lines.push("Do NOT modify these paths — another agent is actively working on them:");
    for (const path of digest.recommendedAvoidPaths.paths.slice(0, 10)) {
      lines.push(`- ${path}`);
    }
    lines.push("");
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
