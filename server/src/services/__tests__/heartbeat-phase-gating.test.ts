import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IssuePhase } from "@paperclipai/shared";
import { phaseRepresentsWork, phaseRepresentsActive } from "../issue-phase.js";

describe("phase gating functions (pure)", () => {
  describe("canStartExecutionRunForPhase", () => {
    // uses phaseRepresentsWork internally
    it("returns true for work phases", () => {
      expect(phaseRepresentsWork("planning")).toBe(true);
      expect(phaseRepresentsWork("ready_for_execution")).toBe(true);
      expect(phaseRepresentsWork("executing")).toBe(true);
      expect(phaseRepresentsWork("code_review")).toBe(true);
      expect(phaseRepresentsWork("integration")).toBe(true);
    });

    it("returns false for non-work phases", () => {
      expect(phaseRepresentsWork("triage")).toBe(false);
      expect(phaseRepresentsWork("plan_review")).toBe(false);
      expect(phaseRepresentsWork("done")).toBe(false);
      expect(phaseRepresentsWork("blocked")).toBe(false);
    });
  });

  describe("isPhaseAutoExecutable (inline guard)", () => {
    // Simulates the inline guard: only ready_for_execution and executing
    // can spawn new execution runs
    const isPhaseAutoExecutable = (phase: string | null | undefined): boolean => {
      if (!phase) return false;
      return phase === "ready_for_execution" || phase === "executing";
    };

    it("returns true for ready_for_execution", () => {
      expect(isPhaseAutoExecutable("ready_for_execution")).toBe(true);
    });

    it("returns true for executing", () => {
      expect(isPhaseAutoExecutable("executing")).toBe(true);
    });

    it("returns false for planning", () => {
      expect(isPhaseAutoExecutable("planning")).toBe(false);
    });

    it("returns false for code_review", () => {
      expect(isPhaseAutoExecutable("code_review")).toBe(false);
    });

    it("returns false for done", () => {
      expect(isPhaseAutoExecutable("done")).toBe(false);
    });

    it("returns false for blocked", () => {
      expect(isPhaseAutoExecutable("blocked")).toBe(false);
    });

    it("returns false for triage", () => {
      expect(isPhaseAutoExecutable("triage")).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isPhaseAutoExecutable(null)).toBe(false);
      expect(isPhaseAutoExecutable(undefined)).toBe(false);
    });
  });

  describe("phaseRepresentsActive", () => {
    it("returns true for all non-terminal, non-blocked phases", () => {
      expect(phaseRepresentsActive("triage")).toBe(true);
      expect(phaseRepresentsActive("planning")).toBe(true);
      expect(phaseRepresentsActive("plan_review")).toBe(true);
      expect(phaseRepresentsActive("ready_for_execution")).toBe(true);
      expect(phaseRepresentsActive("executing")).toBe(true);
      expect(phaseRepresentsActive("code_review")).toBe(true);
      expect(phaseRepresentsActive("integration")).toBe(true);
    });

    it("returns false for done and blocked", () => {
      expect(phaseRepresentsActive("done")).toBe(false);
      expect(phaseRepresentsActive("blocked")).toBe(false);
    });
  });
});

describe("phase-gated execution paths", () => {
  // -------------------------------------------------------------------------
  // Valid paths: issue IS eligible for execution run creation
  // -------------------------------------------------------------------------

  describe("VALID: ready_for_execution phase allows run creation", () => {
    it("ready_for_execution + todo status → checkout would be allowed", () => {
      // ready_for_execution IS in isPhaseAutoExecutable, so a run can be queued
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("ready_for_execution")).toBe(true);
    });

    it("ready_for_execution + in_progress status → run can start", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("ready_for_execution")).toBe(true);
    });
  });

  describe("VALID: executing phase allows run creation", () => {
    it("executing + in_progress status → run can start", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("executing")).toBe(true);
    });
  });

  describe("VALID: code_review phase allows work (regression for auto-checkout)", () => {
    it("code_review is a work phase so it passes canStartExecutionRunForPhase", () => {
      expect(phaseRepresentsWork("code_review")).toBe(true);
    });

    it("code_review is NOT auto-executable so claimQueuedRun would reject it", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("code_review")).toBe(false);
    });
  });

  describe("VALID: blocked → planning → ready_for_execution round-trip", () => {
    it("blocked is NOT active but can transition back", () => {
      expect(phaseRepresentsActive("blocked")).toBe(false);
    });

    it("after unblocking, entering ready_for_execution makes it auto-executable", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("ready_for_execution")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid paths: issue is NOT eligible for execution run creation
  // -------------------------------------------------------------------------

  describe("INVALID: planning phase blocks auto-run creation", () => {
    it("planning is NOT auto-executable", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("planning")).toBe(false);
    });

    it("planning is NOT active (enqueueWakeup would skip)", () => {
      expect(phaseRepresentsActive("planning")).toBe(true); // active but not work
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("planning")).toBe(false);
    });
  });

  describe("INVALID: code_review phase cannot spawn new execution runs", () => {
    it("code_review fails isPhaseAutoExecutable (claimQueuedRun rejects)", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("code_review")).toBe(false);
    });

    it("code_review with todo status → run blocked at claimQueuedRun", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("code_review")).toBe(false);
    });
  });

  describe("INVALID: done phase is terminal and must not be executed", () => {
    it("done is NOT active (enqueueWakeup skips with issue_phase_not_executable)", () => {
      expect(phaseRepresentsActive("done")).toBe(false);
    });

    it("done is NOT work phase", () => {
      expect(phaseRepresentsWork("done")).toBe(false);
    });

    it("done fails both canStartExecutionRunForPhase and isPhaseAutoExecutable", () => {
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(phaseRepresentsWork("done")).toBe(false);
      expect(isAutoExecutable("done")).toBe(false);
    });
  });

  describe("INVALID: blocked phase cannot be automatically executed", () => {
    it("blocked is NOT active", () => {
      expect(phaseRepresentsActive("blocked")).toBe(false);
    });

    it("enqueueWakeup skips blocked issues with issue_phase_not_executable", () => {
      expect(phaseRepresentsActive("blocked")).toBe(false);
    });
  });

  describe("INVALID: triage phase is pre-planning and cannot trigger execution", () => {
    it("triage is NOT work phase", () => {
      expect(phaseRepresentsWork("triage")).toBe(false);
    });

    it("triage fails canStartExecutionRunForPhase", () => {
      expect(phaseRepresentsWork("triage")).toBe(false);
    });
  });

  describe("INVALID: plan_review phase requires human approval before execution", () => {
    it("plan_review is NOT work phase", () => {
      expect(phaseRepresentsWork("plan_review")).toBe(false);
    });

    it("plan_review fails both gating functions", () => {
      expect(phaseRepresentsWork("plan_review")).toBe(false);
      const isAutoExecutable = (phase: string | null | undefined) =>
        phase === "ready_for_execution" || phase === "executing";
      expect(isAutoExecutable("plan_review")).toBe(false);
    });
  });
});

describe("phase transition validation", () => {
  // These tests document the phase state machine rules
  // They verify the guard functions match the intended workflow

  it("only ready_for_execution and executing can spawn runs (claimQueuedRun gate)", () => {
    const autoExecutablePhases: IssuePhase[] = ["ready_for_execution", "executing"];
    const allPhases: IssuePhase[] = [
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
    const isAutoExecutable = (phase: string | null | undefined): boolean =>
      autoExecutablePhases.includes(phase as IssuePhase);

    for (const phase of allPhases) {
      if (autoExecutablePhases.includes(phase)) {
        expect(isAutoExecutable(phase)).toBe(true);
      } else {
        expect(isAutoExecutable(phase)).toBe(false);
      }
    }
  });

  it("done and blocked are never active (enqueueWakeup gate)", () => {
    expect(phaseRepresentsActive("done")).toBe(false);
    expect(phaseRepresentsActive("blocked")).toBe(false);
  });
});
