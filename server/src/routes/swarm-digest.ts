import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { buildSwarmDigest, type SwarmDigest } from "../services/swarm-digest.js";
import { countRunningHotCodingRuns, SESSIONED_LOCAL_ADAPTERS } from "../services/hot-run-governor.js";
import { assertCompanyAccess } from "./authz.js";

export interface SwarmCockpitDigest extends SwarmDigest {
  hotSlotUsage: {
    current: number;
    maxPerAgent: number;
  };
  queuedHotRunsCount: number;
}

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

    const hotSlotCurrent = await countRunningHotCodingRuns(db, companyId);

    const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
    const [{ count: queuedCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          eq(agents.companyId, companyId),
          hotCodingTypes.length > 0 ? inArray(agents.adapterType, hotCodingTypes) : eq(agents.id, agents.id),
        ),
      );

    res.json({
      ...digest,
      hotSlotUsage: {
        current: hotSlotCurrent,
        maxPerAgent: 2,
      },
      queuedHotRunsCount: Number(queuedCount ?? 0),
    });
  });

  return router;
}
