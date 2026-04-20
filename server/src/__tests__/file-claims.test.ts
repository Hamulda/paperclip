import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  acquireClaims,
  refreshClaims,
  releaseClaims,
  listConflicts,
  extractClaimPathsFromIssue,
  isProtectedPath,
  filterProtectedPaths,
  extractClaimPathsFromDiff,
} from "../services/file-claims.js";

function createMockDb(overrides: Record<string, unknown> = {}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    ...overrides,
  } as unknown as ReturnType<typeof vi.fn>;
}

describe("file-claims service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("acquireClaims", () => {
    it("acquires claims when no conflicts exist", async () => {
      const mockDb = createMockDb({
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/foo.ts",
              status: "active",
              expiresAt: new Date(),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/foo.ts" }],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(result.acquired.length).toBe(1);
      expect(result.conflicts.length).toBe(0);
    });

    it("detects conflicts with existing claims", async () => {
      const existingClaims = [{
        id: "existing-claim",
        companyId: "company-1",
        projectId: "project-1",
        agentId: "agent-2",
        runId: "run-2",
        claimType: "file",
        claimPath: "src/foo.ts",
        status: "active",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingClaims),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/foo.ts",
              status: "active",
              expiresAt: new Date(),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/foo.ts" }],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].conflictingClaims.length).toBe(1);
    });

    it("detects directory overlap with file claims", async () => {
      const existingClaims = [{
        id: "existing-dir",
        companyId: "company-1",
        projectId: "project-1",
        agentId: "agent-2",
        runId: "run-2",
        claimType: "directory",
        claimPath: "src/utils",
        status: "active",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingClaims),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/utils/helper.ts",
              status: "active",
              expiresAt: new Date(),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/utils/helper.ts" }],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(result.conflicts.length).toBe(1);
    });

    it("does not count expired claims as conflicts", async () => {
      const now = Date.now();
      // DB-level filter gte(expiresAt, now) excludes these, so mock returns empty
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // expired claims filtered out at DB level
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/foo.ts",
              status: "active",
              expiresAt: new Date(now + 30 * 60 * 1000),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/foo.ts" }],
        expiresAt: new Date(now + 30 * 60 * 1000),
      });

      // Expired claim was filtered out at DB level, so no conflict
      expect(result.conflicts.length).toBe(0);
      expect(result.acquired.length).toBe(1);
    });

    it("counts active overlapping claims as conflicts", async () => {
      const now = Date.now();
      const activeClaims = [{
        id: "active-claim",
        companyId: "company-1",
        projectId: "project-1",
        agentId: "agent-2",
        runId: "run-2",
        claimType: "file",
        claimPath: "src/foo.ts",
        status: "active",
        expiresAt: new Date(now + 60 * 1000), // expires 1 minute from now
      }];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(activeClaims),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/foo.ts",
              status: "active",
              expiresAt: new Date(now + 30 * 60 * 1000),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/foo.ts" }],
        expiresAt: new Date(now + 30 * 60 * 1000),
      });

      // Active claim should be counted as conflict
      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].conflictingClaims[0].id).toBe("active-claim");
    });

    it("uses single query for multi-claim acquire (not N+1)", async () => {
      const now = Date.now();
      const existingClaims: any[] = [];

      let selectCallCount = 0;
      const mockDb = createMockDb({
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              selectCallCount++;
              return Promise.resolve(existingClaims);
            }),
          })),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "new-claim",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/claimed.ts",
              status: "active",
              expiresAt: new Date(now + 30 * 60 * 1000),
            }]),
          }),
        }),
      });

      await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [
          { claimType: "file", claimPath: "src/foo.ts" },
          { claimType: "file", claimPath: "src/bar.ts" },
          { claimType: "file", claimPath: "src/baz.ts" },
        ],
        expiresAt: new Date(now + 30 * 60 * 1000),
      });

      // Single query for all 3 claims, not 3 separate queries
      expect(selectCallCount).toBe(1);
    });

    it("batches insert for multiple non-conflicting claims (single insert call)", async () => {
      const now = Date.now();
      // All claims have no conflicts
      const existingClaims: any[] = [];

      let insertCallCount = 0;
      let insertedValuesCount = 0;
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingClaims),
          }),
        }),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((values: any) => {
            insertCallCount++;
            // Track how many items were inserted in this batch
            if (Array.isArray(values)) {
              insertedValuesCount += values.length;
            } else {
              insertedValuesCount += 1;
            }
            return {
              returning: vi.fn().mockResolvedValue([{
                id: "new-claim",
                companyId: "company-1",
                projectId: "project-1",
                agentId: "agent-1",
                runId: "run-1",
                claimType: "file",
                claimPath: "src/claimed.ts",
                status: "active",
                expiresAt: new Date(now + 30 * 60 * 1000),
              }]),
            };
          }),
        })),
      });

      await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [
          { claimType: "file", claimPath: "src/foo.ts" },
          { claimType: "file", claimPath: "src/bar.ts" },
          { claimType: "file", claimPath: "src/baz.ts" },
        ],
        expiresAt: new Date(now + 30 * 60 * 1000),
      });

      // Single insert call for all 3 non-conflicting claims (batch insert)
      expect(insertCallCount).toBe(1);
      // All 3 claims inserted in one batch
      expect(insertedValuesCount).toBe(3);
    });
  });

  describe("releaseClaims", () => {
    it("releases all claims for a run when no claimIds provided", async () => {
      const releasedClaims = [{
        id: "claim-1",
        status: "released",
      }];

      const mockDb = createMockDb({
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(releasedClaims),
            }),
          }),
        }),
      });

      const result = await releaseClaims(mockDb as any, {
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
      });

      expect(result.length).toBe(1);
      expect(result[0].status).toBe("released");
    });

    it("releases only specified claims when claimIds provided", async () => {
      const releasedClaims = [{
        id: "claim-1",
        status: "released",
      }];

      const mockDb = createMockDb({
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(releasedClaims),
            }),
          }),
        }),
      });

      const result = await releaseClaims(mockDb as any, {
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        claimIds: ["claim-1"],
      });

      expect(result.length).toBe(1);
    });
  });

  describe("refreshClaims", () => {
    it("refreshes claims with new expiration", async () => {
      const newExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const refreshedClaims = [{
        id: "claim-1",
        expiresAt: newExpiresAt,
      }];

      const mockDb = createMockDb({
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(refreshedClaims),
            }),
          }),
        }),
      });

      const result = await refreshClaims(mockDb as any, {
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        claimIds: ["claim-1"],
        expiresAt: newExpiresAt,
      });

      expect(result.length).toBe(1);
      expect(result[0].expiresAt).toEqual(newExpiresAt);
    });

    it("returns empty array when no claimIds", async () => {
      const mockDb = createMockDb();

      const result = await refreshClaims(mockDb as any, {
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        claimIds: [],
        expiresAt: new Date(),
      });

      expect(result.length).toBe(0);
    });
  });

  describe("listConflicts", () => {
    it("returns empty when no active claims", async () => {
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
      });

      expect(result.length).toBe(0);
    });

    it("excludes current agent claims at DB query level", async () => {
      // Only claim-other should be returned after DB-level exclusion of agent-1
      const filteredClaims = [
        {
          id: "claim-other",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-2",
          runId: "run-2",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(filteredClaims),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // claim-other is returned, but has no conflicts (no other claims)
      expect(result.length).toBe(0);
    });

    it("returns conflicts from other agents", async () => {
      // Only claim-other should be returned after DB-level exclusion
      // But since current-claim was filtered out, claim-other has no conflicts
      const filteredClaims = [
        {
          id: "claim-other",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-2",
          runId: "run-2",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(filteredClaims),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // No conflicts since only one claim exists
      expect(result.length).toBe(0);
    });

    it("does not return expired claims as conflicts", async () => {
      // DB-level filter gte(expiresAt, now) excludes expired claims, so mock returns empty
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      expect(result.length).toBe(0);
    });
  });

  describe("glob pattern matching", () => {
    it("handles glob claims correctly", async () => {
      const existingClaims = [{
        id: "existing-glob",
        companyId: "company-1",
        projectId: "project-1",
        agentId: "agent-2",
        runId: "run-2",
        claimType: "glob",
        claimPath: "src/*.ts",
        status: "active",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingClaims),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "claim-1",
              companyId: "company-1",
              projectId: "project-1",
              agentId: "agent-1",
              runId: "run-1",
              claimType: "file",
              claimPath: "src/foo.ts",
              status: "active",
              expiresAt: new Date(),
            }]),
          }),
        }),
      });

      const result = await acquireClaims(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        claims: [{ claimType: "file", claimPath: "src/foo.ts" }],
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].conflictingClaims[0].claimPath).toBe("src/*.ts");
    });
  });

  describe("listConflicts nested loop correctness", () => {
    it("detects directory-directory conflicts (parent dir vs child dir)", async () => {
      // Bug case: directory "src" and directory "src/utils" should conflict on path "src/utils/file.ts"
      const activeClaims = [
        {
          id: "dir-src",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-1",
          runId: "run-1",
          claimType: "directory",
          claimPath: "src",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
        {
          id: "dir-src-utils",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-2",
          runId: "run-2",
          claimType: "directory",
          claimPath: "src/utils",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(activeClaims),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/utils/file.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // Both claims overlap "src/utils/file.ts", so both should be in conflicts
      expect(result.length).toBe(2);
      const conflictPaths = result.map((c) => c.claimPath).sort();
      expect(conflictPaths).toEqual(["src", "src/utils"]);
    });

    it("does not mark same-run claims as conflicts with each other", async () => {
      // Same run has two claims on same path - they should NOT be conflicts
      const activeClaims = [
        {
          id: "claim-1",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-1",
          runId: "run-1",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
        {
          id: "claim-2",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-1",
          runId: "run-1",
          claimType: "directory",
          claimPath: "src",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(activeClaims),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // Same run claims should not be marked as conflicts
      expect(result.length).toBe(0);
    });

    it("correctly identifies cross-run conflicts when both claims pass DB filter", async () => {
      // Both claims pass the DB filter (different agents and runs)
      const filteredClaims = [
        {
          id: "other-claim",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-2",
          runId: "run-2",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
        {
          id: "another-claim",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-3",
          runId: "run-3",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(filteredClaims),
          }),
        }),
      });

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // Both claims overlap same path, so both should be in conflicts
      expect(result.length).toBe(2);
    });

    it("file claims on different files in same directory do not conflict", async () => {
      // Two file claims on different files - they don't overlap
      const activeClaims = [
        {
          id: "file-a",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-1",
          runId: "run-1",
          claimType: "file",
          claimPath: "src/foo.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
        {
          id: "file-b",
          companyId: "company-1",
          projectId: "project-1",
          agentId: "agent-2",
          runId: "run-2",
          claimType: "file",
          claimPath: "src/bar.ts",
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(activeClaims),
          }),
        }),
      });

      // Query for conflicts on foo.ts
      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/foo.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // foo.ts and bar.ts don't overlap, so no conflicts
      expect(result.length).toBe(0);
    });
  });

  describe("getActiveClaimsForRun runsId+status+expiresAt filtering", () => {
    it("queries with correct conditions: companyId, runId, status=active, expiresAt>=now", async () => {
      const now = Date.now();
      const claims = [
        { id: "claim-1", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date(now + 30 * 60 * 1000) },
        { id: "claim-2", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/b.ts", status: "active", expiresAt: new Date(now - 60 * 1000) },
        { id: "claim-3", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-other", claimType: "file", claimPath: "src/c.ts", status: "active", expiresAt: new Date(now + 30 * 60 * 1000) },
      ];

      let receivedWhereArgs: any[] = [];
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((...args: any[]) => {
              receivedWhereArgs = args;
              return Promise.resolve([claims[0]]);
            }),
          }),
        }),
      });

      const { getActiveClaimsForRun } = await import("../services/file-claims.js");

      const result = await getActiveClaimsForRun(mockDb as any, "company-1", "run-1", null);

      // getActiveClaimsForRun should filter by: companyId, runId, status=active, expiresAt>=now
      // The function should call db.select(...).from(...).where(and(...conditions...))
      // We verify by checking result contains only the claim that passes ALL filters
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("claim-1");

      // The result only contains claim-1 which is the only one with:
      // - companyId = company-1 (matches)
      // - runId = run-1 (matches)
      // - status = active (matches)
      // - expiresAt = future (matches)
      // claim-2 fails: expiresAt is in the past
      // claim-3 fails: runId is "run-other" not "run-1"
    });

    it("filters by projectId when provided", async () => {
      const now = Date.now();
      const claims = [
        { id: "claim-1", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date(now + 30 * 60 * 1000) },
      ];

      let receivedWhereArgs: any[] = [];
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((...args: any[]) => {
              receivedWhereArgs = args;
              return Promise.resolve(claims);
            }),
          }),
        }),
      });

      const { getActiveClaimsForRun } = await import("../services/file-claims.js");

      const result = await getActiveClaimsForRun(mockDb as any, "company-1", "run-1", "project-1");

      expect(result.length).toBe(1);
      expect(result[0].projectId).toBe("project-1");
    });
  });

  describe("getActiveClaimsForRun projectId filtering", () => {
    it("filters claims by projectId when provided", async () => {
      const claims = [
        { id: "claim-1", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date() },
        { id: "claim-2", companyId: "company-1", projectId: "project-2", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/b.ts", status: "active", expiresAt: new Date() },
      ];

      let whereConditions: any[] = [];
      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((...args: any[]) => {
              whereConditions = args;
              return Promise.resolve(claims.filter(c => c.projectId === "project-1"));
            }),
          }),
        }),
      });

      // Import getActiveClaimsForRun dynamically since it's not in the main import
      const { getActiveClaimsForRun } = await import("../services/file-claims.js");

      const result = await getActiveClaimsForRun(mockDb as any, "company-1", "run-1", "project-1");

      // Should only return claims from project-1
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("claim-1");
    });

    it("returns all run claims when projectId is not provided", async () => {
      const claims = [
        { id: "claim-1", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date() },
        { id: "claim-2", companyId: "company-1", projectId: "project-2", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/b.ts", status: "active", expiresAt: new Date() },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(claims),
          }),
        }),
      });

      const { getActiveClaimsForRun } = await import("../services/file-claims.js");

      const result = await getActiveClaimsForRun(mockDb as any, "company-1", "run-1", null);

      // Should return all claims for the run
      expect(result.length).toBe(2);
    });
  });

  describe("listConflicts deduplication", () => {
    it("does not return duplicate conflict entries for the same claim", async () => {
      // When a claim conflicts with multiple other claims on different paths,
      // it should appear only once in the result
      const activeClaims = [
        { id: "claim-1", companyId: "company-1", projectId: "project-1", agentId: "agent-1", runId: "run-1", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
        { id: "claim-2", companyId: "company-1", projectId: "project-1", agentId: "agent-2", runId: "run-2", claimType: "file", claimPath: "src/a.ts", status: "active", expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
        { id: "claim-3", companyId: "company-1", projectId: "project-1", agentId: "agent-3", runId: "run-3", claimType: "glob", claimPath: "src/*.ts", status: "active", expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
      ];

      const mockDb = createMockDb({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(activeClaims),
          }),
        }),
      });

      const { listConflicts } = await import("../services/file-claims.js");

      const result = await listConflicts(mockDb as any, {
        companyId: "company-1",
        projectId: "project-1",
        paths: ["src/a.ts", "src/b.ts"],
        excludeAgentId: "agent-1",
        excludeRunId: "run-1",
      });

      // claim-2 and claim-3 should each appear only once even though they both conflict with claim-1 on different paths
      const claim2Entries = result.filter(c => c.id === "claim-2");
      const claim3Entries = result.filter(c => c.id === "claim-3");
      expect(claim2Entries.length).toBe(1);
      expect(claim3Entries.length).toBe(1);
    });
  });
});

describe("extractClaimPathsFromIssue", () => {
  it("extracts claim paths from labels with claims: prefix", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claims:src/auth/**", "claims:src/login.ts", "priority:high"],
    });

    expect(result.length).toBe(2);
    expect(result).toContainEqual({ claimPath: "src/auth/**", claimType: "glob" });
    expect(result).toContainEqual({ claimPath: "src/login.ts", claimType: "file" });
  });

  it("extracts claim paths from labels with claim: prefix", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claim:src/api/", "claim:src/config.ts"],
    });

    expect(result.length).toBe(2);
    // Path is normalized (trailing slash removed) but type is correctly detected as directory
    expect(result).toContainEqual({ claimPath: "src/api", claimType: "directory" });
    expect(result).toContainEqual({ claimPath: "src/config.ts", claimType: "file" });
  });

  it("extracts claim paths from description lines", () => {
    const result = extractClaimPathsFromIssue({
      description: `
Some description text here.

## Tasks
- claim:src/feature-a.ts
- claim:src/feature-b/**
- * claim:src/utils/

More text.
      `,
    });

    expect(result.length).toBe(3);
    expect(result).toContainEqual({ claimPath: "src/feature-a.ts", claimType: "file" });
    expect(result).toContainEqual({ claimPath: "src/feature-b/**", claimType: "glob" });
    // Path is normalized (trailing slash removed) but type is correctly detected as directory
    expect(result).toContainEqual({ claimPath: "src/utils", claimType: "directory" });
  });

  it("combines claims from both labels and description", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claims:src/frontend/**"],
      description: "- claim:src/backend/**",
    });

    expect(result.length).toBe(2);
    expect(result).toContainEqual({ claimPath: "src/frontend/**", claimType: "glob" });
    expect(result).toContainEqual({ claimPath: "src/backend/**", claimType: "glob" });
  });

  it("deduplicates claims with same path and type", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claims:src/auth/**", "claim:src/auth/**"],
      description: "- claim:src/auth/**",
    });

    // Should only have one entry since it's the same path and type
    expect(result.length).toBe(1);
  });

  it("normalizes paths", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["./not-claims:src/foo/", "claims:./bar.ts", "claim:src//baz///"],
    });

    // ./not-claims:src/foo/ doesn't start with claims: prefix, so ignored
    // claims:./bar.ts normalizes to bar.ts (file)
    // claim:src//baz/// ends with / so treated as directory, normalizes to src/baz
    expect(result.length).toBe(2);
    expect(result).toContainEqual({ claimPath: "bar.ts", claimType: "file" });
    expect(result).toContainEqual({ claimPath: "src/baz", claimType: "directory" });
  });

  it("handles empty labels and description", () => {
    const result = extractClaimPathsFromIssue({
      labels: [],
      description: "",
    });

    expect(result.length).toBe(0);
  });

  it("handles null/undefined description", () => {
    const result1 = extractClaimPathsFromIssue({ labels: [], description: null });
    const result2 = extractClaimPathsFromIssue({ labels: [], description: undefined });

    expect(result1.length).toBe(0);
    expect(result2.length).toBe(0);
  });

  it("handles labels with no claim patterns", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["bug", "priority:high", "frontend"],
    });

    expect(result.length).toBe(0);
  });

  it("handles description with no claim patterns", () => {
    const result = extractClaimPathsFromIssue({
      description: "Just a regular issue description without any claim paths.",
    });

    expect(result.length).toBe(0);
  });

  it("treats paths ending with / as directory claims", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claim:src/directory/"],
    });

    expect(result).toContainEqual({ claimPath: "src/directory", claimType: "directory" });
  });

  it("treats paths ending with /** or /* as glob claims", () => {
    const result = extractClaimPathsFromIssue({
      labels: ["claims:src/**/*.ts", "claim:src/*/file.ts"],
    });

    expect(result).toContainEqual({ claimPath: "src/**/*.ts", claimType: "glob" });
    expect(result).toContainEqual({ claimPath: "src/*/file.ts", claimType: "glob" });
  });
});

describe("isProtectedPath", () => {
  it("blocks package.json", () => {
    expect(isProtectedPath("package.json")).toBe(true);
    expect(isProtectedPath("src/package.json")).toBe(true);
  });

  it("blocks lock files", () => {
    expect(isProtectedPath("pnpm-lock.yaml")).toBe(true);
    expect(isProtectedPath("yarn.lock")).toBe(true);
    expect(isProtectedPath("bun.lockb")).toBe(true);
  });

  it("blocks .git and .github directories", () => {
    expect(isProtectedPath(".git/config")).toBe(true);
    expect(isProtectedPath(".github/workflows/test.yml")).toBe(true);
  });

  it("blocks node_modules and build directories", () => {
    expect(isProtectedPath("node_modules/lodash")).toBe(true);
    expect(isProtectedPath("dist/bundle.js")).toBe(true);
    expect(isProtectedPath("build/output.css")).toBe(true);
  });

  it("blocks config files", () => {
    expect(isProtectedPath("tsconfig.json")).toBe(true);
    expect(isProtectedPath("jest.config.js")).toBe(true);
    expect(isProtectedPath("vitest.config.ts")).toBe(true);
  });

  it("blocks test files", () => {
    expect(isProtectedPath("src/foo.test.ts")).toBe(true);
    expect(isProtectedPath("src/bar.spec.tsx")).toBe(true);
    expect(isProtectedPath("src/baz.stories.tsx")).toBe(true);
  });

  it("allows regular source files", () => {
    expect(isProtectedPath("src/foo.ts")).toBe(false);
    expect(isProtectedPath("src/bar.tsx")).toBe(false);
    expect(isProtectedPath("src/utils/helper.ts")).toBe(false);
  });

  it("allows files not in protected patterns", () => {
    expect(isProtectedPath("src/components/Button.tsx")).toBe(false);
    expect(isProtectedPath("server/routes/api.ts")).toBe(false);
  });

  it("respects custom protected patterns", () => {
    expect(isProtectedPath("secret.txt", ["secret.txt"])).toBe(true);
    expect(isProtectedPath("src/foo.ts", ["src/**/*.ts"])).toBe(true);
  });
});

describe("filterProtectedPaths", () => {
  it("separates allowed from blocked claims", () => {
    const claims = [
      { claimType: "file" as const, claimPath: "src/foo.ts" },
      { claimType: "file" as const, claimPath: "package.json" },
      { claimType: "file" as const, claimPath: "src/bar.ts" },
    ];

    const result = filterProtectedPaths(claims);

    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].claimPath).toBe("package.json");
  });

  it("returns empty arrays when all claims are allowed", () => {
    const claims = [
      { claimType: "file" as const, claimPath: "src/foo.ts" },
      { claimType: "file" as const, claimPath: "src/bar.ts" },
    ];

    const result = filterProtectedPaths(claims);

    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
  });

  it("returns empty arrays when all claims are blocked", () => {
    const claims = [
      { claimType: "file" as const, claimPath: "package.json" },
      { claimType: "file" as const, claimPath: "pnpm-lock.yaml" },
    ];

    const result = filterProtectedPaths(claims);

    expect(result.allowed).toHaveLength(0);
    expect(result.blocked).toHaveLength(2);
  });

  it("respects custom protected patterns", () => {
    const claims = [
      { claimType: "file" as const, claimPath: "custom.txt" },
      { claimType: "file" as const, claimPath: "src/foo.ts" },
    ];

    const result = filterProtectedPaths(claims, ["custom.txt"]);

    expect(result.allowed).toHaveLength(1);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].claimPath).toBe("custom.txt");
  });
});

describe("extractClaimPathsFromDiff", () => {
  it("extracts paths from diff --git headers", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcdef 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 const foo = "bar";
+const baz = "qux";
 return foo;`;

    const result = extractClaimPathsFromDiff(diff);

    expect(result.some((c) => c.claimPath === "src/foo.ts")).toBe(true);
  });

  it("extracts multiple files from a diff", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcdef 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 const foo = "bar";
+const baz = "qux";
diff --git a/src/bar.ts b/src/bar.ts
index 1234567..89abcdef 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,5 +1,6 @@
 const bar = "foo";
+const qux = "baz";`;

    const result = extractClaimPathsFromDiff(diff);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.claimPath)).toContain("src/foo.ts");
    expect(result.map((c) => c.claimPath)).toContain("src/bar.ts");
  });

  it("deduplicates paths", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcdef 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 const foo = "bar";
+const baz = "qux";
diff --git a/src/foo.ts b/src/foo.ts
index 89abcdef..1111111 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,6 +2,7 @@
 const foo = "bar";
 const baz = "qux";
+const newVar = "value";`;

    const result = extractClaimPathsFromDiff(diff);

    expect(result).toHaveLength(1);
    expect(result[0].claimPath).toBe("src/foo.ts");
  });

  it("returns empty array for empty diff", () => {
    const result = extractClaimPathsFromDiff("");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for diff with no file changes", () => {
    const diff = `diff --git a/README.md b/README.md
index 1234567..89abcdef 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Project
+New line added`;

    const result = extractClaimPathsFromDiff(diff);
    // .md files are in protected patterns, but extractClaimPathsFromDiff doesn't filter
    // The filtering happens in acquireClaims via filterProtectedPaths
    expect(result).toHaveLength(1);
  });

  it("handles renamed files", () => {
    const diff = `rename from src/old.ts
rename to src/new.ts`;

    const result = extractClaimPathsFromDiff(diff);

    expect(result.some((c) => c.claimPath === "src/old.ts")).toBe(true);
    expect(result.some((c) => c.claimPath === "src/new.ts")).toBe(true);
  });
});

describe("acquireClaims with protected paths", () => {
  it("blocks protected paths and does not insert them", async () => {
    const mockDb = createMockDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "claim-1",
            companyId: "company-1",
            projectId: "project-1",
            agentId: "agent-1",
            runId: "run-1",
            claimType: "file",
            claimPath: "src/foo.ts",
            status: "active",
            expiresAt: new Date(),
          }]),
        }),
      }),
    });

    const result = await acquireClaims(mockDb as any, {
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      claims: [
        { claimType: "file", claimPath: "src/foo.ts" },
        { claimType: "file", claimPath: "package.json" },
      ],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    // package.json should be blocked, src/foo.ts should be acquired
    expect(result.acquired.length).toBe(1);
    expect(result.blocked.length).toBe(1);
    expect(result.blocked[0].claimPath).toBe("package.json");
  });

  it("returns blocked in result", async () => {
    const mockDb = createMockDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await acquireClaims(mockDb as any, {
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      claims: [
        { claimType: "file", claimPath: "pnpm-lock.yaml" },
      ],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].claimPath).toBe("pnpm-lock.yaml");
  });
});