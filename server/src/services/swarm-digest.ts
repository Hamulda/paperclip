// Re-export handoff comments for backward compatibility
export {
  buildHandoffComment,
  parseHandoffComment,
  isHandoffComment,
  HANDOFF_COMMENT_PREFIX,
  HANDOFF_COMMENT_VERSION,
  type StructuredHandoff,
  type VerificationStatus,
} from "./handoff-comments.js";

import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, executionWorkspaces, workspaceRuntimeServices, issues, fileClaims, issueComments } from "@paperclipai/db";
import { and, asc, desc, eq, gte, inArray, ne, sql, lt, isNotNull, or } from "drizzle-orm";
import { asString, parseObject } from "../adapters/utils.js";
import {
  getActiveClaimsForRun,
  listConflicts,
  extractClaimPathsFromIssue,
  DEFAULT_PROTECTED_PATTERNS,
} from "./file-claims.js";
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
  SwarmDigestReviewQueue,
  SwarmDigestCollaborationHint,
  VerificationStatus,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Module-level constants (deduped — previously inlined in every call)
// ---------------------------------------------------------------------------
const MAX_STALE_CLAIMS = 20;
const MAX_DEGRADED_SERVICES = 20;
const MAX_STUCK_RUNS = 20;
const MAX_HANDOFF_COMMENTS = 20;
const MAX_ACTIVE_RUNS = 50;
const MAX_WORKSPACES = 20;
const MAX_SERVICES = 30;
const MAX_AUTO_CLAIM_SUGGESTIONS = 20;
const MAX_AVOID_PATHS = 20;
const MAX_PATHS_PER_AGENT = 50;

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
    autoClaimSuggestions: [],
    protectedPaths: {
      defaultPatterns: DEFAULT_PROTECTED_PATTERNS,
      configurablePatterns: [],
      enforcement: "hard_block",
    },
    reviewQueue: { readyForReview: [], needsVerification: [], blocked: [] },
    collaborationHints: [],
  } as SwarmDigest & { reviewQueue: SwarmDigestReviewQueue; collaborationHints: SwarmDigestCollaborationHint[] };
}

function buildReviewQueue(recentHandoffs: SwarmDigestHandoff[]): SwarmDigestReviewQueue {
  return {
    readyForReview: recentHandoffs.filter((h) => h.verificationStatus === "ready_for_review"),
    needsVerification: recentHandoffs.filter((h) => h.verificationStatus === "needs_verification"),
    blocked: recentHandoffs.filter((h) => h.verificationStatus === "blocked"),
  };
}

function buildCollaborationHints(digest: SwarmDigest): SwarmDigestCollaborationHint[] {
  const hints: SwarmDigestCollaborationHint[] = [];

  // Role coordination hints
  const byAgent = digest.claimedPathsSummary.byAgent;
  const areaAgents = new Map<string, { name: string; role: string | null; paths: string[] }[]>();
  for (const entry of byAgent) {
    const topPath = entry.paths[0] ?? "";
    if (!topPath) continue;
    const areaKey = topPath.split("/")[0] || topPath;
    if (!areaAgents.has(areaKey)) areaAgents.set(areaKey, []);
    areaAgents.get(areaKey)!.push({ name: entry.agentName, role: entry.role, paths: entry.paths });
  }

  for (const [area, agents] of areaAgents) {
    const roles = agents.filter((a) => a.role).map((a) => a.role!);
    const uniqueRoles = [...new Set(roles)];
    if (uniqueRoles.length > 1) {
      const agentNames = agents.map((a) => a.name).join(", ");
      hints.push({
        type: "role_coordination",
        message: `${agentNames} are working on ${area}/ (${uniqueRoles.join(", ")}) — coordinate before merging shared changes`,
        urgency: "medium",
        relatedIssue: agents[0]?.paths[0] ?? null,
      });
    }
  }

  // Review-needed hints
  const readyForReview = digest.recentHandoffs.filter((h) => h.verificationStatus === "ready_for_review");
  for (const h of readyForReview) {
    hints.push({
      type: "review_needed",
      message: `${h.agentName} is ready for review — verify before starting related work`,
      urgency: "high",
      relatedIssue: h.issueIdentifier ?? null,
    });
  }

  // Blocked hints
  const blocked = digest.recentHandoffs.filter((h) => h.verificationStatus === "blocked");
  for (const h of blocked) {
    if (h.blockers.length > 0) {
      hints.push({
        type: "blocked",
        message: `${h.agentName} is blocked on: ${h.blockers.slice(0, 2).join(", ")}`,
        urgency: "high",
        relatedIssue: h.issueIdentifier ?? null,
      });
    }
  }

  // Conflict risk hints
  for (const conflict of digest.fileClaimConflicts.slice(0, 3)) {
    hints.push({
      type: "conflict_risk",
      message: `Path ${conflict.claimPath} has overlapping claims — resolve before merging`,
      urgency: "high",
      relatedIssue: null,
    });
  }

  return hints.slice(0, 8);
}

export async function buildSwarmDigest(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null;
    currentRunId?: string | null;
    currentAgentId?: string | null;
  },
): Promise<SwarmDigest & { reviewQueue: SwarmDigestReviewQueue; collaborationHints: SwarmDigestCollaborationHint[] }> {
  const { companyId, projectId, currentRunId = null, currentAgentId = null } = input;

  if (!companyId) {
    return buildEmptyDigest(companyId, projectId);
  }

  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 1 — Agent lookups (parallel)
  // Two independent queries: running agents + all agents (for name/role maps)
  // ─────────────────────────────────────────────────────────────────────────────
  const [runningAgentsResult, allCompanyAgentsResult] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name, status: agents.status, role: agents.role })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.status, "running"))),
    db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
  ]);

  const activeAgents: SwarmDigestAgent[] = runningAgentsResult.map(
    (row): SwarmDigestAgent => ({
      id: row.id,
      name: row.name,
      status: row.status,
      role: row.role ?? null,
    }),
  );

  const agentNameForLookup = new Map(allCompanyAgentsResult.map((a) => [a.id, a.name]));
  const agentRoleForLookup = new Map(allCompanyAgentsResult.map((a) => [a.id, a.role ?? null]));

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Independent queries that need only companyId + projectId + time
  // - active runs (with JSON filter on projectId)
  // - workspaces
  // - stale claims
  // - stuck runs
  // - handoff comments
  // All fire in parallel; workspaces degraded-services dependency resolved below
  // ─────────────────────────────────────────────────────────────────────────────
  const activeRunConditions = [
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.status, ["running", "queued"]),
  ];
  if (projectId) {
    activeRunConditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'projectId' = ${projectId}`);
  }
  if (currentRunId) {
    activeRunConditions.push(ne(heartbeatRuns.id, currentRunId));
  }

  const [runRows, workspaceRows, staleClaimRows, stuckRunRows, handoffCommentRows] =
    await Promise.all([
      db
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
        .limit(MAX_ACTIVE_RUNS),

      projectId
        ? db
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
            .limit(MAX_WORKSPACES)
        : Promise.resolve([]),

      db
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
            ...(projectId ? [eq(fileClaims.projectId, projectId)] : []),
          ),
        )
        .limit(MAX_STALE_CLAIMS),

      db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          startedAt: heartbeatRuns.startedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "queued"),
            lt(heartbeatRuns.createdAt, fiveMinutesAgo),
            ...(projectId
              ? [sql`${heartbeatRuns.contextSnapshot} ->> 'projectId' = ${projectId}`]
              : []),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(MAX_STUCK_RUNS),

      projectId
        ? db
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
            .limit(MAX_HANDOFF_COMMENTS)
        : db
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
            .limit(MAX_HANDOFF_COMMENTS),
    ]);

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Derive issue IDs from phase-2 results; fire parallel issue fetch
  // Cache parsed contexts to avoid re-parsing them in Phase 6
  // ─────────────────────────────────────────────────────────────────────────────
  const activeIssueIds = new Set<string>();
  const stuckIssueIds = new Set<string>();
  const allHandoffIssueIds = new Set<string>();

  // Parse contexts once and cache for Phase 6 reuse
  const runContextCache = new Map<string, Record<string, unknown>>();
  for (const run of runRows) {
    const context = parseObject(run.contextSnapshot);
    runContextCache.set(run.id, context);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) activeIssueIds.add(issueId);
  }

  const stuckRunContextCache = new Map<string, Record<string, unknown>>();
  for (const run of stuckRunRows) {
    const context = parseObject(run.contextSnapshot);
    stuckRunContextCache.set(run.id, context);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) stuckIssueIds.add(issueId);
  }

  for (const row of handoffCommentRows) {
    if (!isHandoffComment(row.body)) continue;
    const parsed = parseHandoffComment(row.body);
    if (parsed?.issueId) allHandoffIssueIds.add(parsed.issueId);
  }

  // Fire all issue queries in parallel
  const [activeRunsIssueRows, stuckIssueRows, handoffIssueRows] = await Promise.all([
    activeIssueIds.size > 0
      ? db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            labels: issues.labels,
          })
          .from(issues)
          .where(inArray(issues.id, Array.from(activeIssueIds)))
      : Promise.resolve([]),

    stuckIssueIds.size > 0
      ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
          .from(issues)
          .where(inArray(issues.id, Array.from(stuckIssueIds)))
      : Promise.resolve([]),

    allHandoffIssueIds.size > 0
      ? db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(inArray(issues.id, Array.from(allHandoffIssueIds)))
      : Promise.resolve([]),
  ]);

  const issueMap = new Map(
    activeRunsIssueRows.map((i) => [
      i.id,
      { identifier: i.identifier, title: i.title, description: i.description ?? null, labels: i.labels ?? [] },
    ]),
  );
  const stuckIssueMap = new Map(stuckIssueRows.map((i) => [i.id, { identifier: i.identifier, title: i.title }]));
  const handoffIssueMap = new Map(handoffIssueRows.map((i) => [i.id, i.identifier]));

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 4 — Workspace-dependent queries
  // - services (needs activeWorkspaceIds from workspaces)
  // - degraded services (needs activeWorkspaceIds from workspaces)
  // - claimed paths (only used when currentRunId is absent; deferred to Phase 5 otherwise)
  // getActiveClaimsForRun fires here when currentRunId exists (parallel with Phase 4)
  // ─────────────────────────────────────────────────────────────────────────────
  const workspaces: SwarmDigestWorkspace[] = workspaceRows.map(
    (w): SwarmDigestWorkspace => ({
      id: w.id,
      name: w.name,
      branchName: w.branchName,
      worktreePath: w.worktreePath,
      status: w.status,
      sourceIssueId: w.sourceIssueId,
    }),
  );

  const activeWorkspaceIds = workspaces.map((w) => w.id);

  // Fire getActiveClaimsForRun in parallel with Phase 4 when currentRunId exists
  // (claimedPathsResult is only needed when currentRunId is absent)
  const currentClaimsPromise =
    currentRunId ? getActiveClaimsForRun(db, companyId, currentRunId, projectId) : Promise.resolve([]);

  const [serviceRows, degradedServiceRows, claimedPathsResult] = await Promise.all([
    activeWorkspaceIds.length > 0
      ? db
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
          .limit(MAX_SERVICES)
        : Promise.resolve([]),

    db
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
          // Project scoping via workspace IDs when available, else projectId only
          ...(projectId && activeWorkspaceIds.length > 0
            ? [inArray(workspaceRuntimeServices.executionWorkspaceId, activeWorkspaceIds)]
            : projectId
              ? [sql`1 = 0`]
              : []),
        ),
      )
      .limit(MAX_DEGRADED_SERVICES),

    // Only query claimed paths when currentRunId is absent (Phase 5 uses getActiveClaimsForRun otherwise)
    projectId && !currentRunId
      ? db
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
      : Promise.resolve([]),
  ]);

  const services: SwarmDigestService[] = serviceRows.map(
    (s): SwarmDigestService => ({
      id: s.id,
      serviceName: s.serviceName,
      status: s.status,
      url: s.url,
      ownerAgentId: s.ownerAgentId,
    }),
  );

  const servicesDegraded: SwarmDigestServiceDegraded[] = degradedServiceRows.map((s) => ({
    id: s.id,
    serviceName: s.serviceName,
    status: s.status,
    healthStatus: s.healthStatus,
    url: s.url,
    ownerAgentId: s.ownerAgentId,
  }));

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 5 — File claim conflicts (resolves currentClaims from Phase 4 Promise)
  // ─────────────────────────────────────────────────────────────────────────────
  let fileClaimConflicts: SwarmDigestFileClaimConflict[] = [];

  if (currentRunId) {
    const currentClaims = await currentClaimsPromise;
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

      const crossRunConflicts = conflicts.filter((c) => !currentRunIds.includes(c.runId));

      fileClaimConflicts = crossRunConflicts.map(
        (c): SwarmDigestFileClaimConflict => ({
          claimPath: c.claimPath,
          claimType: c.claimType,
          conflictingAgentId: c.conflictingClaims[0]?.agentId ?? "",
          conflictingRunId: c.conflictingClaims[0]?.runId ?? "",
        }),
      );
    }
  } else if (projectId) {
    // Re-use claimedPathsResult from phase 4 (same filter as allProjectClaims query)
    const pathsWithClaims = [...new Set(claimedPathsResult.map((c) => c.claimPath))];

    if (pathsWithClaims.length > 0) {
      const conflicts = await listConflicts(db, {
        companyId,
        projectId,
        paths: pathsWithClaims,
        excludeAgentId: null,
        excludeRunId: null,
      });

      fileClaimConflicts = conflicts.map(
        (c): SwarmDigestFileClaimConflict => ({
          claimPath: c.claimPath,
          claimType: c.claimType,
          conflictingAgentId: c.conflictingClaims[0]?.agentId ?? "",
          conflictingRunId: c.conflictingClaims[0]?.runId ?? "",
        }),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 6 — In-memory assembly (reuses contexts cached in Phase 3)
  // ─────────────────────────────────────────────────────────────────────────────

  // Build activeRuns (reuse context parsed in Phase 3 via runContextCache)
  const activeRuns: SwarmDigestRun[] = runRows
    .map((run): SwarmDigestRun => {
      const context = runContextCache.get(run.id) ?? {};
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
        swarmRole: agentRoleForLookup.get(run.agentId) ?? null,
      };
    })
    .filter((run) => run.agentId !== currentAgentId || run.id !== currentRunId);

  // Build runsStuck (reuse context parsed in Phase 3 via stuckRunContextCache)
  const runsStuck: SwarmDigestRunStuck[] = stuckRunRows.map((run) => {
    const context = stuckRunContextCache.get(run.id) ?? {};
    const issueId = readNonEmptyString(context.issueId) || null;
    const issueInfo = issueId ? stuckIssueMap.get(issueId) : null;
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

  // Build stale claims
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

  // Build recentHandoffs
  const recentHandoffs: SwarmDigestHandoff[] = [];
  for (const row of handoffCommentRows) {
    if (!isHandoffComment(row.body)) continue;
    const parsed = parseHandoffComment(row.body);
    if (!parsed) continue;

    recentHandoffs.push({
      id: row.id,
      agentId: parsed.agentId,
      agentName: parsed.agentName,
      swarmRole: parsed.swarmRole,
      runId: parsed.runId,
      issueId: parsed.issueId,
      issueIdentifier: parsed.issueId ? handoffIssueMap.get(parsed.issueId) ?? null : null,
      summary: parsed.summary,
      filesTouched: parsed.filesTouched,
      currentState: parsed.currentState,
      remainingWork: parsed.remainingWork,
      blockers: parsed.blockers,
      recommendedNextStep: parsed.recommendedNextStep,
      avoidPaths: parsed.avoidPaths,
      emittedAt: parsed.emittedAt,
      verificationStatus: parsed.verificationStatus,
    });
  }

  // Build claimed paths summary (re-use claimedPathsResult from phase 4)
  const claimsByAgent = new Map<string, { paths: Set<string>; issueIds: Set<string> }>();
  for (const claim of claimedPathsResult) {
    if (!claim.agentId) continue;
    if (!claimsByAgent.has(claim.agentId)) {
      claimsByAgent.set(claim.agentId, { paths: new Set(), issueIds: new Set() });
    }
    claimsByAgent.get(claim.agentId)!.paths.add(claim.claimPath);
    if (claim.issueId) {
      claimsByAgent.get(claim.agentId)!.issueIds.add(claim.issueId);
    }
  }

  const claimedPathsIssueIds = new Set<string>();
  for (const agentData of claimsByAgent.values()) {
    for (const issueId of agentData.issueIds) {
      claimedPathsIssueIds.add(issueId);
    }
  }

  const claimedPathsIssueRows =
    claimedPathsIssueIds.size > 0
      ? await db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(inArray(issues.id, Array.from(claimedPathsIssueIds)))
      : [];

  const issueIdToIdentifier = new Map(claimedPathsIssueRows.map((i) => [i.id, i.identifier]));

  const claimedPathsSummary: SwarmDigestClaimedPathsSummary = {
    byAgent: Array.from(claimsByAgent.entries()).map(([agentId, data]) => {
      const issueIdentifiers = Array.from(data.issueIds)
        .map((id) => issueIdToIdentifier.get(id))
        .filter((id): id is string => id !== undefined);
      return {
        agentId,
        agentName: agentNameForLookup.get(agentId) ?? "Unknown",
        role: agentRoleForLookup.get(agentId) ?? null,
        paths: [...data.paths].slice(0, MAX_PATHS_PER_AGENT),
        pathCount: data.paths.size,
        issueIdentifier: issueIdentifiers[0] ?? null,
      };
    }),
  };

  // Build avoid paths
  const avoidPathSet = new Set<string>();
  const avoidPathReasons = new Map<string, string>();

  for (const handoff of recentHandoffs) {
    for (const avoidPath of handoff.avoidPaths) {
      avoidPathSet.add(avoidPath);
      if (!avoidPathReasons.has(avoidPath)) {
        avoidPathReasons.set(avoidPath, `${handoff.agentName} is actively working on this area`);
      }
    }
  }

  const recommendedAvoidPaths: SwarmDigestRecommendedAvoidPaths = {
    paths: Array.from(avoidPathSet).slice(0, MAX_AVOID_PATHS),
    reasons: Array.from(avoidPathReasons.values()).slice(0, MAX_AVOID_PATHS),
  };

  // Auto-claim suggestions
  const autoClaimSuggestions: SwarmDigestAutoClaimSuggestion[] = [];
  const suggestionSeen = new Set<string>();

  for (const run of activeRuns) {
    if (!run.issueId) continue;
    const issue = issueMap.get(run.issueId);
    if (!issue) continue;

    for (const [source, field] of [
      ["issue_description", { description: issue.description }] as const,
      ["issue_labels", { labels: issue.labels as string[] | undefined }] as const,
      ["issue_title", { description: issue.title }] as const,
    ] as const) {
      const claims = extractClaimPathsFromIssue(field);
      for (const claim of claims) {
        const key = `${claim.claimType}:${claim.claimPath}`;
        if (!suggestionSeen.has(key)) {
          suggestionSeen.add(key);
          autoClaimSuggestions.push({
            source,
            path: claim.claimPath,
            claimType: claim.claimType,
            reason: `Suggested by issue ${issue.identifier ?? run.issueId} ${source.replace("issue_", "")}`,
            issueIdentifier: issue.identifier ?? undefined,
          });
        }
      }
    }
  }

  return {
    companyId,
    projectId,
    generatedAt: now.toISOString(),
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
    autoClaimSuggestions: autoClaimSuggestions.slice(0, MAX_AUTO_CLAIM_SUGGESTIONS),
    protectedPaths: {
      defaultPatterns: DEFAULT_PROTECTED_PATTERNS,
      configurablePatterns: [],
      enforcement: "hard_block",
    },
    reviewQueue: buildReviewQueue(recentHandoffs),
    collaborationHints: buildCollaborationHints({
      claimedPathsSummary,
      recentHandoffs,
      fileClaimConflicts,
    } as SwarmDigest),
  };
}

export function formatSwarmDigestForPrompt(digest: SwarmDigest & { collaborationHints?: SwarmDigestCollaborationHint[] }): string {
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

  // Auto-claim suggestions from issue metadata — with practical, actionable reasons
  if (digest.autoClaimSuggestions.length > 0) {
    lines.push("### Auto-Claim Suggestions");
    lines.push("These paths are explicitly claimed by other issues — consider them if your issue touches related areas:");
    for (const suggestion of digest.autoClaimSuggestions.slice(0, 10)) {
      const issueNote = suggestion.issueIdentifier ? ` [${suggestion.issueIdentifier}]` : "";
      const sourceLabel = suggestion.source === "issue_labels" ? "label" : suggestion.source === "issue_title" ? "title" : "description";
      lines.push(`- ${suggestion.path} (${suggestion.claimType})${issueNote}: explicitly claimed in issue ${sourceLabel}`);
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

  // Collaboration hints — actionable, urgency-tagged
  if (digest.collaborationHints && digest.collaborationHints.length > 0) {
    lines.push("### Collaboration Hints");
    for (const hint of digest.collaborationHints) {
      const urgencyMarker = hint.urgency === "high" ? "⚠️ " : hint.urgency === "medium" ? "→ " : "  ";
      lines.push(`${urgencyMarker}${hint.message}`);
    }
    lines.push("");
  }

  // Latest handoff with verification status
  if (digest.latestHandoff) {
    const h = digest.latestHandoff;
    lines.push("### Latest Handoff");
    const statusBadge = h.verificationStatus ? ` [${h.verificationStatus.replace("_", " ")}]` : "";
    const roleNote = h.swarmRole ? ` from ${h.swarmRole}` : "";
    lines.push(`- **${h.agentName}**${roleNote}${statusBadge}: ${h.summary.slice(0, 120)}${h.summary.length > 120 ? "..." : ""}`);
    if (h.recommendedNextStep) {
      lines.push(`  → Next: ${h.recommendedNextStep}`);
    }
    if (h.blockers.length > 0) {
      lines.push(`  ⚠️ Blockers: ${h.blockers.join(", ")}`);
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

  // Protected paths
  const allProtectedPaths = [
    ...(digest.protectedPaths?.defaultPatterns ?? []),
    ...(digest.protectedPaths?.configurablePatterns ?? []),
  ];
  if (allProtectedPaths.length > 0) {
    lines.push("### Protected Paths");
    lines.push(`(${digest.protectedPaths?.enforcement === "hard_block" ? "Hard Block" : "Soft Warning"} — do not modify)`);
    if (digest.protectedPaths?.defaultPatterns?.length) {
      lines.push("Defaults:");
      for (const path of digest.protectedPaths.defaultPatterns.slice(0, 10)) {
        lines.push(`- ${path}`);
      }
    }
    if (digest.protectedPaths?.configurablePatterns?.length) {
      lines.push("Project Config:");
      for (const path of digest.protectedPaths.configurablePatterns.slice(0, 10)) {
        lines.push(`- ${path}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
