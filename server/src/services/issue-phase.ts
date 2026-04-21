import type { IssuePhase } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export { type IssuePhase };

const ALL_PHASES: readonly IssuePhase[] = [
  "triage",
  "planning",
  "plan_review",
  "ready_for_execution",
  "executing",
  "code_review",
  "integration",
  "done",
  "blocked",
];

const VALID_TRANSITIONS: Record<IssuePhase, readonly IssuePhase[]> = {
  triage: ["planning", "blocked"],
  planning: ["plan_review", "blocked"],
  plan_review: ["ready_for_execution", "planning", "blocked"],
  ready_for_execution: ["executing", "blocked"],
  executing: ["code_review", "blocked"],
  code_review: ["integration", "executing", "blocked"],
  integration: ["done", "blocked"],
  done: [],
  blocked: [
    "triage",
    "planning",
    "plan_review",
    "ready_for_execution",
    "executing",
    "code_review",
    "integration",
    "done",
  ],
};

const PHASE_ORDER: Record<IssuePhase, number> = ALL_PHASES.reduce(
  (acc, phase, index) => {
    acc[phase] = index;
    return acc;
  },
  {} as Record<IssuePhase, number>,
);

export function isIssuePhase(value: unknown): value is IssuePhase {
  return typeof value === "string" && ALL_PHASES.includes(value as IssuePhase);
}

export function assertPhaseTransition(
  from: IssuePhase | null | undefined,
  to: IssuePhase | null | undefined,
): void {
  if (to === null || to === undefined) return;
  if (!isIssuePhase(to)) {
    throw conflict(`Unknown issue phase: ${to}`);
  }
  if (from === null || from === undefined) return;
  if (from === to) return;
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw conflict(
      `Invalid phase transition from '${from}' to '${to}'. Allowed transitions: ${allowed.join(", ") || "none"}`,
    );
  }
}

export function applyPhaseSideEffects(
  phase: IssuePhase | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!phase) return patch;

  if (phase === "ready_for_execution" && !patch["startedAt"]) {
    patch["startedAt"] = new Date();
  }
  if (phase === "done" && !patch["completedAt"]) {
    patch["completedAt"] = new Date();
  }
  if (phase === "blocked" && !patch["cancelledAt"]) {
    patch["cancelledAt"] = null;
  }

  return patch;
}

export function phaseRepresentsWork(phase: IssuePhase): boolean {
  return (
    phase === "planning" ||
    phase === "ready_for_execution" ||
    phase === "executing" ||
    phase === "code_review" ||
    phase === "integration"
  );
}

export function phaseRepresentsTerminal(phase: IssuePhase): boolean {
  return phase === "done";
}

export function phaseRepresentsActive(phase: IssuePhase): boolean {
  return phase !== "done" && phase !== "blocked";
}

export function getNextPhaseOnStatusChange(
  currentPhase: IssuePhase | null | undefined,
  currentStatus: string,
  nextStatus: string,
): IssuePhase | null {
  if (nextStatus === "done") return "done";
  if (nextStatus === "blocked") return "blocked";
  if (nextStatus === "in_progress" && !currentPhase) return "triage";
  return currentPhase ?? null;
}

export function sortByPhase(a: IssuePhase, b: IssuePhase): number {
  return (PHASE_ORDER[a] ?? 999) - (PHASE_ORDER[b] ?? 999);
}

export function getPhaseLabel(phase: IssuePhase): string {
  const labels: Record<IssuePhase, string> = {
    triage: "Triage",
    planning: "Planning",
    plan_review: "Plan Review",
    ready_for_execution: "Ready",
    executing: "Executing",
    code_review: "Code Review",
    integration: "Integration",
    done: "Done",
    blocked: "Blocked",
  };
  return labels[phase] ?? phase;
}