// =============================================================================
// Session Resolver — Task session and runtime state resolution for wakeup flows
// =============================================================================

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentRuntimeState,
  agentTaskSessions,
  agents,
  heartbeatRuns,
} from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import {
  buildExplicitResumeSessionOverride,
  getAdapterSessionCodec,
  normalizeSessionParams,
} from "./session-state-manager.js";

// ---------------------------------------------------------------------------
// readNonEmptyString — duplicated here to keep session-resolver self-contained
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// ---------------------------------------------------------------------------
// Task session lookup
// ---------------------------------------------------------------------------

export async function getTaskSession(
  db: Db,
  companyId: string,
  agentId: string,
  adapterType: string,
  taskKey: string,
) {
  return db
    .select()
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, companyId),
        eq(agentTaskSessions.agentId, agentId),
        eq(agentTaskSessions.adapterType, adapterType),
        eq(agentTaskSessions.taskKey, taskKey),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Runtime state lookup
// ---------------------------------------------------------------------------

export async function getRuntimeState(db: Db, agentId: string) {
  return db
    .select()
    .from(agentRuntimeState)
    .where(eq(agentRuntimeState.agentId, agentId))
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Session-before resolution for wakeup — resolves the session ID to carry forward
// ---------------------------------------------------------------------------

export async function resolveSessionBeforeForWakeup(
  db: Db,
  agent: typeof agents.$inferSelect,
  taskKey: string | null,
) {
  if (taskKey) {
    const codec = getAdapterSessionCodec(agent.adapterType);
    const existingTaskSession = await getTaskSession(
      db,
      agent.companyId,
      agent.id,
      agent.adapterType,
      taskKey,
    );
    const parsedParams = normalizeSessionParams(
      codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
    );
    return truncateDisplayId(
      existingTaskSession?.sessionDisplayId ??
        (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
        readNonEmptyString(parsedParams?.sessionId),
    );
  }

  const runtimeForRun = await getRuntimeState(db, agent.id);
  return runtimeForRun?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Explicit resume session override resolution
// ---------------------------------------------------------------------------

export async function resolveExplicitResumeSessionOverride(
  db: Db,
  agent: typeof agents.$inferSelect,
  payload: Record<string, unknown> | null,
  taskKey: string | null,
) {
  const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
  if (!resumeFromRunId) return null;

  const resumeRun = await db
    .select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, resumeFromRunId),
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!resumeRun) return null;

  const resumeContext = parseObject(resumeRun.contextSnapshot);
  const resumeTaskKey =
    (resumeContext.taskKey as string | null) ?? taskKey;
  const resumeTaskSession = resumeTaskKey
    ? await getTaskSession(db, agent.companyId, agent.id, agent.adapterType, resumeTaskKey)
    : null;
  const sessionCodec = getAdapterSessionCodec(agent.adapterType);
  const sessionOverride = buildExplicitResumeSessionOverride({
    resumeFromRunId,
    resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
    resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
    taskSession: resumeTaskSession,
    sessionCodec,
  });
  if (!sessionOverride) return null;

  return {
    resumeFromRunId,
    taskKey: resumeTaskKey,
    issueId: readNonEmptyString(resumeContext.issueId),
    taskId:
      readNonEmptyString(resumeContext.taskId) ??
      readNonEmptyString(resumeContext.issueId),
    sessionDisplayId: sessionOverride.sessionDisplayId,
    sessionParams: sessionOverride.sessionParams,
  };
}
