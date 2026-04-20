// =============================================================================
// Issue Comment Policy — Run comment satisfaction, retry queueing, policy finalization
// =============================================================================

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { publishLiveEvent } from "./live-events.js";
import { normalizeAgentNameKey } from "./agent-name-utils.js";
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

import {
  deriveTaskKeyWithHeartbeatFallback,
  shouldRequireIssueCommentForWake,
} from "./run-context-builder.js";

export type IssueCommentPolicyOutcome =
  | "satisfied"
  | "not_applicable"
  | "retry_queued"
  | "retry_exhausted";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueCommentPolicyResult {
  outcome: IssueCommentPolicyOutcome;
  queuedRun: typeof heartbeatRuns.$inferSelect | null;
}

// ---------------------------------------------------------------------------
// Run comment lookup
// ---------------------------------------------------------------------------

export async function findRunIssueComment(
  db: Db,
  runId: string,
  companyId: string,
  issueId: string,
) {
  return db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        eq(issueComments.createdByRunId, runId),
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Run comment status patch
// ---------------------------------------------------------------------------

export async function patchRunIssueCommentStatus(
  db: Db,
  runId: string,
  patch: Partial<Pick<typeof heartbeatRuns.$inferInsert, "issueCommentStatus" | "issueCommentSatisfiedByCommentId" | "issueCommentRetryQueuedAt">>,
) {
  return db
    .update(heartbeatRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(heartbeatRuns.id, runId))
    .returning()
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Enqueue missing issue comment retry
// ---------------------------------------------------------------------------

export async function enqueueMissingIssueCommentRetry(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  agent: typeof agents.$inferSelect,
  issueId: string,
  sessionBefore: string | null,
) {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const retryContextSnapshot = {
    ...contextSnapshot,
    retryOfRunId: run.id,
    wakeReason: "missing_issue_comment",
    retryReason: "missing_issue_comment",
    missingIssueCommentForRunId: run.id,
  };
  const now = new Date();

  const retryRun = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
    );

    const issue = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;

    const wakeupRequest = await tx
      .insert(agentWakeupRequests)
      .values({
        companyId: run.companyId,
        agentId: run.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "missing_issue_comment",
        payload: {
          issueId,
          retryOfRunId: run.id,
          retryReason: "missing_issue_comment",
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    const queuedRun = await tx
      .insert(heartbeatRuns)
      .values({
        companyId: run.companyId,
        agentId: run.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: retryContextSnapshot,
        sessionIdBefore: sessionBefore,
        retryOfRunId: run.id,
        issueCommentStatus: "not_applicable",
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    await tx
      .update(agentWakeupRequests)
      .set({
        runId: queuedRun.id,
        updatedAt: now,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    await tx
      .update(issues)
      .set({
        executionRunId: queuedRun.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));

    await tx
      .update(heartbeatRuns)
      .set({
        issueCommentStatus: "retry_queued",
        issueCommentRetryQueuedAt: now,
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, run.id));

    return queuedRun;
  });

  if (!retryRun) return null;

  publishLiveEvent({
    companyId: retryRun.companyId,
    type: "heartbeat.run.queued",
    payload: {
      runId: retryRun.id,
      agentId: retryRun.agentId,
      invocationSource: retryRun.invocationSource,
      triggerDetail: retryRun.triggerDetail,
      wakeupRequestId: retryRun.wakeupRequestId,
    },
  });

  return retryRun;
}

// ---------------------------------------------------------------------------
// Policy finalization
// ---------------------------------------------------------------------------

interface AppendRunEventInput {
  run: typeof heartbeatRuns.$inferSelect;
  seq: number;
  event: {
    eventType: string;
    stream?: "system" | "stdout" | "stderr";
    level?: "info" | "warn" | "error";
    color?: string;
    message?: string;
    payload?: Record<string, unknown>;
  };
}
type AppendRunEventFn = (input: AppendRunEventInput) => Promise<void>;
type NextSeqFn = (runId: string) => Promise<number>;

export async function finalizeIssueCommentPolicy(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  agent: typeof agents.$inferSelect,
  sessionBefore: string | null,
  opts: {
    appendRunEvent: AppendRunEventFn;
    nextRunEventSeq: NextSeqFn;
  },
): Promise<IssueCommentPolicyResult> {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = readNonEmptyString(contextSnapshot.issueId);

  if (!issueId) {
    if (run.issueCommentStatus !== "not_applicable") {
      await patchRunIssueCommentStatus(db, run.id, {
        issueCommentStatus: "not_applicable",
        issueCommentSatisfiedByCommentId: null,
        issueCommentRetryQueuedAt: null,
      });
    }
    return { outcome: "not_applicable" as const, queuedRun: null };
  }

  const postedComment = await findRunIssueComment(db, run.id, run.companyId, issueId);
  if (postedComment) {
    await patchRunIssueCommentStatus(db, run.id, {
      issueCommentStatus: "satisfied",
      issueCommentSatisfiedByCommentId: postedComment.id,
      issueCommentRetryQueuedAt: null,
    });
    return { outcome: "satisfied" as const, queuedRun: null };
  }

  if (readNonEmptyString(contextSnapshot.retryReason) === "missing_issue_comment") {
    await patchRunIssueCommentStatus(db, run.id, {
      issueCommentStatus: "retry_exhausted",
      issueCommentSatisfiedByCommentId: null,
    });
    await opts.appendRunEvent(run, await opts.nextRunEventSeq(run.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Run ended without an issue comment after one retry; no further comment wake will be queued",
    });
    return { outcome: "retry_exhausted" as const, queuedRun: null };
  }

  if (!shouldRequireIssueCommentForWake(contextSnapshot)) {
    if (run.issueCommentStatus !== "not_applicable") {
      await patchRunIssueCommentStatus(db, run.id, {
        issueCommentStatus: "not_applicable",
        issueCommentSatisfiedByCommentId: null,
        issueCommentRetryQueuedAt: null,
      });
    }
    return { outcome: "not_applicable" as const, queuedRun: null };
  }

  const queuedRun = await enqueueMissingIssueCommentRetry(db, run, agent, issueId, sessionBefore);
  if (queuedRun) {
    await opts.appendRunEvent(run, await opts.nextRunEventSeq(run.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Run ended without an issue comment; queued one follow-up wake to require a comment",
    });
    return { outcome: "retry_queued" as const, queuedRun };
  }

  await patchRunIssueCommentStatus(db, run.id, {
    issueCommentStatus: "retry_exhausted",
    issueCommentSatisfiedByCommentId: null,
  });
  return { outcome: "retry_exhausted" as const, queuedRun: null };
}