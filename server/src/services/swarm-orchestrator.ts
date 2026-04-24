// Swarm Orchestrator — decision layer for phase transitions and issue routing
// It is NOT a coder: it observes artifacts, reviews queues, and directs work.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues as issuesTable } from "@paperclipai/db";
import type {
  PlannerArtifact,
  PlanReviewerArtifact,
  ExecutorArtifact,
  ReviewerArtifact,
  IntegratorArtifact,
  ArtifactType,
  VerificationStatus,
  IssueArtifact,
  IssuePhase,
} from "@paperclipai/shared";
import { assertPhaseTransition } from "./issue-phase.js";
import { issueService, issueArtifactService } from "./index.js";
import { validateArtifactChain } from "./issue-artifacts.js";

// Maximum consecutive phase bounces before blocking (e.g., planning↔plan_review, executing↔code_review)
const MAX_BOUNCES = 3;
// Maximum times the same phase can produce a new artifact before blocking (rework budget)
const MAX_REWORKS_PER_PHASE = 2;
// Maximum age (ms) of a tracking entry before it is eligible for eviction.
// Terminal-state entries (done/blocked) are cleaned up immediately after TTL;
// active entries are cleaned on access if older than this.
const MAX_TRACKING_AGE_MS = 60 * 60 * 1000; // 1 hour

export type OrchestrationAction =
  | { type: "phase_transition"; to: IssuePhase; reason: string }
  | { type: "reassign"; toAgentId: string; toRole: string; reason: string }
  | { type: "mark_blocked"; reason: string }
  | { type: "mark_ready_for_execution"; assigneeAgentId: string; reason: string }
  | { type: "noop"; reason: string };

export interface OrchestrationDecision {
  issueId: string;
  phase: IssuePhase;
  action: OrchestrationAction;
  artifactType: ArtifactType;
}

// Forward mapping: current phase → expected artifact type
const ARTIFACT_FOR_PHASE: Record<IssuePhase, ArtifactType | undefined> = {
  planning: "planner",
  plan_review: "plan_reviewer",
  executing: "executor",
  code_review: "reviewer",
  integration: "integrator",
  triage: undefined,
  ready_for_execution: undefined,
  done: undefined,
  blocked: undefined,
};

// Reverse mapping: artifact type → expected phase (used by isArtifactPhaseCompatible guard)
const PHASE_BY_ARTIFACT: Record<ArtifactType, IssuePhase> = {
  planner: "planning",
  plan_reviewer: "plan_review",
  executor: "executing",
  reviewer: "code_review",
  integrator: "integration",
};

// In-memory per-issue tracking for loop/rework detection.
// Key: issueId — cleared when issue leaves active phases.
interface IssueTracking {
  phaseHistory: IssuePhase[];
  bounces: number; // consecutive bounce transitions
  reworksByPhase: Partial<Record<IssuePhase, number>>;
  lastWasBounce: boolean; // true if the previous recordTransition call was a bounce
  prevFromPhase: IssuePhase | null; // the fromPhase of the previous transition
  lastAccessedAt: number; // Date.now() of last getTracking() call for TTL cleanup
}

// Module-level tracking store — resets on process restart (intentional: short-lived env)
const tracking = new Map<string, IssueTracking>();

// Per-issue serialisation: in-flight orchestration promises.
// Ensures concurrent calls for the same issueId are serialised, preventing
// read→decide→apply races in single-node deployments.
const inFlight = new Map<string, Promise<OrchestrationDecision | null>>();
const inFlightCreatedAt = new Map<string, number>();

export function clearTracking(issueId: string): void {
  tracking.delete(issueId);
}

export function getTracking(issueId: string): IssueTracking {
  if (!tracking.has(issueId)) {
    tracking.set(issueId, {
      phaseHistory: [],
      bounces: 0,
      reworksByPhase: {},
      lastWasBounce: false,
      prevFromPhase: null,
      lastAccessedAt: Date.now(),
    });
  }
  const t = tracking.get(issueId)!;
  t.lastAccessedAt = Date.now();
  return t;
}

/**
 * Evict tracking entries that are:
 * - in terminal states (done, blocked), OR
 * - older than MAX_TRACKING_AGE_MS since last access.
 * Called opportunistically on each orchestrateIssue entry.
 */
export function cleanupTracking(): void {
  const now = Date.now();
  for (const [id, t] of tracking.entries()) {
    const isTerminal = t.phaseHistory.at(-1) === "done" || t.phaseHistory.at(-1) === "blocked";
    const isStale = now - t.lastAccessedAt > MAX_TRACKING_AGE_MS;
    if (isTerminal || isStale) {
      tracking.delete(id);
    }
  }
  // Evict in-flight entries that have been stuck for too long.
  // This is a safety net: normally the finally-block in withIssueLock cleans up
  // on promise settlement, but pathological unhandled-rejection scenarios could
  // leave entries dangling.
  const staleCutoff = now - MAX_TRACKING_AGE_MS;
  for (const [id, createdAt] of inFlightCreatedAt.entries()) {
    if (createdAt < staleCutoff) {
      inFlight.delete(id);
      inFlightCreatedAt.delete(id);
    }
  }
}

/**
 * Serialise orchestrateIssue calls per issueId using a promise chain.
 * Concurrent calls for different issues proceed in parallel (no lock).
 * Concurrent calls for the same issue are queued and resolved in order.
 */
async function withIssueLock<T>(
  issueId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = inFlight.get(issueId);
  const next = (async () => {
    if (current) await current;
    return fn();
  })();
  inFlight.set(issueId, next as any);
  inFlightCreatedAt.set(issueId, Date.now());
  try {
    return await next;
  } finally {
    if (inFlight.get(issueId) === next) {
      inFlight.delete(issueId);
    }
    // Always clean up the timestamp so cleanupTracking doesn't evict a
    // superseded entry that is still running (stale TTL on inFlightCreatedAt).
    inFlightCreatedAt.delete(issueId);
  }
}

function plannerReached(artifact: PlannerArtifact): boolean {
  return (
    artifact.goal.length > 0 &&
    artifact.acceptanceCriteria.length > 0 &&
    artifact.touchedFiles.length > 0
  );
}

function executorReached(artifact: ExecutorArtifact): boolean {
  return artifact.filesChanged.length > 0 || artifact.changesSummary.length > 0;
}

/**
 * Guard: reject artifacts whose type does not match the current phase.
 * An executor artifact received during "planning" is a phase mismatch and
 * should not trigger transitions.
 */
export function isArtifactPhaseCompatible(
  artifactType: ArtifactType,
  currentPhase: IssuePhase,
): boolean {
  return PHASE_BY_ARTIFACT[artifactType] === currentPhase;
}

function toPhaseOrder(p: IssuePhase): number {
  const order: Record<IssuePhase, number> = {
    triage: 0,
    planning: 1,
    plan_review: 2,
    ready_for_execution: 3,
    executing: 4,
    code_review: 5,
    integration: 6,
    done: 7,
    blocked: 8,
  };
  return order[p] ?? 9;
}

function recordTransition(
  issueId: string,
  fromPhase: IssuePhase,
  toPhase: IssuePhase,
): number {
  const t = getTracking(issueId);
  const isForward = toPhaseOrder(toPhase) > toPhaseOrder(fromPhase);
  const isBounce = !isForward && (
    toPhase === t.prevFromPhase ||
    toPhaseOrder(toPhase) <= toPhaseOrder(fromPhase)
  );
  if (isBounce) {
    t.bounces += 1;
  }
  // Counter never resets — forward transitions don't cancel prior bounces.
  // A true bounce is defined purely by backward movement that revisits a prior phase.
  t.phaseHistory.push(toPhase);
  t.prevFromPhase = fromPhase;
  t.lastWasBounce = isBounce;
  return t.bounces;
}

/**
 * Increment and check rework counter for a phase.
 * Each artifact publication for the same phase consumes one rework budget.
 */
export function recordRework(issueId: string, phase: IssuePhase): number {
  const t = getTracking(issueId);
  const current = t.reworksByPhase[phase] ?? 0;
  t.reworksByPhase[phase] = current + 1;
  return t.reworksByPhase[phase]!;
}

export function checkBounceLimit(issueId: string): boolean {
  const t = getTracking(issueId);
  return t.bounces >= MAX_BOUNCES;
}

export function checkReworkLimit(issueId: string, phase: IssuePhase): boolean {
  const t = getTracking(issueId);
  return (t.reworksByPhase[phase] ?? 0) >= MAX_REWORKS_PER_PHASE;
}

/**
 * Full decision function with all guards.
 * Returns an action or marks blocked when guards fire.
 * @returns The orchestration action and whether a rework was consumed.
 *          consumeRework is true when the current phase's rework budget
 *          should be decremented (phase_transition, or rework-limit block).
 *          It is NOT set for bounce-limit blocks or noop.
 */
export function decideFromArtifact(
  artifact: PlannerArtifact | PlanReviewerArtifact | ExecutorArtifact | ReviewerArtifact | IntegratorArtifact,
  artifactType: ArtifactType,
  phase: IssuePhase,
  issueId: string,
): { action: OrchestrationAction; consumedRework: boolean } {
  // Guard: phase compatibility
  if (!isArtifactPhaseCompatible(artifactType, phase)) {
    return {
      action: {
        type: "noop",
        reason: `artifact type '${artifactType}' not compatible with current phase '${phase}'`,
      },
      consumedRework: false,
    };
  }

  // Guard: bounce/loop detection — checked first as it indicates a systemic issue
  if (checkBounceLimit(issueId)) {
    return {
      action: {
        type: "mark_blocked",
        reason: `bounce limit reached (${MAX_BOUNCES} consecutive phase bounces)`,
      },
      consumedRework: false,
    };
  }

  // Guard: rework budget per phase — prevents same-phase repeated work
  if (checkReworkLimit(issueId, phase)) {
    return {
      action: {
        type: "mark_blocked",
        reason: `rework budget exhausted for phase '${phase}' (${MAX_REWORKS_PER_PHASE} max)`,
      },
      consumedRework: true,
    };
  }

  switch (artifactType) {
    case "planner": {
      const art = artifact as PlannerArtifact;
      if (!plannerReached(art)) {
        return { action: { type: "noop", reason: "planner artifact incomplete" }, consumedRework: false };
      }
      return {
        action: {
          type: "phase_transition",
          to: "plan_review",
          reason: "plan ready for review",
        },
        consumedRework: true,
      };
    }

    case "plan_reviewer": {
      const art = artifact as PlanReviewerArtifact;
      if (art.verdict === "approved") {
        return {
          action: {
            type: "phase_transition",
            to: "ready_for_execution",
            reason: "plan approved, ready for execution",
          },
          consumedRework: true,
        };
      }
      return {
        action: {
          type: "phase_transition",
          to: "planning",
          reason: `plan rejected: ${art.scopeChanges.join("; ")}`,
        },
        consumedRework: true,
      };
    }

    case "executor": {
      const art = artifact as ExecutorArtifact;
      if (art.remainingWork.length > 0 && art.filesChanged.length === 0) {
        return { action: { type: "noop", reason: "executor has remaining work, staying in executing" }, consumedRework: false };
      }
      return {
        action: {
          type: "phase_transition",
          to: "code_review",
          reason: "execution complete",
        },
        consumedRework: true,
      };
    }

    case "reviewer": {
      const art = artifact as ReviewerArtifact;
      if (art.verdict === "approved") {
        return {
          action: {
            type: "phase_transition",
            to: "integration",
            reason: "code review approved",
          },
          consumedRework: true,
        };
      }
      if (art.verdict === "changes_requested") {
        return {
          action: {
            type: "phase_transition",
            to: "executing",
            reason: `changes requested: ${art.issuesFound.join("; ")}`,
          },
          consumedRework: true,
        };
      }
      return {
        action: {
          type: "phase_transition",
          to: "planning",
          reason: `review rejected: ${art.issuesFound.join("; ")}`,
        },
        consumedRework: true,
      };
    }

    case "integrator": {
      const art = artifact as IntegratorArtifact;

      if (art.finalVerification === "failed") {
        return {
          action: {
            type: "phase_transition",
            to: "blocked",
            reason: `integration verification failed: ${art.remainingOpenIssues.join("; ") || "unresolved issues"}`,
          },
          consumedRework: true,
        };
      }

      // skipped: only done if no remaining open issues
      if (art.finalVerification === "skipped" && art.remainingOpenIssues.length > 0) {
        return {
          action: {
            type: "mark_blocked",
            reason: `integration skipped with open issues: ${art.remainingOpenIssues.join("; ")}`,
          },
          consumedRework: true,
        };
      }

      // passed or skipped (with no open issues) → done
      return {
        action: {
          type: "phase_transition",
          to: "done",
          reason: "integration complete",
        },
        consumedRework: true,
      };
    }
  }
}

export function decideFromReviewQueue(
  handoff: { verificationStatus: VerificationStatus | null; blockers: string[] },
  phase: IssuePhase,
): OrchestrationAction {
  if (handoff.verificationStatus === "blocked" || handoff.blockers.length > 0) {
    return { type: "mark_blocked", reason: handoff.blockers[0] ?? "blocked in review queue" };
  }
  return { type: "noop", reason: "review queue check — no action needed" };
}

/**
 * Resolves the next phase for a blocked issue based on review queue signals.
 * Blocked issues stay in blocked until blockers are cleared.
 */
export function resolveBlockedTransition(
  issueId: string,
  handoff: { verificationStatus: VerificationStatus | null; blockers: string[] },
): OrchestrationAction {
  // Only unblock when verification is ready and no blockers remain
  if (
    handoff.verificationStatus === "ready_for_review" &&
    handoff.blockers.length === 0
  ) {
    const t = getTracking(issueId);
    const nextPhase = resolveNextPhaseFromHistory(t.phaseHistory);
    return {
      type: "phase_transition",
      to: nextPhase,
      reason: "blockers cleared, resuming",
    };
  }
  return { type: "mark_blocked", reason: handoff.blockers[0] ?? "still blocked" };
}

function resolveNextPhaseFromHistory(history: IssuePhase[]): IssuePhase {
  // Walk backward from the end to find the last non-blocked workflow phase.
  // This correctly handles cases like:
  //   [..., executing, code_review, integration, blocked] → resumes to integration
  //   [..., planning, plan_review, ready_for_execution, executing, blocked] → resumes to executing
  //   [..., planning, plan_review, blocked] → resumes to plan_review
  if (history.length < 2) return "planning";
  const workflowPhases: IssuePhase[] = [
    "planning",
    "plan_review",
    "ready_for_execution",
    "executing",
    "code_review",
    "integration",
  ];
  for (let i = history.length - 2; i >= 0; i--) {
    if (workflowPhases.includes(history[i])) {
      return history[i];
    }
  }
  return "planning";
}

export function decideReassignment(
  phase: IssuePhase,
  currentAgentId: string | null,
): { agentId: string | null; role: string } {
  switch (phase) {
    case "planning":
      return { agentId: null, role: "planner" };
    case "plan_review":
      return { agentId: null, role: "reviewer" };
    case "executing":
      return { agentId: null, role: "executor" };
    case "code_review":
      return { agentId: null, role: "reviewer" };
    case "integration":
      return { agentId: null, role: "integrator" };
    default:
      return { agentId: null, role: "general" };
  }
}

export function decisionToOrchestrationAction(
  decision: OrchestrationDecision,
): OrchestrationAction {
  return decision.action;
}

export async function applyOrchestrationDecision(
  db: Db,
  decision: OrchestrationDecision,
  dbOrTx?: any,
): Promise<void> {
  const issues = issueService(db);
  const resolvedDb = dbOrTx ?? db;
  const action = decision.action;

  switch (action.type) {
    case "phase_transition": {
      assertPhaseTransition(decision.phase, action.to);
      await resolvedDb
        .update(issuesTable)
        .set({ phase: action.to })
        .where(eq(issuesTable.id, decision.issueId));
      break;
    }

    case "mark_blocked": {
      assertPhaseTransition(decision.phase, "blocked");
      await resolvedDb
        .update(issuesTable)
        .set({ phase: "blocked" })
        .where(eq(issuesTable.id, decision.issueId));
      break;
    }

    case "mark_ready_for_execution": {
      assertPhaseTransition(decision.phase, "ready_for_execution");
      await resolvedDb
        .update(issuesTable)
        .set({ phase: "ready_for_execution", assigneeAgentId: action.assigneeAgentId })
        .where(eq(issuesTable.id, decision.issueId));
      break;
    }

    case "reassign": {
      await resolvedDb
        .update(issuesTable)
        .set({ assigneeAgentId: action.toAgentId, phase: decision.phase })
        .where(eq(issuesTable.id, decision.issueId));
      break;
    }

    case "noop":
      break;
  }
}

/**
 * Standalone transition recorder for use in tests and non-DB paths.
 * Updates phase history and bounce counter for loop detection.
 */
export function recordPhaseTransition(
  issueId: string,
  fromPhase: IssuePhase,
  toPhase: IssuePhase,
): number {
  return recordTransition(issueId, fromPhase, toPhase);
}

export async function orchestrateIssue(
  db: Db,
  issueId: string,
): Promise<OrchestrationDecision | null> {
  return withIssueLock(issueId, async () => orchestrateIssueInner(db, issueId));
}

async function orchestrateIssueInner(
  db: Db,
  issueId: string,
): Promise<OrchestrationDecision | null> {
  // Opportunistic cleanup of stale/terminal tracking entries before each orchestration run.
  cleanupTracking();

  const issues = issueService(db);

  // ── Read current issue state WITHIN a transaction and FOR UPDATE lock.
  // This prevents concurrent orchestrateIssue calls for the same issue from
  // racing: the second caller blocks on the SELECT FOR UPDATE until the first
  // commits or rolls back, ensuring decisions are based on committed state.
  let phase: IssuePhase = "triage" as IssuePhase;
  let verificationStatus: VerificationStatus | null = null;
  let blockedBy: string[] = [];

  await db.transaction(async (tx) => {
    // Acquire row-level lock on the issue row to serialise concurrent callers.
    await tx.execute(sql`select id from issues where id = ${issueId} for update`);

    // Read within the same transaction — sees the locked row state.
    const rows: typeof issuesTable.$inferSelect[] = await tx
      .select()
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .limit(1);
    const issue = rows[0] ?? null;

    if (!issue) {
      phase = "triage";
      verificationStatus = null;
      blockedBy = [];
      return;
    }

    phase = (issue.phase as IssuePhase | null) ?? "triage";
    verificationStatus = (issue as any).verificationStatus as VerificationStatus | null ?? null;
    blockedBy = (issue as any).blockedBy as string[] ?? [];
  });

  // ── Blocked state: consult review queue for unblock signal ────────────────
  if (phase === "blocked") {
    const handoff = { verificationStatus, blockers: blockedBy };
    const action = resolveBlockedTransition(issueId, handoff);
    const decision: OrchestrationDecision = {
      issueId,
      phase,
      action,
      artifactType: "integrator" as ArtifactType,
    };
    if (action.type !== "noop") {
      await db.transaction(async (tx) => {
        await applyOrchestrationDecision(db, decision, tx);
      });
    }
    return decision;
  }

  // ── Expected artifact type for current phase (gate) ─────────────────────
  const expectedArtifactType = ARTIFACT_FOR_PHASE[phase];
  if (!expectedArtifactType) {
    return null;
  }

  // ── Validate artifact chain to get the canonical head ────────────────────
  const allArtifacts = await issueArtifactService(db).listForIssue(issueId);
  const chainHead = validateArtifactChain(allArtifacts);

  if (!chainHead) return null;

  // ── Phase compatibility guard ─────────────────────────────────────────────
  if (!isArtifactPhaseCompatible(chainHead.artifactType as ArtifactType, phase)) {
    const action: OrchestrationAction = {
      type: "noop",
      reason: `artifact type '${chainHead.artifactType}' not compatible with current phase '${phase}'`,
    };
    return { issueId, phase, action, artifactType: chainHead.artifactType as ArtifactType };
  }

  const artifactType = chainHead.artifactType as ArtifactType;
  const meta = chainHead.metadata;
  if (!meta) return null;

  const { action, consumedRework } = decideFromArtifact(meta as any, artifactType, phase, issueId);
  const decision: OrchestrationDecision = { issueId, phase, action, artifactType };

  if (action.type !== "noop") {
    // Apply decision within a transaction so that the write is atomic with
    // respect to the FOR UPDATE lock acquired at the top of this function.
    await db.transaction(async (tx) => {
      await applyOrchestrationDecision(db, decision, tx);
    });
    // recordPhaseTransition is safe here: called AFTER the transaction commits.
    // (It was previously called INSIDE the transaction — a bug since in-memory
    // state was mutated before the DB write was confirmed.)
    recordPhaseTransition(issueId, decision.phase, action.type === "phase_transition" ? action.to : "blocked");
    // recordRework is only called when the artifact consumption itself consumed
    // the rework budget (phase_transition paths), not for bounce-limit blocks.
    if (consumedRework) {
      recordRework(issueId, phase);
    }
  }

  return decision;
}