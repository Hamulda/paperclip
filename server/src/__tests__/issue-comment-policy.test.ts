import { describe, expect, it, vi } from "vitest";
import { finalizeIssueCommentPolicy, findRunIssueComment, patchRunIssueCommentStatus, enqueueMissingIssueCommentRetry } from "../services/issue-comment-policy.js";
import type { Db } from "@paperclipai/db";

describe("finalizeIssueCommentPolicy", () => {
  it("returns not_applicable when run has no issueId in context", async () => {
    const mockDb = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "run-1" }]),
    } as unknown as Db;

    const mockRun = {
      id: "run-1",
      companyId: "company-1",
      contextSnapshot: {},
      issueCommentStatus: "satisfied",
    } as any;

    const mockAgent = { id: "agent-1", name: "Test", companyId: "company-1", adapterType: "claude_local" } as any;

    const result = await finalizeIssueCommentPolicy(mockDb, mockRun, mockAgent, null, {
      appendRunEvent: vi.fn(),
      nextRunEventSeq: vi.fn().mockResolvedValue(1),
    });

    expect(result.outcome).toBe("not_applicable");
    expect(result.queuedRun).toBeNull();
  });

  it("returns not_applicable when context has no issueId even if run status is retry_queued", async () => {
    const mockDb = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "run-1" }]),
    } as unknown as Db;

    const mockRun = {
      id: "run-1",
      companyId: "company-1",
      contextSnapshot: {},
      issueCommentStatus: "retry_queued",
    } as any;

    const mockAgent = { id: "agent-1", name: "Test", companyId: "company-1", adapterType: "claude_local" } as any;

    const result = await finalizeIssueCommentPolicy(mockDb, mockRun, mockAgent, null, {
      appendRunEvent: vi.fn(),
      nextRunEventSeq: vi.fn().mockResolvedValue(1),
    });

    expect(result.outcome).toBe("not_applicable");
  });
});

describe("findRunIssueComment", () => {
  it("returns null when no comment exists for run/issue", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const result = await findRunIssueComment(mockDb, "run-1", "company-1", "issue-1");
    expect(result).toBeNull();
  });
});

describe("patchRunIssueCommentStatus", () => {
  it("calls db.update with correct patch", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "run-1", issueCommentStatus: "satisfied" }]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockDb = { update: mockUpdate } as unknown as Db;

    await patchRunIssueCommentStatus(mockDb, "run-1", { issueCommentStatus: "satisfied" });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
  });
});