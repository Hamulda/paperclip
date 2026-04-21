// =============================================================================
// Session Compaction — Session rotation policy evaluation and usage delta resolution
// =============================================================================

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { parseSessionCompactionPolicy } from "./heartbeat.js";
import { readRawUsageTotals, deriveNormalizedUsageDelta, type UsageTotals } from "./run-usage.js";
import { hasSessionCompactionThresholds } from "@paperclipai/adapter-utils";
import { formatCount } from "./run-usage.js";

export type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

type HeartbeatRunListResultColumns = {
  id: typeof heartbeatRuns.id;
  createdAt: typeof heartbeatRuns.createdAt;
  usageJson: typeof heartbeatRuns.usageJson;
  error: typeof heartbeatRuns.error;
  resultSummary: ReturnType<typeof sql<string | null>>;
  resultResult: ReturnType<typeof sql<string | null>>;
  resultMessage: ReturnType<typeof sql<string | null>>;
  resultError: ReturnType<typeof sql<string | null>>;
  resultTotalCostUsd: ReturnType<typeof sql<string | null>>;
  resultCostUsd: ReturnType<typeof sql<string | null>>;
  resultCostUsdCamel: ReturnType<typeof sql<string | null>>;
};

const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 480;

const heartbeatRunListResultColumns = {
  resultSummary: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'summary', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultSummary"),
  resultResult: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'result', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultResult"),
  resultMessage: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'message', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultMessage"),
  resultError: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'error', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultError"),
  resultTotalCostUsd: sql<string | null>`${heartbeatRuns.resultJson} ->> 'total_cost_usd'`.as("resultTotalCostUsd"),
  resultCostUsd: sql<string | null>`${heartbeatRuns.resultJson} ->> 'cost_usd'`.as("resultCostUsd"),
  resultCostUsdCamel: sql<string | null>`${heartbeatRuns.resultJson} ->> 'costUsd'`.as("resultCostUsdCamel"),
} as const;

// ---------------------------------------------------------------------------
// Result JSON summarization
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function summarizeHeartbeatRunListResultJson(input: {
  summary?: string | null;
  result?: string | null;
  message?: string | null;
  error?: string | null;
  totalCostUsd?: string | null;
  costUsd?: string | null;
  costUsdCamel?: string | null;
}): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of [
    ["summary", input.summary],
    ["result", input.result],
    ["message", input.message],
    ["error", input.error],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (normalized) summary[key] = normalized;
  }

  for (const [key, value] of [
    ["total_cost_usd", input.totalCostUsd],
    ["cost_usd", input.costUsd],
    ["costUsd", input.costUsdCamel],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (!normalized) continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) summary[key] = parsed;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// ---------------------------------------------------------------------------
// Session usage delta resolution
// ---------------------------------------------------------------------------

interface GetLatestRunForSessionFn {
  (agentId: string, sessionId: string, opts?: { excludeRunId?: string | null }): Promise<{
    id: string;
    usageJson: Record<string, unknown> | null;
  } | null>;
}

export async function resolveNormalizedUsageForSession(
  db: Db,
  getLatestRunForSession: GetLatestRunForSessionFn,
  input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  },
) {
  const { agentId, runId, sessionId, rawUsage } = input;
  if (!sessionId || !rawUsage) {
    return {
      normalizedUsage: rawUsage,
      previousRawUsage: null as UsageTotals | null,
      derivedFromSessionTotals: false,
    };
  }

  const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
  const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
  return {
    normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
    previousRawUsage,
    derivedFromSessionTotals: previousRawUsage !== null,
  };
}

// ---------------------------------------------------------------------------
// Session compaction evaluation
// ---------------------------------------------------------------------------

interface GetOldestRunForSessionFn {
  (agentId: string, sessionId: string): Promise<{
    id: string;
    createdAt: Date;
  } | null>;
}

export async function evaluateSessionCompaction(
  db: Db,
  agent: typeof agents.$inferSelect,
  sessionId: string | null,
  issueId: string | null,
  opts?: {
    getOldestRunForSession?: GetOldestRunForSessionFn;
  },
): Promise<SessionCompactionDecision> {
  if (!sessionId) {
    return {
      rotate: false,
      reason: null,
      handoffMarkdown: null,
      previousRunId: null,
    };
  }

  const policy = parseSessionCompactionPolicy(agent);
  if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
    return {
      rotate: false,
      reason: null,
      handoffMarkdown: null,
      previousRunId: null,
    };
  }

  const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      createdAt: heartbeatRuns.createdAt,
      usageJson: heartbeatRuns.usageJson,
      error: heartbeatRuns.error,
      ...heartbeatRunListResultColumns,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(fetchLimit);

  if (runs.length === 0) {
    return {
      rotate: false,
      reason: null,
      handoffMarkdown: null,
      previousRunId: null,
    };
  }

  const latestRun = runs[0] ?? null;
  const oldestRun =
    policy.maxSessionAgeHours > 0
      ? opts?.getOldestRunForSession
        ? await opts.getOldestRunForSession(agent.id, sessionId)
        : null
      : runs[runs.length - 1] ?? latestRun;
  const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
  const sessionAgeHours =
    latestRun && oldestRun
      ? Math.max(
          0,
          (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
        )
      : 0;

  let reason: string | null = null;
  if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
    reason = `session exceeded ${policy.maxSessionRuns} runs`;
  } else if (
    policy.maxRawInputTokens > 0 &&
    latestRawUsage &&
    latestRawUsage.inputTokens >= policy.maxRawInputTokens
  ) {
    reason =
      `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
      `(threshold ${formatCount(policy.maxRawInputTokens)})`;
  } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
    reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
  }

  if (!reason || !latestRun) {
    return {
      rotate: false,
      reason: null,
      handoffMarkdown: null,
      previousRunId: latestRun?.id ?? null,
    };
  }

  const latestSummary = summarizeHeartbeatRunListResultJson({
    summary: latestRun?.resultSummary,
    result: latestRun?.resultResult,
    message: latestRun?.resultMessage,
    error: latestRun?.resultError,
    totalCostUsd: latestRun?.resultTotalCostUsd,
    costUsd: latestRun?.resultCostUsd,
    costUsdCamel: latestRun?.resultCostUsdCamel,
  });
  const latestTextSummary =
    readNonEmptyString(latestSummary?.summary) ??
    readNonEmptyString(latestSummary?.result) ??
    readNonEmptyString(latestSummary?.message) ??
    readNonEmptyString(latestRun.error);

  const handoffMarkdown = [
    "Paperclip session handoff:",
    `- Previous session: ${sessionId}`,
    issueId ? `- Issue: ${issueId}` : "",
    `- Rotation reason: ${reason}`,
    latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    rotate: true,
    reason,
    handoffMarkdown,
    previousRunId: latestRun.id,
  };
}

// ---------------------------------------------------------------------------
// Usage delta for session compaction runs list
// ---------------------------------------------------------------------------

export { deriveNormalizedUsageDelta, readRawUsageTotals, type UsageTotals } from "./run-usage.js";