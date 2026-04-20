// =============================================================================
// Hot Run Governor — Concurrency limiting for hot-coding local adapters
// =============================================================================

import { and, eq, inArray, ne, asc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { asNumber, parseObject } from "../adapters/utils.js";

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

export async function countRunningHotCodingRuns(
  db: Db,
  companyId?: string,
  projectId?: string,
): Promise<number> {
  const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
  if (hotCodingTypes.length === 0) return 0;
  const conditions = [
    eq(heartbeatRuns.status, "running"),
    inArray(agents.adapterType, hotCodingTypes),
  ];
  if (companyId) {
    conditions.push(eq(agents.companyId, companyId));
  }
  if (projectId) {
    conditions.push(sql`${heartbeatRuns.contextSnapshot}->>'projectId' = ${projectId}`);
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

export async function getEffectiveHotCodingCapacity(
  db: Db,
  companyId: string,
  projectId?: string,
): Promise<number> {
  const hotCodingTypes = [...SESSIONED_LOCAL_ADAPTERS];
  if (hotCodingTypes.length === 0) return 0;

  if (projectId) {
    // Project-scoped: sum maxHotCodingRuns from agents that have runs for this project
    const rows = await db
      .select({ runtimeConfig: agents.runtimeConfig, agentId: agents.id })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(
        eq(agents.companyId, companyId),
        inArray(agents.adapterType, hotCodingTypes),
        sql`${heartbeatRuns.contextSnapshot}->>'projectId' = ${projectId}`,
      ));

    if (rows.length === 0) return HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT;

    // Deduplicate by agent (one agent may have multiple runs for same project)
    const agentConfigs = new Map<string, string>();
    for (const row of rows) {
      if (!agentConfigs.has(row.agentId)) {
        const raw = row.runtimeConfig;
        agentConfigs.set(row.agentId, typeof raw === "string" ? raw : JSON.stringify(raw));
      }
    }

    let total = 0;
    for (const [, runtimeConfig] of agentConfigs) {
      try {
        const config = parseObject(runtimeConfig) as { heartbeat?: { maxHotCodingRuns?: unknown } };
        total += normalizeMaxConcurrentHotCodingRuns(config?.heartbeat?.maxHotCodingRuns);
      } catch {
        total += HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT;
      }
    }
    return total;
  }

  // Company-level: sum across all hot coding agents in the company
  const rows = await db
    .select({ runtimeConfig: agents.runtimeConfig })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      inArray(agents.adapterType, hotCodingTypes),
    ));

  if (rows.length === 0) return HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT;

  let total = 0;
  for (const row of rows) {
    try {
      const config = parseObject(row.runtimeConfig) as { heartbeat?: { maxHotCodingRuns?: unknown } };
      const maxRuns = normalizeMaxConcurrentHotCodingRuns(config?.heartbeat?.maxHotCodingRuns);
      total += maxRuns;
    } catch {
      total += HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT;
    }
  }
  return total;
}

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
