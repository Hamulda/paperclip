import { describe, expect, it, vi } from "vitest";
import {
  decideFromArtifact,
  decideFromReviewQueue,
  decideReassignment,
  type OrchestrationAction,
} from "../swarm-orchestrator.ts";
import type { PlannerArtifact, PlanReviewerArtifact, ExecutorArtifact, ReviewerArtifact } from "@paperclipai/shared";

describe("decideFromArtifact", () => {
  describe("planner", () => {
    it("transitions to plan_review when planner artifact is complete", () => {
      const artifact: PlannerArtifact = {
        goal: "Implement auth",
        acceptanceCriteria: ["login works", "logout works"],
        touchedFiles: ["src/auth.ts"],
        forbiddenFiles: [],
        testPlan: "Run integration tests",
        risks: [],
      };
      const action = decideFromArtifact(artifact, "planner", "planning");
      expect(action).toEqual({ type: "phase_transition", to: "plan_review", reason: "plan ready for review" });
    });

    it("returns noop when planner artifact is incomplete (missing goal)", () => {
      const artifact: PlannerArtifact = {
        goal: "",
        acceptanceCriteria: ["login works"],
        touchedFiles: ["src/auth.ts"],
        forbiddenFiles: [],
        testPlan: "Run tests",
        risks: [],
      };
      const action = decideFromArtifact(artifact, "planner", "planning");
      expect(action).toEqual({ type: "noop", reason: "planner artifact incomplete" });
    });

    it("returns noop when planner artifact is incomplete (missing acceptance criteria)", () => {
      const artifact: PlannerArtifact = {
        goal: "Implement auth",
        acceptanceCriteria: [],
        touchedFiles: ["src/auth.ts"],
        forbiddenFiles: [],
        testPlan: "Run tests",
        risks: [],
      };
      const action = decideFromArtifact(artifact, "planner", "planning");
      expect(action).toEqual({ type: "noop", reason: "planner artifact incomplete" });
    });

    it("returns noop when planner artifact is incomplete (missing touchedFiles)", () => {
      const artifact: PlannerArtifact = {
        goal: "Implement auth",
        acceptanceCriteria: ["login works"],
        touchedFiles: [],
        forbiddenFiles: [],
        testPlan: "Run tests",
        risks: [],
      };
      const action = decideFromArtifact(artifact, "planner", "planning");
      expect(action).toEqual({ type: "noop", reason: "planner artifact incomplete" });
    });
  });

  describe("plan_reviewer", () => {
    it("transitions to ready_for_execution when plan is approved", () => {
      const artifact: PlanReviewerArtifact = {
        verdict: "approved",
        scopeChanges: [],
        notes: ["looks good"],
      };
      const action = decideFromArtifact(artifact, "plan_reviewer", "plan_review");
      expect(action).toEqual({ type: "phase_transition", to: "ready_for_execution", reason: "plan approved, ready for execution" });
    });

    it("returns to planning when plan is rejected", () => {
      const artifact: PlanReviewerArtifact = {
        verdict: "rejected",
        scopeChanges: ["missing auth tests"],
        notes: [],
      };
      const action = decideFromArtifact(artifact, "plan_reviewer", "plan_review");
      expect(action).toEqual({ type: "phase_transition", to: "planning", reason: "plan rejected: missing auth tests" });
    });
  });

  describe("executor", () => {
    it("transitions to code_review when execution is complete", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: ["src/auth.ts"],
        changesSummary: "Added login",
        deviationsFromPlan: [],
        testsRun: ["auth tests"],
        remainingWork: [],
      };
      const action = decideFromArtifact(artifact, "executor", "executing");
      expect(action).toEqual({ type: "phase_transition", to: "code_review", reason: "execution complete" });
    });

    it("marks blocked when executor reports blockers", () => {
      // ExecutorArtifact does not have blockers — marking blocked via review queue path
      const action = decideFromReviewQueue(
        { verificationStatus: "blocked", blockers: ["missing API key"] },
        "executing",
      );
      expect(action).toEqual({ type: "mark_blocked", reason: "missing API key" });
    });

    it("returns noop when executor has remaining work but no files changed", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: [],
        changesSummary: "",
        deviationsFromPlan: [],
        testsRun: [],
        remainingWork: ["write tests"],
      };
      const action = decideFromArtifact(artifact, "executor", "executing");
      expect(action).toEqual({ type: "noop", reason: "executor has remaining work, staying in executing" });
    });

    it("transitions to code_review even with remaining work if files were changed", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: ["src/auth.ts"],
        changesSummary: "Added login",
        deviationsFromPlan: [],
        testsRun: [],
        remainingWork: ["update docs"],
      };
      const action = decideFromArtifact(artifact, "executor", "executing");
      expect(action).toEqual({ type: "phase_transition", to: "code_review", reason: "execution complete" });
    });
  });

  describe("reviewer", () => {
    it("transitions to integration when review is approved", () => {
      const artifact: ReviewerArtifact = {
        verdict: "approved",
        issuesFound: [],
        fixesMade: [],
        verificationStatus: "verified",
        mergeReadiness: "ready",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review");
      expect(action).toEqual({ type: "phase_transition", to: "integration", reason: "code review approved" });
    });

    it("returns to executing when changes are requested", () => {
      const artifact: ReviewerArtifact = {
        verdict: "changes_requested",
        issuesFound: ["null pointer risk"],
        fixesMade: [],
        verificationStatus: "needs_verification",
        mergeReadiness: "conditional",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review");
      expect(action).toEqual({ type: "phase_transition", to: "executing", reason: "changes requested: null pointer risk" });
    });

    it("returns to planning when review is rejected", () => {
      const artifact: ReviewerArtifact = {
        verdict: "rejected",
        issuesFound: ["security issue", "naming convention violated"],
        fixesMade: [],
        verificationStatus: "blocked",
        mergeReadiness: "blocked",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review");
      expect(action).toEqual({ type: "phase_transition", to: "planning", reason: "review rejected: security issue; naming convention violated" });
    });
  });
});

describe("decideFromReviewQueue", () => {
  it("marks blocked when verificationStatus is blocked", () => {
    const action = decideFromReviewQueue(
      { verificationStatus: "blocked", blockers: [] },
      "code_review",
    );
    expect(action).toEqual({ type: "mark_blocked", reason: "blocked in review queue" });
  });

  it("marks blocked when blockers are present", () => {
    const action = decideFromReviewQueue(
      { verificationStatus: "ready_for_review", blockers: ["external API down"] },
      "executing",
    );
    expect(action).toEqual({ type: "mark_blocked", reason: "external API down" });
  });

  it("returns noop when handoff is clear", () => {
    const action = decideFromReviewQueue(
      { verificationStatus: "ready_for_review", blockers: [] },
      "executing",
    );
    expect(action).toEqual({ type: "noop", reason: "review queue check — no action needed" });
  });

  it("returns noop when verificationStatus is needs_verification", () => {
    const action = decideFromReviewQueue(
      { verificationStatus: "needs_verification", blockers: [] },
      "integration",
    );
    expect(action).toEqual({ type: "noop", reason: "review queue check — no action needed" });
  });
});

describe("decideReassignment", () => {
  it("returns planner role for planning phase", () => {
    const result = decideReassignment("planning", null);
    expect(result).toEqual({ agentId: null, role: "planner" });
  });

  it("returns reviewer role for plan_review phase", () => {
    const result = decideReassignment("plan_review", null);
    expect(result).toEqual({ agentId: null, role: "reviewer" });
  });

  it("returns executor role for executing phase", () => {
    const result = decideReassignment("executing", null);
    expect(result).toEqual({ agentId: null, role: "executor" });
  });

  it("returns reviewer role for code_review phase", () => {
    const result = decideReassignment("code_review", null);
    expect(result).toEqual({ agentId: null, role: "reviewer" });
  });

  it("returns integrator role for integration phase", () => {
    const result = decideReassignment("integration", null);
    expect(result).toEqual({ agentId: null, role: "integrator" });
  });

  it("returns general role for triage phase", () => {
    const result = decideReassignment("triage", null);
    expect(result).toEqual({ agentId: null, role: "general" });
  });

  it("returns general role for done phase", () => {
    const result = decideReassignment("done", null);
    expect(result).toEqual({ agentId: null, role: "general" });
  });
});