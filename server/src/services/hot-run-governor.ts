// =============================================================================
// Hot Run Governor — Concurrency limiting for hot-coding local adapters
// =============================================================================

import { and, eq, inArray, ne, asc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipAI/db";
import { asNumber } from "../adapters/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT = 2;
export const HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_MAX = 8;

export const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeMaxConcurrentHotCodingRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT;
  return Math.max(1, Math.min(HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_MAX, parsed));
}

// ---------------------------------------------------------------------------
// Adapter classification
// ---------------------------------------------------------------------------

export function isHotCodingAdapter(adapterType: string): boolean {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// ---------------------------------------------------------------------------
// Running hot run counter
// ---------------------------------------------------------------------------

export async function countRunningHotCodingRuns(db: Db, companyId?: string): Promise<number> {
  const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
  if (hotCodingTypes.length === 0) return 0;
  const conditions = [
    eq(heartbeatRuns.status, "running"),
    inArray(agents.adapterType, hotCodingTypes),
  ];
  if (companyId) {
    conditions.push(eq(agents.companyId, companyId));
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(and(...conditions));
  return Number(count ?? 0);
}

// ---------------------------------------------------------------------------
// Fairness promotion — find and promote next queued hot run from another agent
// ---------------------------------------------------------------------------

export async function tryPromoteNextHotCodingRun(
  db: Db,
  companyId: string,
  excludeAgentId: string,
): Promise<string | void> {
  const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
  if (hotCodingTypes.length === 0) return;

  const candidateRows = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(and(
      eq(heartbeatRuns.status, "queued"),
      eq(agents.companyId, companyId),
      ne(agents.id, excludeAgentId),
      inArray(agents.adapterType, hotCodingTypes),
    ))
    .orderBy(asc(heartbeatRuns.createdAt))
    .limit(1);

  if (candidateRows.length > 0) {
    return candidateRows[0]!.agentId;
  }
}
