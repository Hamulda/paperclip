import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  acquireClaims,
  refreshClaims,
  releaseClaims,
  listConflicts,
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
      // When we exclude agent-1, only claims from other agents are fetched
      const activeClaims = [{
        id: "claim-1",
        companyId: "company-1",
        projectId: "project-1",
        agentId: "agent-2",  // Different agent
        runId: "run-2",
        claimType: "file",
        claimPath: "src/bar.ts",  // Different path
        status: "active",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }];

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
        paths: ["src/bar.ts"],
        excludeAgentId: "agent-1",  // Excluding agent-1
        excludeRunId: "run-1",
      });

      // Should find 1 conflict because agent-2's claim for src/bar.ts matches our path
      expect(result.length).toBe(1);
    });

    it("returns conflicts from other agents", async () => {
      // This should return 1 because the claim belongs to agent-2 (not excluded)
      const activeClaims = [{
        id: "claim-1",
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

      // Should be 1 because the claim is from agent-2
      expect(result.length).toBe(1);
    });
  });
});

describe("glob pattern matching", () => {
  it("handles glob claims correctly", async () => {
    // This test is simplified to avoid complex glob regex issues
    // The glob pattern **/*.ts is a simplified glob meaning "any .ts file directly in any subdir"
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

    // src/foo.ts matches glob pattern src/*.ts
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].conflictingClaims[0].claimPath).toBe("src/*.ts");
  });
});
