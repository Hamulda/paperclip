import { describe, expect, it } from "vitest";
import {
  assertPhaseTransition,
  applyPhaseSideEffects,
  getPhaseLabel,
  getNextPhaseOnStatusChange,
  isIssuePhase,
  phaseRepresentsActive,
  phaseRepresentsTerminal,
  phaseRepresentsWork,
  sortByPhase,
} from "../issue-phase.ts";
import type { IssuePhase } from "@paperclipai/shared";

describe("assertPhaseTransition", () => {
  it("allows no-op transition (same phase)", () => {
    expect(() => assertPhaseTransition("triage", "triage")).not.toThrow();
  });

  it("allows null/undefined from (new issue)", () => {
    expect(() => assertPhaseTransition(null, "triage")).not.toThrow();
    expect(() => assertPhaseTransition(undefined, "planning")).not.toThrow();
  });

  it("allows null/undefined to (clearing phase)", () => {
    expect(() => assertPhaseTransition("triage", null)).not.toThrow();
    expect(() => assertPhaseTransition("executing", undefined)).not.toThrow();
  });

  it("allows valid forward transitions", () => {
    expect(() => assertPhaseTransition("triage", "planning")).not.toThrow();
    expect(() => assertPhaseTransition("planning", "plan_review")).not.toThrow();
    expect(() => assertPhaseTransition("plan_review", "ready_for_execution")).not.toThrow();
    expect(() => assertPhaseTransition("ready_for_execution", "executing")).not.toThrow();
    expect(() => assertPhaseTransition("executing", "code_review")).not.toThrow();
    expect(() => assertPhaseTransition("code_review", "integration")).not.toThrow();
    expect(() => assertPhaseTransition("integration", "done")).not.toThrow();
  });

  it("allows plan_review → planning (reject plan back to planning)", () => {
    expect(() => assertPhaseTransition("plan_review", "planning")).not.toThrow();
  });

  it("allows code_review → executing (request changes back to executor)", () => {
    expect(() => assertPhaseTransition("code_review", "executing")).not.toThrow();
  });

  it("allows blocked → any non-terminal phase", () => {
    expect(() => assertPhaseTransition("blocked", "triage")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "planning")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "plan_review")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "ready_for_execution")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "executing")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "code_review")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "integration")).not.toThrow();
    expect(() => assertPhaseTransition("blocked", "done")).not.toThrow();
  });

  it("rejects invalid forward transitions", () => {
    expect(() => assertPhaseTransition("triage", "executing")).toThrow();
    expect(() => assertPhaseTransition("triage", "done")).toThrow();
    expect(() => assertPhaseTransition("planning", "executing")).toThrow();
    expect(() => assertPhaseTransition("plan_review", "integration")).toThrow();
    expect(() => assertPhaseTransition("ready_for_execution", "done")).toThrow();
    expect(() => assertPhaseTransition("executing", "done")).toThrow();
  });

  it("rejects backward transitions not in allowed list", () => {
    expect(() => assertPhaseTransition("ready_for_execution", "planning")).toThrow();
    expect(() => assertPhaseTransition("integration", "code_review")).toThrow();
    expect(() => assertPhaseTransition("code_review", "planning")).toThrow();
  });

  it("rejects transitions from done", () => {
    expect(() => assertPhaseTransition("done", "triage")).toThrow();
    expect(() => assertPhaseTransition("done", "planning")).toThrow();
  });

  it("rejects unknown phase values", () => {
    expect(() => assertPhaseTransition("triage", "xyz" as IssuePhase)).toThrow();
    expect(() => assertPhaseTransition(null, "xyz" as IssuePhase)).toThrow();
  });
});

describe("applyPhaseSideEffects", () => {
  it("sets startedAt when entering ready_for_execution", () => {
    const patch: Record<string, unknown> = {};
    const result = applyPhaseSideEffects("ready_for_execution", patch);
    expect(result["startedAt"]).toBeInstanceOf(Date);
  });

  it("does not set startedAt for executing (only ready_for_execution triggers it)", () => {
    const patch: Record<string, unknown> = {};
    const result = applyPhaseSideEffects("executing", patch);
    expect(result["startedAt"]).toBeUndefined();
  });

  it("does not overwrite existing startedAt", () => {
    const existing = new Date("2025-01-01");
    const patch: Record<string, unknown> = { startedAt: existing };
    const result = applyPhaseSideEffects("ready_for_execution", patch);
    expect(result["startedAt"]).toBe(existing);
  });

  it("sets completedAt when entering done", () => {
    const patch: Record<string, unknown> = {};
    const result = applyPhaseSideEffects("done", patch);
    expect(result["completedAt"]).toBeInstanceOf(Date);
  });

  it("does not overwrite existing completedAt", () => {
    const existing = new Date("2025-01-01");
    const patch: Record<string, unknown> = { completedAt: existing };
    const result = applyPhaseSideEffects("done", patch);
    expect(result["completedAt"]).toBe(existing);
  });

  it("returns unchanged patch for null/undefined phase", () => {
    const patch: Record<string, unknown> = { startedAt: new Date() };
    expect(applyPhaseSideEffects(null, patch)).toBe(patch);
    expect(applyPhaseSideEffects(undefined, patch)).toBe(patch);
  });
});

describe("isIssuePhase", () => {
  it("returns true for valid phases", () => {
    expect(isIssuePhase("triage")).toBe(true);
    expect(isIssuePhase("planning")).toBe(true);
    expect(isIssuePhase("plan_review")).toBe(true);
    expect(isIssuePhase("ready_for_execution")).toBe(true);
    expect(isIssuePhase("executing")).toBe(true);
    expect(isIssuePhase("code_review")).toBe(true);
    expect(isIssuePhase("integration")).toBe(true);
    expect(isIssuePhase("done")).toBe(true);
    expect(isIssuePhase("blocked")).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isIssuePhase("backlog")).toBe(false);
    expect(isIssuePhase("in_progress")).toBe(false);
    expect(isIssuePhase("done-ish")).toBe(false);
    expect(isIssuePhase("")).toBe(false);
    expect(isIssuePhase(null)).toBe(false);
    expect(isIssuePhase(undefined)).toBe(false);
    expect(isIssuePhase(123 as unknown as string)).toBe(false);
  });
});

describe("phaseRepresentsWork", () => {
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

describe("phaseRepresentsTerminal", () => {
  it("returns true only for done", () => {
    expect(phaseRepresentsTerminal("done")).toBe(true);
    expect(phaseRepresentsTerminal("blocked")).toBe(false);
    expect(phaseRepresentsTerminal("integration")).toBe(false);
    expect(phaseRepresentsTerminal("triage")).toBe(false);
  });
});

describe("phaseRepresentsActive", () => {
  it("returns true for non-terminal, non-blocked phases", () => {
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

describe("getNextPhaseOnStatusChange", () => {
  it("returns done when status becomes done", () => {
    expect(getNextPhaseOnStatusChange("executing", "in_progress", "done")).toBe("done");
  });

  it("returns blocked when status becomes blocked", () => {
    expect(getNextPhaseOnStatusChange("executing", "in_progress", "blocked")).toBe("blocked");
  });

  it("returns triage when status becomes in_progress with no current phase", () => {
    expect(getNextPhaseOnStatusChange(null, "backlog", "in_progress")).toBe("triage");
    expect(getNextPhaseOnStatusChange(undefined, "backlog", "in_progress")).toBe("triage");
  });

  it("preserves current phase when changing to in_progress", () => {
    expect(getNextPhaseOnStatusChange("code_review", "in_progress", "in_progress")).toBe("code_review");
    expect(getNextPhaseOnStatusChange("planning", "todo", "in_progress")).toBe("planning");
  });

  it("returns current phase when status changes to backlog", () => {
    expect(getNextPhaseOnStatusChange("executing", "in_progress", "backlog")).toBe("executing");
  });
});

describe("sortByPhase", () => {
  it("sorts phases in defined order", () => {
    const phases: IssuePhase[] = ["done", "triage", "executing", "planning", "blocked"];
    const sorted = [...phases].sort(sortByPhase);
    expect(sorted[0]).toBe("triage");
    expect(sorted[1]).toBe("planning");
    expect(sorted[2]).toBe("executing");
    expect(sorted[3]).toBe("done");
    expect(sorted[4]).toBe("blocked");
  });

  it("is consistent (sorting twice returns same result)", () => {
    const phases: IssuePhase[] = ["blocked", "triage", "done", "executing"];
    const first = [...phases].sort(sortByPhase);
    const second = [...first].sort(sortByPhase);
    expect(first).toEqual(second);
  });
});

describe("getPhaseLabel", () => {
  it("returns human-readable labels", () => {
    expect(getPhaseLabel("triage")).toBe("Triage");
    expect(getPhaseLabel("planning")).toBe("Planning");
    expect(getPhaseLabel("plan_review")).toBe("Plan Review");
    expect(getPhaseLabel("ready_for_execution")).toBe("Ready");
    expect(getPhaseLabel("executing")).toBe("Executing");
    expect(getPhaseLabel("code_review")).toBe("Code Review");
    expect(getPhaseLabel("integration")).toBe("Integration");
    expect(getPhaseLabel("done")).toBe("Done");
    expect(getPhaseLabel("blocked")).toBe("Blocked");
  });
});