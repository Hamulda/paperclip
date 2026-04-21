// Swarm Orchestrator — decision layer for phase transitions and issue routing
// It is NOT a coder: it observes artifacts, reviews queues, and directs work.

import type { Db } from "@paperclipai/db";
import type {
  PlannerArtifact,
  PlanReviewerArtifact,
  ExecutorArtifact,
  ReviewerArtifact,
  ArtifactType,
  VerificationStatus,
  IssueArtifact,
} from "@paperclipai/shared";
import { assertPhaseTransition, type IssuePhase } from "./issue-phase.js";
import { issueService, issueArtifactService } from "./index.js";

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
};

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

export function decideFromArtifact(
  artifact: PlannerArtifact | PlanReviewerArtifact | ExecutorArtifact | ReviewerArtifact,
  artifactType: ArtifactType,
  phase: IssuePhase,
): OrchestrationAction {
  switch (artifactType) {
    case "planner": {
      const art = artifact as PlannerArtifact;
      if (!plannerReached(art)) {
        return { type: "noop", reason: "planner artifact incomplete" };
      }
      return {
        type: "phase_transition",
        to: "plan_review",
        reason: "plan ready for review",
      };
    }

    case "plan_reviewer": {
      const art = artifact as PlanReviewerArtifact;
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
      return {
        type: "phase_transition",
        to: "code_review",
        reason: "execution complete",
      };
    }

    case "reviewer": {
      const art = artifact as ReviewerArtifact;
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
      await issues.update(
        decision.issueId,
        { phase: action.to },
        {},
      );
      break;
    }

    case "mark_blocked": {
      assertPhaseTransition(decision.phase, "blocked");
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

export async function orchestrateIssue(
  db: Db,
  issueId: string,
): Promise<OrchestrationDecision | null> {
  const issues = issueService(db);
  const issue = await issues.getById(issueId);
  if (!issue) return null;

  const phase = (issue.phase as IssuePhase | null) ?? "triage";

  // Get the latest published artifact for this issue
  const artifacts = await issueArtifactService(db).listForIssue(issueId);
  const latestPublished = artifacts
    .filter((a) => a.status === "published")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!latestPublished) return null;

  const artifactType = latestPublished.artifactType as ArtifactType;
  const meta = latestPublished.metadata;

  if (!meta) return null;

  const action = decideFromArtifact(meta as any, artifactType, phase);
  const decision: OrchestrationDecision = {
    issueId,
    phase,
    action,
    artifactType,
  };

  await applyOrchestrationDecision(db, decision);
  return decision;
}