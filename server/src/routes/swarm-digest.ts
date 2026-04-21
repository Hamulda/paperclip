import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { buildSwarmDigest } from "../services/swarm-digest.js";
import { countRunningHotCodingRuns, getEffectiveHotCodingCapacity, SESSIONED_LOCAL_ADAPTERS } from "../services/hot-run-governor.js";
import { assertCompanyAccess } from "./authz.js";
import type { SwarmCockpitDigest } from "@paperclipai/shared";

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

    const cockpitDigest: SwarmCockpitDigest = {
      ...digest,
      hotSlotUsage: {
        current: hotSlotCurrent,
        max: hotSlotMax,
      },
      queuedHotRunsCount: Number(queuedCount ?? 0),
    };

    res.json(cockpitDigest);
  });

  return router;
}
