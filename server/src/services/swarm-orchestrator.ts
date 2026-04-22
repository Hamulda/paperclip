// Swarm Orchestrator — decision layer for phase transitions and issue routing
// It is NOT a coder: it observes artifacts, reviews queues, and directs work.

import type { Db } from "@paperclipai/db";
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
}

// Module-level tracking store — resets on process restart (intentional: short-lived env)
const tracking = new Map<string, IssueTracking>();

export function clearTracking(issueId: string): void {
  tracking.delete(issueId);
}

function getTracking(issueId: string): IssueTracking {
  if (!tracking.has(issueId)) {
    tracking.set(issueId, { phaseHistory: [], bounces: 0, reworksByPhase: {} });
  }
  return tracking.get(issueId)!;
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

/**
 * Detect consecutive phase bounce (e.g., planning → plan_review → planning).
 * A bounce is counted when the target phase is lower or equal in order than
 * the phase we just came from.
 */
function detectBounce(
  t: IssueTracking,
  fromPhase: IssuePhase,
  toPhase: IssuePhase,
): boolean {
  if (t.phaseHistory.length === 0) return false;
  const prev = t.phaseHistory[t.phaseHistory.length - 1];
  // Bounce = moving back to a previous phase or same phase
  return prev === toPhase || toPhaseOrder(toPhase) <= toPhaseOrder(prev);
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

/**
 * Update tracking state for a transition and return the bounce count.
 */
function recordTransition(
  issueId: string,
  fromPhase: IssuePhase,
  toPhase: IssuePhase,
): number {
  const t = getTracking(issueId);
  t.phaseHistory.push(toPhase);
  // Keep history bounded
  if (t.phaseHistory.length > 16) {
    t.phaseHistory = t.phaseHistory.slice(-8);
  }
  if (detectBounce(t, fromPhase, toPhase)) {
    t.bounces += 1;
  } else {
    t.bounces = 0;
  }
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
 */
export function decideFromArtifact(
  artifact: PlannerArtifact | PlanReviewerArtifact | ExecutorArtifact | ReviewerArtifact | IntegratorArtifact,
  artifactType: ArtifactType,
  phase: IssuePhase,
  issueId: string,
): OrchestrationAction {
  // Guard: phase compatibility
  if (!isArtifactPhaseCompatible(artifactType, phase)) {
    return {
      type: "noop",
      reason: `artifact type '${artifactType}' not compatible with current phase '${phase}'`,
    };
  }

  // Guard: bounce/loop detection — checked first as it indicates a systemic issue
  if (checkBounceLimit(issueId)) {
    return {
      type: "mark_blocked",
      reason: `bounce limit reached (${MAX_BOUNCES} consecutive phase bounces)`,
    };
  }

  // Guard: rework budget per phase — prevents same-phase repeated work
  if (checkReworkLimit(issueId, phase)) {
    return {
      type: "mark_blocked",
      reason: `rework budget exhausted for phase '${phase}' (${MAX_REWORKS_PER_PHASE} max)`,
    };
  }

  switch (artifactType) {
    case "planner": {
      const art = artifact as PlannerArtifact;
      if (!plannerReached(art)) {
        return { type: "noop", reason: "planner artifact incomplete" };
      }
      recordRework(issueId, phase);
      return {
        type: "phase_transition",
        to: "plan_review",
        reason: "plan ready for review",
      };
    }

    case "plan_reviewer": {
      const art = artifact as PlanReviewerArtifact;
      recordRework(issueId, phase);
      if (art.verdict === "approved") {
        return {
          type: "phase_transition",
          to: "ready_for_execution",
          reason: "plan approved, ready for execution",
        };
      }
      return {
        type: "phase_transition",
        to: "planning",
        reason: `plan rejected: ${art.scopeChanges.join("; ")}`,
      };
    }

    case "executor": {
      const art = artifact as ExecutorArtifact;
      if (art.remainingWork.length > 0 && art.filesChanged.length === 0) {
        return { type: "noop", reason: "executor has remaining work, staying in executing" };
      }
      recordRework(issueId, phase);
      return {
        type: "phase_transition",
        to: "code_review",
        reason: "execution complete",
      };
    }

    case "reviewer": {
      const art = artifact as ReviewerArtifact;
      recordRework(issueId, phase);
      if (art.verdict === "approved") {
        return {
          type: "phase_transition",
          to: "integration",
          reason: "code review approved",
        };
      }
      if (art.verdict === "changes_requested") {
        return {
          type: "phase_transition",
          to: "executing",
          reason: `changes requested: ${art.issuesFound.join("; ")}`,
        };
      }
      return {
        type: "phase_transition",
        to: "planning",
        reason: `review rejected: ${art.issuesFound.join("; ")}`,
      };
    }

    case "integrator": {
      const art = artifact as IntegratorArtifact;
      recordRework(issueId, phase);

      if (art.finalVerification === "failed") {
        return {
          type: "phase_transition",
          to: "blocked",
          reason: `integration verification failed: ${art.remainingOpenIssues.join("; ") || "unresolved issues"}`,
        };
      }

      // skipped: only done if no remaining open issues
      if (art.finalVerification === "skipped" && art.remainingOpenIssues.length > 0) {
        return {
          type: "mark_blocked",
          reason: `integration skipped with open issues: ${art.remainingOpenIssues.join("; ")}`,
        };
      }

      // passed or skipped (with no open issues) → done
      return {
        type: "phase_transition",
        to: "done",
        reason: "integration complete",
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
  if (history.length < 2) return "planning";
  const prev = history[history.length - 1];
  // Resume to the phase before the blocking phase
  const candidates = ["planning", "executing", "code_review"] as const;
  for (const c of candidates) {
    if (c !== prev) return c;
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
): Promise<void> {
  const issues = issueService(db);
  const action = decision.action;

  switch (action.type) {
    case "phase_transition": {
      assertPhaseTransition(decision.phase, action.to);
      recordPhaseTransition(decision.issueId, decision.phase, action.to);
      await issues.update(
        decision.issueId,
        { phase: action.to },
        {},
      );
      break;
    }

    case "mark_blocked": {
      assertPhaseTransition(decision.phase, "blocked");
      recordPhaseTransition(decision.issueId, decision.phase, "blocked");
      await issues.update(
        decision.issueId,
        { phase: "blocked" },
        {},
      );
      break;
    }

    case "mark_ready_for_execution": {
      assertPhaseTransition(decision.phase, "ready_for_execution");
      await issues.update(
        decision.issueId,
        {
          phase: "ready_for_execution",
          assigneeAgentId: action.assigneeAgentId,
        },
        {},
      );
      break;
    }

    case "reassign": {
      await issues.update(
        decision.issueId,
        {
          assigneeAgentId: action.toAgentId,
          phase: decision.phase,
        },
        {},
      );
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
  const issues = issueService(db);
  const issue = await issues.getById(issueId);
  if (!issue) return null;

  const phase = (issue.phase as IssuePhase | null) ?? "triage";

  // ── Blocked state: consult review queue for unblock signal ────────────────
  if (phase === "blocked") {
    const handoff = {
      verificationStatus: issue.verificationStatus as VerificationStatus | null,
      blockers: issue.blockedBy ?? [],
    };
    const action = resolveBlockedTransition(issueId, handoff);
    const decision: OrchestrationDecision = {
      issueId,
      phase,
      action,
      artifactType: "integrator" as ArtifactType, // placeholder — blocked has no artifact type
    };
    if (action.type !== "noop") {
      await applyOrchestrationDecision(db, decision);
    }
    return decision;
  }

  // ── Expected artifact type for current phase (gate) ─────────────────────
  const expectedArtifactType = PHASE_BY_ARTIFACT[phase] as ArtifactType | undefined;
  if (!expectedArtifactType) {
    // Terminal/non-workflow phase — nothing to orchestrate
    return null;
  }

  // ── Validate artifact chain to get the canonical head ────────────────────
  const allArtifacts = await issueArtifactService(db).listForIssue(issueId);
  const chainHead = validateArtifactChain(allArtifacts);

  if (!chainHead) return null;

  // ── Phase compatibility guard: reject artifacts from other phases ─────────
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

  const action = decideFromArtifact(meta as any, artifactType, phase, issueId);
  const decision: OrchestrationDecision = {
    issueId,
    phase,
    action,
    artifactType,
  };

  await applyOrchestrationDecision(db, decision);
  return decision;
}