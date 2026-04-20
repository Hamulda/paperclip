import { describe, expect, it, vi } from "vitest";
import { summarizeHeartbeatRunListResultJson } from "../services/session-compaction.js";

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps string fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when all projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });

  it("filters out non-finite cost values", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Done",
        totalCostUsd: "not-a-number",
        costUsd: "",
        costUsdCamel: "0",
      }),
    ).toEqual({
      summary: "Done",
      costUsd: 0,
    });
  });
});