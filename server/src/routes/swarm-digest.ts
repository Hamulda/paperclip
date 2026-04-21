import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueArtifacts, issues } from "@paperclipai/db";
import { buildSwarmDigest } from "../services/swarm-digest.js";
import { countRunningHotCodingRuns, getEffectiveHotCodingCapacity, SESSIONED_LOCAL_ADAPTERS } from "../services/hot-run-governor.js";
import { assertCompanyAccess } from "./authz.js";
import type { SwarmCockpitDigest, SwarmDigestArtifact, SwarmDigestIssueSummary } from "@paperclipai/shared";

export function swarmDigestRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/swarm-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = (req.query.projectId as string) || null;

    const digest = await buildSwarmDigest(db, {
      companyId,
      projectId,
    });

    const [hotSlotCurrent, hotSlotMax] = await Promise.all([
      countRunningHotCodingRuns(db, companyId, projectId ?? undefined),
      getEffectiveHotCodingCapacity(db, companyId, projectId ?? undefined),
    ]);

    const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
    const queuedConditions = [
      eq(heartbeatRuns.status, "queued"),
      eq(agents.companyId, companyId),
      hotCodingTypes.length > 0 ? inArray(agents.adapterType, hotCodingTypes) : eq(agents.id, agents.id),
    ];
    if (projectId) {
      queuedConditions.push(sql`${heartbeatRuns.contextSnapshot}->>'projectId' = ${projectId}` as any);
    }
    const [{ count: queuedCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(...queuedConditions));

    // Fetch recent published artifacts for the digest (graceful degradation for test mocks)
    let recentArtifacts: SwarmDigestArtifact[] = [];
    try {
      const artifactRows = await db
        .select({
          id: issueArtifacts.id,
          artifactType: issueArtifacts.artifactType,
          status: issueArtifacts.status,
          summary: issueArtifacts.summary,
          actorAgentId: issueArtifacts.actorAgentId,
          createdAt: issueArtifacts.createdAt,
          metadata: issueArtifacts.metadata,
          revisionCount: issueArtifacts.revisionCount,
          issueId: issueArtifacts.issueId,
        })
        .from(issueArtifacts)
        .where(
          projectId
            ? and(
                eq(issueArtifacts.companyId, companyId),
                eq(issueArtifacts.status, "published"),
                sql`exists (select 1 from issues where issues.id = issue_artifacts.issue_id and issues.project_id = ${projectId})`,
              )
            : and(
                eq(issueArtifacts.companyId, companyId),
                eq(issueArtifacts.status, "published"),
              ),
        )
        .orderBy(desc(issueArtifacts.createdAt))
        .limit(20);

      const artifactAgentIds = [...new Set(artifactRows.map((r) => r.actorAgentId).filter(Boolean))] as string[];
      const agentRows = artifactAgentIds.length > 0
        ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, artifactAgentIds))
        : [];
      const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

      recentArtifacts = artifactRows.map((row) => {
        const meta = row.metadata as Record<string, unknown> | null;
        return {
          id: row.id,
          artifactType: row.artifactType,
          status: row.status,
          summary: row.summary,
          actorAgentId: row.actorAgentId,
          actorAgentName: row.actorAgentId ? agentNameMap.get(row.actorAgentId) ?? null : null,
          createdAt: row.createdAt.toISOString(),
          goal: meta && typeof meta === "object" && "goal" in meta ? (meta.goal as string | null) : null,
          verdict: meta && typeof meta === "object" && "verdict" in meta ? (meta.verdict as string | null) : null,
          filesChanged: meta && typeof meta === "object" && "filesChanged" in meta ? (meta.filesChanged as string[] | null) : null,
          verificationStatus: meta && typeof meta === "object" && "verificationStatus" in meta ? (meta.verificationStatus as string | null) : null,
          mergeReadiness: meta && typeof meta === "object" && "mergeReadiness" in meta ? (meta.mergeReadiness as string | null) : null,
          revisionCount: row.revisionCount,
          issueId: row.issueId,
        };
      });
    } catch {
      recentArtifacts = [];
    }

    // Build per-issue workflow summary
    let issueWorkflowSummary: SwarmDigestIssueSummary[] = [];
    try {
      // Gather all issue IDs referenced by active runs and recent artifacts
      const activeIssueIds = new Set<string>();
      for (const run of digest.activeRuns) {
        if (run.issueId) activeIssueIds.add(run.issueId);
      }
      for (const artifact of recentArtifacts) {
        if (artifact.issueId) activeIssueIds.add(artifact.issueId);
      }

      // Fetch issues with assignee + phase info for active runs
      const targetIssueIds = [...activeIssueIds];
      if (targetIssueIds.length === 0) {
        issueWorkflowSummary = [];
      } else {
        // Fetch assignee names and phase for each issue
        const issueRows = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            phase: issues.phase,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(inArray(issues.id, targetIssueIds));

        const assigneeAgentIds = [...new Set(issueRows.map((r) => r.assigneeAgentId).filter(Boolean))] as string[];
        const assigneeAgents = assigneeAgentIds.length > 0
          ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, assigneeAgentIds))
          : [];
        const agentNameMap2 = new Map(assigneeAgents.map((a) => [a.id, a.name]));

        // Fetch artifact counts per issue (revisionCount as rework signal, artifact chain depth)
        const artifactCountRows = await db
          .select({
            issueId: issueArtifacts.issueId,
            artifactType: issueArtifacts.artifactType,
            revisionCount: issueArtifacts.revisionCount,
            status: issueArtifacts.status,
          })
          .from(issueArtifacts)
          .where(
            and(
              eq(issueArtifacts.companyId, companyId),
              inArray(issueArtifacts.issueId, targetIssueIds),
            ),
          );

        // Group artifacts by issueId
        const artifactsByIssue = new Map<string, { revisionCount: number; artifactTypes: string[] }>();
        for (const row of artifactCountRows) {
          if (!artifactsByIssue.has(row.issueId)) {
            artifactsByIssue.set(row.issueId, { revisionCount: 0, artifactTypes: [] });
          }
          const entry = artifactsByIssue.get(row.issueId)!;
          if (row.status === "published") {
            entry.revisionCount = Math.max(entry.revisionCount, row.revisionCount);
            if (!entry.artifactTypes.includes(row.artifactType)) {
              entry.artifactTypes.push(row.artifactType);
            }
          }
        }

        // Compute rework count per issue: count of artifacts with revisionCount >= 2 for same phase
        const reworkRows = await db
          .select({
            issueId: issueArtifacts.issueId,
            artifactType: issueArtifacts.artifactType,
            revisionCount: issueArtifacts.revisionCount,
          })
          .from(issueArtifacts)
          .where(
            and(
              eq(issueArtifacts.companyId, companyId),
              inArray(issueArtifacts.issueId, targetIssueIds),
              sql`${issueArtifacts.revisionCount} >= 2`,
            ),
          );

        const reworkByIssue = new Map<string, number>();
        for (const row of reworkRows) {
          const current = reworkByIssue.get(row.issueId) ?? 0;
          reworkByIssue.set(row.issueId, current + 1);
        }

        issueWorkflowSummary = issueRows.map((row) => {
          const assigneeName = row.assigneeAgentId ? agentNameMap2.get(row.assigneeAgentId) ?? null : null;
          const artifactInfo = artifactsByIssue.get(row.id) ?? { revisionCount: 0, artifactTypes: [] };
          const reworkCount = reworkByIssue.get(row.id) ?? 0;
          const blockedReason = row.phase === "blocked" ? (artifactInfo.artifactTypes.length > 0 ? "Artifact produced — awaiting review" : "Blocked awaiting initial artifact") : null;
          const { expectedNextRole, expectedNextPhase } = deriveExpectedNext(row.phase, artifactInfo.artifactTypes);

          return {
            issueId: row.id,
            issueIdentifier: row.identifier,
            issueTitle: row.title,
            phase: row.phase,
            assigneeAgentName: assigneeName,
            isRework: artifactInfo.revisionCount >= 2,
            reworkCount,
            blockedReason,
            expectedNextRole,
            expectedNextPhase,
            artifactChain: artifactInfo.artifactTypes,
          } satisfies SwarmDigestIssueSummary;
        });
      }
    } catch {
      issueWorkflowSummary = [];
    }

    const cockpitDigest: SwarmCockpitDigest = {
      ...digest,
      hotSlotUsage: {
        current: hotSlotCurrent,
        max: hotSlotMax,
      },
      queuedHotRunsCount: Number(queuedCount ?? 0),
      recentArtifacts,
      issueWorkflowSummary,
    };

    res.json(cockpitDigest);
  });

  return router;
}

/** Derives the expected next role and phase based on current phase and artifact chain */
function deriveExpectedNext(
  currentPhase: string | null,
  artifactChain: string[],
): { expectedNextRole: string | null; expectedNextPhase: string | null } {
  if (!currentPhase) return { expectedNextRole: null, expectedNextPhase: null };

  const phaseFlow: Record<string, { nextRole: string | null; nextPhase: string | null }> = {
    triage: { nextRole: "planner", nextPhase: "planning" },
    planning: { nextRole: "plan_reviewer", nextPhase: "plan_review" },
    plan_review: { nextRole: "executor", nextPhase: "ready_for_execution" },
    ready_for_execution: { nextRole: "executor", nextPhase: "executing" },
    executing: { nextRole: "reviewer", nextPhase: "code_review" },
    code_review: { nextRole: "integrator", nextPhase: "integration" },
    integration: { nextRole: "merger", nextPhase: "done" },
    blocked: { nextRole: null, nextPhase: null },
    done: { nextRole: null, nextPhase: null },
  };

  const entry = phaseFlow[currentPhase];
  if (!entry || entry.nextRole === null) return { expectedNextRole: null, expectedNextPhase: null };

  // If the expected artifact type is already in the chain, the next step is already done
  const artifactForRole: Record<string, string> = {
    planner: "planner",
    plan_reviewer: "plan_reviewer",
    executor: "executor",
    reviewer: "reviewer",
    integrator: "executor",
    merger: "reviewer",
  };
  const expectedArtifact = artifactForRole[entry.nextRole];
  if (expectedArtifact && artifactChain.includes(expectedArtifact)) {
    return { expectedNextRole: null, expectedNextPhase: null };
  }

  return { expectedNextRole: entry.nextRole, expectedNextPhase: entry.nextPhase };
}
