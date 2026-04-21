import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  decideFromArtifact,
  decideFromReviewQueue,
  decideReassignment,
  resolveBlockedTransition,
  isArtifactPhaseCompatible,
  checkBounceLimit,
  checkReworkLimit,
  recordPhaseTransition,
  clearTracking,
} from "../swarm-orchestrator.ts";
import type { PlannerArtifact, PlanReviewerArtifact, ExecutorArtifact, ReviewerArtifact } from "@paperclipai/shared";

const ISSUE = "test-issue-1";

beforeEach(() => {
  clearTracking(ISSUE);
});

afterEach(() => {
  clearTracking(ISSUE);
});

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
      const action = decideFromArtifact(artifact, "planner", "planning", ISSUE);
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
      const action = decideFromArtifact(artifact, "planner", "planning", ISSUE);
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
      const action = decideFromArtifact(artifact, "planner", "planning", ISSUE);
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
      const action = decideFromArtifact(artifact, "planner", "planning", ISSUE);
      expect(action).toEqual({ type: "noop", reason: "planner artifact incomplete" });
    });

    it("records rework count for planning phase", () => {
      const artifact: PlannerArtifact = {
        goal: "auth",
        acceptanceCriteria: ["works"],
        touchedFiles: ["a.ts"],
        forbiddenFiles: [],
        testPlan: "t",
        risks: [],
      };
      expect(checkReworkLimit(ISSUE, "planning")).toBe(false);
      decideFromArtifact(artifact, "planner", "planning", ISSUE);
      expect(checkReworkLimit(ISSUE, "planning")).toBe(false);
      decideFromArtifact(artifact, "planner", "planning", ISSUE);
      expect(checkReworkLimit(ISSUE, "planning")).toBe(true);
    });
  });

  describe("plan_reviewer", () => {
    it("transitions to ready_for_execution when plan is approved", () => {
      const artifact: PlanReviewerArtifact = { verdict: "approved", scopeChanges: [], notes: ["looks good"] };
      const action = decideFromArtifact(artifact, "plan_reviewer", "plan_review", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "ready_for_execution", reason: "plan approved, ready for execution" });
    });

    it("returns to planning when plan is rejected", () => {
      const artifact: PlanReviewerArtifact = { verdict: "rejected", scopeChanges: ["missing auth tests"], notes: [] };
      const action = decideFromArtifact(artifact, "plan_reviewer", "plan_review", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "planning", reason: "plan rejected: missing auth tests" });
    });
  });

  describe("executor", () => {
    it("transitions to code_review when execution is complete", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: ["src/auth.ts"], changesSummary: "Added login",
        deviationsFromPlan: [], testsRun: ["auth tests"], remainingWork: [],
      };
      const action = decideFromArtifact(artifact, "executor", "executing", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "code_review", reason: "execution complete" });
    });

    it("marks blocked when executor reports blockers via review queue", () => {
      const action = decideFromReviewQueue({ verificationStatus: "blocked", blockers: ["missing API key"] }, "executing");
      expect(action).toEqual({ type: "mark_blocked", reason: "missing API key" });
    });

    it("returns noop when executor has remaining work but no files changed", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: [], changesSummary: "",
        deviationsFromPlan: [], testsRun: [], remainingWork: ["write tests"],
      };
      const action = decideFromArtifact(artifact, "executor", "executing", ISSUE);
      expect(action).toEqual({ type: "noop", reason: "executor has remaining work, staying in executing" });
    });

    it("transitions to code_review even with remaining work if files were changed", () => {
      const artifact: ExecutorArtifact = {
        filesChanged: ["src/auth.ts"], changesSummary: "Added login",
        deviationsFromPlan: [], testsRun: [], remainingWork: ["update docs"],
      };
      const action = decideFromArtifact(artifact, "executor", "executing", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "code_review", reason: "execution complete" });
    });
  });

  describe("reviewer", () => {
    it("transitions to integration when review is approved", () => {
      const artifact: ReviewerArtifact = {
        verdict: "approved", issuesFound: [], fixesMade: [],
        verificationStatus: "verified", mergeReadiness: "ready",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "integration", reason: "code review approved" });
    });

    it("returns to executing when changes are requested", () => {
      const artifact: ReviewerArtifact = {
        verdict: "changes_requested", issuesFound: ["null pointer risk"],
        fixesMade: [], verificationStatus: "needs_verification", mergeReadiness: "conditional",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "executing", reason: "changes requested: null pointer risk" });
    });

    it("returns to planning when review is rejected", () => {
      const artifact: ReviewerArtifact = {
        verdict: "rejected", issuesFound: ["security issue", "naming convention violated"],
        fixesMade: [], verificationStatus: "blocked", mergeReadiness: "blocked",
      };
      const action = decideFromArtifact(artifact, "reviewer", "code_review", ISSUE);
      expect(action).toEqual({ type: "phase_transition", to: "planning", reason: "review rejected: security issue; naming convention violated" });
    });
  });
});

describe("isArtifactPhaseCompatible", () => {
  it("returns true when artifact type matches phase", () => {
    expect(isArtifactPhaseCompatible("planner", "planning")).toBe(true);
    expect(isArtifactPhaseCompatible("plan_reviewer", "plan_review")).toBe(true);
    expect(isArtifactPhaseCompatible("executor", "executing")).toBe(true);
    expect(isArtifactPhaseCompatible("reviewer", "code_review")).toBe(true);
  });

  it("returns false when artifact type does not match phase", () => {
    expect(isArtifactPhaseCompatible("executor", "planning")).toBe(false);
    expect(isArtifactPhaseCompatible("planner", "code_review")).toBe(false);
    expect(isArtifactPhaseCompatible("reviewer", "executing")).toBe(false);
    expect(isArtifactPhaseCompatible("plan_reviewer", "integration")).toBe(false);
  });
});

describe("artifact-phase compatibility guard", () => {
  it("returns noop when executor artifact arrives during planning", () => {
    const artifact: ExecutorArtifact = {
      filesChanged: ["a.ts"], changesSummary: "x",
      deviationsFromPlan: [], testsRun: [], remainingWork: [],
    };
    const action = decideFromArtifact(artifact, "executor", "planning", ISSUE);
    expect(action.type).toBe("noop");
    expect((action as any).reason).toContain("not compatible with current phase");
  });

  it("returns noop when planner artifact arrives during code_review", () => {
    const artifact: PlannerArtifact = {
      goal: "auth", acceptanceCriteria: ["x"], touchedFiles: ["a.ts"],
      forbiddenFiles: [], testPlan: "t", risks: [],
    };
    const action = decideFromArtifact(artifact, "planner", "code_review", ISSUE);
    expect(action.type).toBe("noop");
    expect((action as any).reason).toContain("not compatible with current phase");
  });
});

describe("bounce / loop detection", () => {
  it("does not block before bounce limit is reached", () => {
    const planner: PlannerArtifact = {
      goal: "auth", acceptanceCriteria: ["x"], touchedFiles: ["a.ts"],
      forbiddenFiles: [], testPlan: "t", risks: [],
    };
    const reviewer: PlanReviewerArtifact = {
      verdict: "rejected", scopeChanges: ["x"], notes: [],
    };
    // Simulate: planning -> plan_review -> planning (bounce 1)
    recordPhaseTransition(ISSUE, "planning", "plan_review");
    recordPhaseTransition(ISSUE, "plan_review", "planning");
    // Still under limit — first rework should work
    const a = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(a.type).not.toBe("mark_blocked");
  });

  it("marks blocked when bounce limit (3) is exceeded", () => {
    const planner: PlannerArtifact = {
      goal: "auth", acceptanceCriteria: ["x"], touchedFiles: ["a.ts"],
      forbiddenFiles: [], testPlan: "t", risks: [],
    };
    const reviewer: PlanReviewerArtifact = {
      verdict: "rejected", scopeChanges: ["x"], notes: [],
    };
    // Simulate 3 bounces (back-and-forth cycles) before the next planner artifact
    recordPhaseTransition(ISSUE, "planning", "plan_review");
    recordPhaseTransition(ISSUE, "plan_review", "planning"); // bounce 1
    recordPhaseTransition(ISSUE, "planning", "plan_review");
    recordPhaseTransition(ISSUE, "plan_review", "planning"); // bounce 2
    recordPhaseTransition(ISSUE, "planning", "plan_review");
    recordPhaseTransition(ISSUE, "plan_review", "planning"); // bounce 3
    // 4th planner arrival should trigger bounce limit
    const action = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(action.type).toBe("mark_blocked");
    expect((action as any).reason).toContain("bounce limit");
  });
});

describe("rework budget per phase", () => {
  it("allows 2 rework iterations per phase", () => {
    const planner: PlannerArtifact = {
      goal: "auth", acceptanceCriteria: ["x"], touchedFiles: ["a.ts"],
      forbiddenFiles: [], testPlan: "t", risks: [],
    };
    const a1 = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(a1.type).toBe("phase_transition");
    const a2 = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(a2.type).toBe("phase_transition");
    const a3 = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(a3.type).toBe("mark_blocked");
    expect((a3 as any).reason).toContain("rework budget exhausted");
  });

  it("rework budgets are phase-specific", () => {
    const planner: PlannerArtifact = {
      goal: "auth", acceptanceCriteria: ["x"], touchedFiles: ["a.ts"],
      forbiddenFiles: [], testPlan: "t", risks: [],
    };
    const reviewer: PlanReviewerArtifact = {
      verdict: "approved", scopeChanges: [], notes: [],
    };
    // Exhaust planning budget
    decideFromArtifact(planner, "planner", "planning", ISSUE);
    decideFromArtifact(planner, "planner", "planning", ISSUE);
    const blockedPlanning = decideFromArtifact(planner, "planner", "planning", ISSUE);
    expect(blockedPlanning.type).toBe("mark_blocked");
    // plan_review budget is independent — should work
    const pr = decideFromArtifact(reviewer, "plan_reviewer", "plan_review", ISSUE);
    expect(pr.type).toBe("phase_transition");
  });
});

describe("resolveBlockedTransition", () => {
  it("unblocks when verification is ready and no blockers", () => {
    const action = resolveBlockedTransition(ISSUE, {
      verificationStatus: "ready_for_review",
      blockers: [],
    });
    expect(action.type).toBe("phase_transition");
    expect((action as any).reason).toBe("blockers cleared, resuming");
  });

  it("stays blocked when blockers remain", () => {
    const action = resolveBlockedTransition(ISSUE, {
      verificationStatus: "ready_for_review",
      blockers: ["external API down"],
    });
    expect(action.type).toBe("mark_blocked");
    expect((action as any).reason).toBe("external API down");
  });

  it("stays blocked when verification status is not ready", () => {
    const action = resolveBlockedTransition(ISSUE, {
      verificationStatus: "blocked",
      blockers: [],
    });
    expect(action.type).toBe("mark_blocked");
  });
});

describe("decideFromReviewQueue", () => {
  it("marks blocked when verificationStatus is blocked", () => {
    const action = decideFromReviewQueue({ verificationStatus: "blocked", blockers: [] }, "code_review");
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
    const action = decideFromReviewQueue({ verificationStatus: "ready_for_review", blockers: [] }, "executing");
    expect(action).toEqual({ type: "noop", reason: "review queue check — no action needed" });
  });

  it("returns noop when verificationStatus is needs_verification", () => {
    const action = decideFromReviewQueue({ verificationStatus: "needs_verification", blockers: [] }, "integration");
    expect(action).toEqual({ type: "noop", reason: "review queue check — no action needed" });
  });
});

describe("decideReassignment", () => {
  it("returns planner role for planning phase", () => {
    expect(decideReassignment("planning", null)).toEqual({ agentId: null, role: "planner" });
  });
  it("returns reviewer role for plan_review phase", () => {
    expect(decideReassignment("plan_review", null)).toEqual({ agentId: null, role: "reviewer" });
  });
  it("returns executor role for executing phase", () => {
    expect(decideReassignment("executing", null)).toEqual({ agentId: null, role: "executor" });
  });
  it("returns reviewer role for code_review phase", () => {
    expect(decideReassignment("code_review", null)).toEqual({ agentId: null, role: "reviewer" });
  });
  it("returns integrator role for integration phase", () => {
    expect(decideReassignment("integration", null)).toEqual({ agentId: null, role: "integrator" });
  });
  it("returns general role for triage phase", () => {
    expect(decideReassignment("triage", null)).toEqual({ agentId: null, role: "general" });
  });
  it("returns general role for done phase", () => {
    expect(decideReassignment("done", null)).toEqual({ agentId: null, role: "general" });
  });
});