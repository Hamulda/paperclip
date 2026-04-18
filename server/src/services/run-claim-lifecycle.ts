// =============================================================================
// Run Claim Lifecycle — Run claiming, concurrency limits, per-agent locking
// =============================================================================

import { asNumber } from "../adapters/utils.js";
import type { agents } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;

// ---------------------------------------------------------------------------
// Concurrency normalization
// ---------------------------------------------------------------------------

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

// ---------------------------------------------------------------------------
// Per-agent start lock — ensures only one run starts at a time per agent
// ---------------------------------------------------------------------------

const startLocksByAgent = new Map<string, Promise<void>>();

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat policy parsing
// ---------------------------------------------------------------------------

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
  // Dynamic import to avoid circular dependency at module load time
  const { parseObject, asBoolean } = require("../adapters/utils.js");

  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    maxHotCodingRuns: normalizeMaxConcurrentHotCodingRuns(heartbeat.maxHotCodingRuns),
  };
}

function normalizeMaxConcurrentHotCodingRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, 2));
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(8, parsed));
}
