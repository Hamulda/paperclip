import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { issueArtifactService } from "../issue-artifacts.js";
import { issueArtifacts } from "@paperclipai/db";
import type { CreateIssueArtifact } from "@paperclipai/shared";

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
} as unknown as Db;

describe("issueArtifactService", () => {
  describe("listForIssue", () => {
    it("returns empty array when no artifacts exist", async () => {
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const result = await service.listForIssue("issue-1");
      expect(result).toEqual([]);
    });

    it("maps rows to IssueArtifact correctly", async () => {
      const row = {
        id: "artifact-1",
        companyId: "company-1",
        issueId: "issue-1",
        artifactType: "planner",
        status: "published",
        actorAgentId: "agent-1",
        actorUserId: null,
        createdByRunId: "run-1",
        summary: "Test plan",
        metadata: { goal: "Implement X", acceptanceCriteria: ["A", "B"], touchedFiles: [], forbiddenFiles: [], testPlan: "Run tests", risks: [] },
        createdAt: new Date("2026-04-19T10:00:00Z"),
        updatedAt: new Date("2026-04-19T10:00:00Z"),
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([row]),
          }),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const result = await service.listForIssue("issue-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("artifact-1");
      expect(result[0].artifactType).toBe("planner");
      expect(result[0].metadata).toBeDefined();
    });
  });

  describe("create", () => {
    it("validates and creates artifact with correct fields", async () => {
      const createdRow = {
        id: "artifact-2",
        companyId: "company-1",
        issueId: "issue-1",
        artifactType: "executor",
        status: "published",
        actorAgentId: "agent-1",
        actorUserId: null,
        createdByRunId: null,
        summary: null,
        metadata: { filesChanged: ["a.ts"], changesSummary: "Changed A", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdRow]),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const input: CreateIssueArtifact = {
        issueId: "11111111-1111-1111-1111-111111111111",
        artifactType: "executor",
        summary: null,
        metadata: {
          artifactType: "executor",
          filesChanged: ["a.ts"],
          changesSummary: "Changed A",
          deviationsFromPlan: [],
          testsRun: [],
          remainingWork: [],
        },
      };

      const result = await service.create("company-1", input);

      expect(result.id).toBe("artifact-2");
      expect(result.artifactType).toBe("executor");
    });
  });

  describe("supersede", () => {
    it("updates published artifacts of same type to superseded", async () => {
      const mockUpdate = vi.fn().mockResolvedValue([]);
      vi.mocked(mockDb.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      await service.supersede("issue-1", "planner");

      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});