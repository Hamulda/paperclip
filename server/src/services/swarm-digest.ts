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
import { getActiveClaimsForRun, listConflicts, extractClaimPathsFromIssue, extractClaimPathsFromDiff } from "./file-claims.js";
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
  SwarmDigestAutoClaimSuggestion,
  SwarmDigestProtectedPaths,
} from "@paperclipai/shared";

function readNonEmptyString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim() || "";
}

function buildEmptyDigest(companyId: string, projectId: string | null): SwarmDigest {
  const commonlyProtectedPatterns = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".git/**",
    ".github/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    ".next/**",
    "tsconfig*.json",
    "jest.config.*",
    "vitest.config.*",
    "*.test.ts",
    "*.spec.ts",
    "*.stories.tsx",
    "*.md",
  ];
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
    autoClaimSuggestions: [],
    protectedPaths: { paths: commonlyProtectedPatterns, enforcedBy: "server" },
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

  // 1. Active (running) agents in the company — kept separate for display purposes
  const runningAgents = await db
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

  // 1b. All company agents (any status) for name/role lookups used by runs and claimed paths
  // This ensures queued runs and claims from non-running agents still have valid name/role
  const allCompanyAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const agentNameForLookup = new Map(allCompanyAgents.map((a) => [a.id, a.name]));
  const agentRoleForLookup = new Map(allCompanyAgents.map((a) => [a.id, a.role ?? null]));

  // activeAgents is running-only for display
  const activeAgents = runningAgents;

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

  // Get all runs (running or queued) for the company/project
  // Not gated on activeAgents so queued runs from idle agents are included
  let activeRuns: SwarmDigestRun[] = [];
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

  // (activeRuns initialized as empty array above, mapped below after issue fetching)
  if (runRows.length > 0) {
    // Extract issue info from contextSnapshot
    const issueIds = new Set<string>();
    for (const run of runRows) {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId) issueIds.add(issueId);
    }

  // Batch fetch ALL issue fields needed for auto-claim extraction (labels, description, identifier, title)
  const activeRunsIssueRows = issueIds.size > 0
    ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description, labels: issues.labels })
        .from(issues)
        .where(inArray(issues.id, Array.from(issueIds)))
    : [];
  const issueMap = new Map(activeRunsIssueRows.map((i) => [i.id, { identifier: i.identifier, title: i.title, description: i.description ?? null, labels: i.labels ?? [] }]));

  activeRuns = runRows
    .map((run): SwarmDigestRun => {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId) || null;
      const issueInfo = issueId ? issueMap.get(issueId) : null;
      const swarmRole = agentRoleForLookup.get(run.agentId) ?? null;
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

  const staleClaimConditions = [
    eq(fileClaims.companyId, companyId),
    eq(fileClaims.status, "active"),
    lt(fileClaims.expiresAt, fiveMinutesFromNow),
  ];
  if (projectId) {
    staleClaimConditions.push(eq(fileClaims.projectId, projectId));
  }

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
    .where(and(...staleClaimConditions))
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
  // Scope to project's workspaces when projectId is provided (via executionWorkspaceId join)
  const degradedServiceConditions = [
    eq(workspaceRuntimeServices.companyId, companyId),
    or(
      eq(workspaceRuntimeServices.healthStatus, "degraded"),
      eq(workspaceRuntimeServices.healthStatus, "unhealthy"),
      eq(workspaceRuntimeServices.status, "stopped"),
      eq(workspaceRuntimeServices.status, "failed"),
    ),
  ];
  if (projectId && activeWorkspaceIds.length > 0) {
    degradedServiceConditions.push(inArray(workspaceRuntimeServices.executionWorkspaceId, activeWorkspaceIds));
  } else if (projectId && activeWorkspaceIds.length === 0) {
    // No active workspaces in this project — degraded services list will be empty
    degradedServiceConditions.push(sql`1 = 0`);
  }

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
    .where(and(...degradedServiceConditions))
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
  // For queued runs, we use createdAt (when the run was queued) rather than startedAt
  // (which is only set when a run transitions from queued to running via claimQueuedRun).
  // A truly stuck queued run will have createdAt set but startedAt = NULL.
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  // Get all stuck runs scoped to projectId when provided
  const stuckRunConditions = [
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.status, "queued"),
    lt(heartbeatRuns.createdAt, fiveMinutesAgo),
  ];
  if (projectId) {
    stuckRunConditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'projectId' = ${projectId}`);
  }

  const stuckRunRows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      status: heartbeatRuns.status,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(and(...stuckRunConditions))
    .orderBy(asc(heartbeatRuns.createdAt))
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
    // Use createdAt for minutesWaiting since it represents when the run was queued
    const minutesWaiting = run.createdAt
      ? Math.round((now.getTime() - run.createdAt.getTime()) / 60000)
      : 0;
    return {
      id: run.id,
      agentId: run.agentId,
      issueId,
      issueIdentifier: issueInfo?.identifier ?? null,
      issueTitle: issueInfo?.title ?? null,
      status: run.status,
      createdAt: run.createdAt?.toISOString() ?? null,
      startedAt: run.startedAt?.toISOString() ?? null,
      minutesWaiting,
    };
  });

  // 9. Recent handoff comments (last 30 minutes)
  // When projectId is provided, scope to that project via the issueComments → issues join.
  // Backward compatible: without projectId, returns all company-scoped handoffs.
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  const handoffCommentRows = projectId
    ? await db
        .select({
          id: issueComments.id,
          body: issueComments.body,
          authorAgentId: issueComments.authorAgentId,
          createdByRunId: issueComments.createdByRunId,
          issueId: issueComments.issueId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .innerJoin(issues, eq(issueComments.issueId, issues.id))
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issues.projectId, projectId),
            gte(issueComments.createdAt, thirtyMinutesAgo),
            isNotNull(issueComments.authorAgentId),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(20)
    : await db
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

  // Batch-fetch all issue identifiers upfront to avoid N+1 queries
  const allHandoffIssueIds = new Set<string>();
  for (const row of handoffCommentRows) {
    if (!isHandoffComment(row.body)) continue;
    const parsed = parseHandoffComment(row.body);
    if (parsed?.issueId) allHandoffIssueIds.add(parsed.issueId);
  }

  const handoffIssueRows = allHandoffIssueIds.size > 0
    ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(inArray(issues.id, Array.from(allHandoffIssueIds)))
    : [];
  const handoffIssueMap = new Map(handoffIssueRows.map((i) => [i.id, i.identifier]));

  for (const row of handoffCommentRows) {
    if (!isHandoffComment(row.body)) continue;

    const parsed = parseHandoffComment(row.body);
    if (!parsed) continue;

    const issueIdentifier = parsed.issueId ? handoffIssueMap.get(parsed.issueId) ?? null : null;

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

  // Build agent name map from all company agents (not just running)
  // so claims from non-running agents still show valid name/role

  // Group claims by agent (filter out claims with null agentId)
  // Also track the most common issueId per agent for richer context
  const claimsByAgent = new Map<string, { paths: Set<string>; issueIds: Set<string> }>();
  for (const claim of allActiveClaims) {
    if (!claim.agentId) continue;
    if (!claimsByAgent.has(claim.agentId)) {
      claimsByAgent.set(claim.agentId, { paths: new Set(), issueIds: new Set() });
    }
    claimsByAgent.get(claim.agentId)!.paths.add(claim.claimPath);
    if (claim.issueId) {
      claimsByAgent.get(claim.agentId)!.issueIds.add(claim.issueId);
    }
  }

  // Get issue identifiers for agents' common issues
  const allIssueIds = new Set<string>();
  for (const agentData of claimsByAgent.values()) {
    for (const issueId of agentData.issueIds) {
      allIssueIds.add(issueId);
    }
  }
  const claimedPathsIssueRows = allIssueIds.size > 0
    ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(inArray(issues.id, Array.from(allIssueIds)))
    : [];
  const issueIdToIdentifier = new Map(claimedPathsIssueRows.map((i) => [i.id, i.identifier]));

  const claimedPathsSummary: SwarmDigestClaimedPathsSummary = {
    byAgent: Array.from(claimsByAgent.entries()).map(([agentId, data]) => {
      // Find the most common issue identifier for this agent
      const issueIdentifiers = Array.from(data.issueIds)
        .map((id) => issueIdToIdentifier.get(id))
        .filter((id): id is string => id !== undefined);
      const commonIssue: string | null = issueIdentifiers.length > 0 ? issueIdentifiers[0] : null;
      return {
        agentId,
        agentName: agentNameForLookup.get(agentId) ?? "Unknown",
        role: agentRoleForLookup.get(agentId) ?? null,
        paths: [...data.paths].slice(0, 50), // dedupe and limit
        pathCount: data.paths.size,
        issueIdentifier: commonIssue,
      };
    }),
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

  // 12. Protected paths (hard-block rules) - commonly protected patterns for display
  const commonlyProtectedPatterns = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".git/**",
    ".github/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    ".next/**",
    "tsconfig*.json",
    "jest.config.*",
    "vitest.config.*",
    "*.test.ts",
    "*.spec.ts",
    "*.stories.tsx",
    "*.md",
  ];
  const protectedPaths: SwarmDigestProtectedPaths = {
    paths: commonlyProtectedPatterns,
    enforcedBy: "server",
  };

  // 13. Auto-claim suggestions — single pass over activeRuns using pre-fetched issue data (no N+1)
  const autoClaimSuggestions: SwarmDigestAutoClaimSuggestion[] = [];
  const suggestionSeen = new Set<string>();

  for (const run of activeRuns) {
    if (!run.issueId) continue;

    const issue = issueMap.get(run.issueId);
    if (!issue) continue;

    // Extract from issue description lines
    const descriptionClaims = extractClaimPathsFromIssue({ description: issue.description });
    for (const claim of descriptionClaims) {
      const key = `${claim.claimType}:${claim.claimPath}`;
      if (!suggestionSeen.has(key)) {
        suggestionSeen.add(key);
        autoClaimSuggestions.push({
          source: "issue_description",
          path: claim.claimPath,
          claimType: claim.claimType,
          reason: `Suggested by issue ${issue.identifier ?? run.issueId} description`,
          issueIdentifier: issue.identifier ?? undefined,
        });
      }
    }

    // Extract from issue labels
    const labelClaims = extractClaimPathsFromIssue({ labels: issue.labels as string[] | undefined });
    for (const claim of labelClaims) {
      const key = `${claim.claimType}:${claim.claimPath}`;
      if (!suggestionSeen.has(key)) {
        suggestionSeen.add(key);
        autoClaimSuggestions.push({
          source: "issue_labels",
          path: claim.claimPath,
          claimType: claim.claimType,
          reason: `Suggested by issue ${issue.identifier ?? run.issueId} label`,
          issueIdentifier: issue.identifier ?? undefined,
        });
      }
    }

    // Extract from issue title (heuristic — extract potential paths from CamelCase/paths)
    const titleClaims = extractClaimPathsFromIssue({ description: issue.title });
    for (const claim of titleClaims) {
      const key = `${claim.claimType}:${claim.claimPath}`;
      if (!suggestionSeen.has(key)) {
        suggestionSeen.add(key);
        autoClaimSuggestions.push({
          source: "issue_description",
          path: claim.claimPath,
          claimType: claim.claimType,
          reason: `Suggested by issue ${issue.identifier ?? run.issueId} title`,
          issueIdentifier: issue.identifier ?? undefined,
        });
      }
    }
  }

  // Deduplicate and cap to 20 for prompt-friendliness
  const dedupedSuggestions = autoClaimSuggestions.slice(0, 20);

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
    autoClaimSuggestions: dedupedSuggestions,
    protectedPaths,
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
      const issueTag = agentEntry.issueIdentifier ? ` [${agentEntry.issueIdentifier}]` : "";
      const countTag = agentEntry.pathCount > 5 ? ` (${agentEntry.pathCount} paths)` : "";
      lines.push(`- **${agentEntry.agentName}**${roleTag}${issueTag}${countTag}:`);
      for (const path of agentEntry.paths.slice(0, 5)) {
        lines.push(`  - ${path}`);
      }
    }
    lines.push("");
  }

  // Auto-claim suggestions from issue metadata
  if (digest.autoClaimSuggestions.length > 0) {
    lines.push("### Auto-Claim Suggestions");
    lines.push("Based on issue metadata, these paths may be relevant:");
    for (const suggestion of digest.autoClaimSuggestions.slice(0, 10)) {
      const issueNote = suggestion.issueIdentifier ? ` [${suggestion.issueIdentifier}]` : "";
      lines.push(`- ${suggestion.path} (${suggestion.claimType})${issueNote}: ${suggestion.reason}`);
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

  // Protected paths (hard-block rules)
  if (digest.protectedPaths?.paths?.length > 0) {
    lines.push("### Protected Paths (Hard Blocks)");
    lines.push("These paths CANNOT be claimed — do not modify them:");
    for (const path of digest.protectedPaths.paths.slice(0, 15)) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
