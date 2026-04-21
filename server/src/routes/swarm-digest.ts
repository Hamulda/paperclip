import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueArtifacts } from "@paperclipai/db";
import { buildSwarmDigest } from "../services/swarm-digest.js";
import { countRunningHotCodingRuns, getEffectiveHotCodingCapacity, SESSIONED_LOCAL_ADAPTERS } from "../services/hot-run-governor.js";
import { assertCompanyAccess } from "./authz.js";
import type { SwarmCockpitDigest, SwarmDigestArtifact } from "@paperclipai/shared";

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
        };
      });
    } catch {
      recentArtifacts = [];
    }

    const cockpitDigest: SwarmCockpitDigest = {
      ...digest,
      hotSlotUsage: {
        current: hotSlotCurrent,
        max: hotSlotMax,
      },
      queuedHotRunsCount: Number(queuedCount ?? 0),
      recentArtifacts,
    };

    res.json(cockpitDigest);
  });

  return router;
}
