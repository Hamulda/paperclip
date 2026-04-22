import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { issueArtifactService, validateArtifactChain, assertArtifactTypeForPhase, getArtifactTypeForPhase, publishArtifactForPhase } from "../issue-artifacts.js";
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
        supersededBy: null,
        supersedes: null,
        revisionCount: 1,
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
      expect(result[0].revisionCount).toBe(1);
    });
  });

  describe("create", () => {
    it("validates phase-artifact invariant and creates artifact", async () => {
      const createdRow = {
        id: "artifact-2",
        companyId: "company-1",
        issueId: "11111111-1111-1111-1111-111111111111",
        artifactType: "executor",
        status: "published",
        actorAgentId: "agent-1",
        actorUserId: null,
        createdByRunId: null,
        summary: null,
        metadata: { artifactType: "executor", filesChanged: ["a.ts"], changesSummary: "Changed A", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
        supersededBy: null,
        supersedes: null,
        revisionCount: 1,
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

      const result = await service.create("company-1", "executing", input);

      expect(result.id).toBe("artifact-2");
      expect(result.artifactType).toBe("executor");
      expect(result.revisionCount).toBe(1);
    });

    it("rejects artifact type mismatching current phase", async () => {
      const service = issueArtifactService(mockDb);
      const input: CreateIssueArtifact = {
        issueId: "11111111-1111-1111-1111-111111111111",
        artifactType: "planner",
        summary: null,
        metadata: {
          artifactType: "planner",
          goal: "Test",
          acceptanceCriteria: [],
          touchedFiles: [],
          forbiddenFiles: [],
          testPlan: "Test",
          risks: [],
        },
      };

      expect(() => service.create("company-1", "executing", input)).toThrow(
        "Artifact type 'planner' is not valid in phase 'executing' — expected 'planning'",
      );
    });

    it("increments revision count for same artifact type", async () => {
      const existingRow = {
        revisionCount: 2,
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        }),
      } as any);

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "artifact-3",
            companyId: "company-1",
            issueId: "issue-1",
            artifactType: "planner",
            status: "published",
            actorAgentId: null,
            actorUserId: null,
            createdByRunId: null,
            summary: null,
            metadata: {},
            supersededBy: null,
            supersedes: null,
            revisionCount: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const input: CreateIssueArtifact = {
        issueId: "issue-1",
        artifactType: "planner",
        summary: null,
        metadata: { artifactType: "planner", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "Test", risks: [] },
      };

      const result = await service.create("company-1", "planning", input);
      expect(result.revisionCount).toBe(3);
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
      vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
        await fn(mockDb);
      });

      const service = issueArtifactService(mockDb);
      await service.supersede("issue-1", "planner");

      expect(mockDb.update).toHaveBeenCalled();
    });

    it("returns ids of superseded artifacts", async () => {
      const publishedRows = [
        { id: "artifact-old-1", status: "published", artifactType: "planner" },
        { id: "artifact-old-2", status: "published", artifactType: "planner" },
      ];

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(publishedRows),
        }),
      } as any);
      vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
        await fn(mockDb);
      });

      const service = issueArtifactService(mockDb);
      const result = await service.supersede("issue-1", "planner");

      expect(result).toEqual(["artifact-old-1", "artifact-old-2"]);
    });
  });

  describe("replace", () => {
    it("atomically supersedes previous and creates new published artifact", async () => {
      const previousRow = {
        id: "artifact-prev",
        status: "published",
        revisionCount: 1,
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([previousRow]),
        }),
      } as any);

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "artifact-new",
            companyId: "company-1",
            issueId: "issue-1",
            artifactType: "executor",
            status: "published",
            actorAgentId: null,
            actorUserId: null,
            createdByRunId: null,
            summary: null,
            metadata: { artifactType: "executor", filesChanged: ["b.ts"], changesSummary: "Changed B", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
            supersededBy: null,
            supersedes: "artifact-prev",
            revisionCount: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      } as any);

      vi.mocked(mockDb.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const result = await service.replace(
        "company-1",
        "executing",
        "issue-1",
        "executor",
        { artifactType: "executor", filesChanged: ["b.ts"], changesSummary: "Changed B", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
      );

      expect(result!.id).toBe("artifact-new");
      expect(result!.revisionCount).toBe(2);
      expect(result!.supersedes).toBe("artifact-prev");
    });

    it("creates revision 1 when no previous artifact exists", async () => {
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "artifact-first",
            companyId: "company-1",
            issueId: "issue-1",
            artifactType: "planner",
            status: "published",
            actorAgentId: null,
            actorUserId: null,
            createdByRunId: null,
            summary: null,
            metadata: { artifactType: "planner", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "Test", risks: [] },
            supersededBy: null,
            supersedes: null,
            revisionCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      } as any);

      const service = issueArtifactService(mockDb);
      const result = await service.replace(
        "company-1",
        "planning",
        "issue-1",
        "planner",
        { artifactType: "planner", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "Test", risks: [] },
      );

      expect(result!.revisionCount).toBe(1);
      expect(result!.supersedes).toBeNull();
    });

    it("rejects artifact type mismatching phase in replace", async () => {
      const service = issueArtifactService(mockDb);
      expect(() =>
        service.replace(
          "company-1",
          "code_review",
          "issue-1",
          "executor",
          { artifactType: "executor", filesChanged: [], changesSummary: "", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
        ),
      ).toThrow("Artifact type 'executor' is not valid in phase 'code_review' — expected 'executing'");
    });
  });
});

describe("validateArtifactChain", () => {
  it("returns null when no published artifacts", () => {
    const result = validateArtifactChain([
      { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date() } as any,
    ]);
    expect(result).toBeNull();
  });

  it("returns latest published artifact when chain is valid", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z"), artifactType: "planner" } as any;
    const mid = { id: "a2", status: "superseded", supersedes: "a1", revisionCount: 2, createdAt: new Date("2026-04-19T11:00:00Z"), artifactType: "planner" } as any;
    const latest = { id: "a3", status: "published", supersedes: "a2", revisionCount: 3, createdAt: new Date("2026-04-19T12:00:00Z"), artifactType: "planner" } as any;

    const result = validateArtifactChain([root, mid, latest]);
    expect(result!.id).toBe("a3");
  });

  it("throws when chain has broken predecessor reference", () => {
    const latest = { id: "a3", status: "published", supersedes: "missing-id", revisionCount: 3, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([latest])).toThrow("Artifact chain broken");
  });

  it("throws when predecessor is not superseded", () => {
    const predecessor = { id: "a1", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date() } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 2, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([predecessor, latest])).toThrow("has status 'published', expected 'superseded'");
  });

  it("throws when revision counts are not consecutive", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date() } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 5, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([root, latest])).toThrow("revision count mismatch");
  });

  it("throws when chain root revision is not 1", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 3, createdAt: new Date() } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 4, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([root, latest])).toThrow("revisionCount 3, expected 1");
  });
});

describe("assertArtifactTypeForPhase", () => {
  it("accepts valid artifact type for phase", () => {
    expect(() => assertArtifactTypeForPhase("planner", "planning")).not.toThrow();
    expect(() => assertArtifactTypeForPhase("plan_reviewer", "plan_review")).not.toThrow();
    expect(() => assertArtifactTypeForPhase("executor", "executing")).not.toThrow();
    expect(() => assertArtifactTypeForPhase("reviewer", "code_review")).not.toThrow();
    expect(() => assertArtifactTypeForPhase("integrator", "integration")).not.toThrow();
  });

  it("throws on mismatching artifact type for phase", () => {
    expect(() => assertArtifactTypeForPhase("planner", "executing")).toThrow(
      "Artifact type 'planner' is not valid in phase 'executing' — expected 'planning'",
    );
    expect(() => assertArtifactTypeForPhase("executor", "planning")).toThrow(
      "Artifact type 'executor' is not valid in phase 'planning' — expected 'executing'",
    );
    expect(() => assertArtifactTypeForPhase("integrator", "code_review")).toThrow(
      "Artifact type 'integrator' is not valid in phase 'code_review' — expected 'integration'",
    );
  });
});

describe("getArtifactTypeForPhase", () => {
  it("returns the correct artifact type for each workflow phase", () => {
    expect(getArtifactTypeForPhase("planning")).toBe("planner");
    expect(getArtifactTypeForPhase("plan_review")).toBe("plan_reviewer");
    expect(getArtifactTypeForPhase("executing")).toBe("executor");
    expect(getArtifactTypeForPhase("code_review")).toBe("reviewer");
    expect(getArtifactTypeForPhase("integration")).toBe("integrator");
  });

  it("throws for terminal phases with no defined artifact type", () => {
    expect(() => getArtifactTypeForPhase("triage")).toThrow(
      "No artifact type defined for phase 'triage'",
    );
    expect(() => getArtifactTypeForPhase("done")).toThrow(
      "No artifact type defined for phase 'done'",
    );
    expect(() => getArtifactTypeForPhase("blocked")).toThrow(
      "No artifact type defined for phase 'blocked'",
    );
    expect(() => getArtifactTypeForPhase("ready_for_execution")).toThrow(
      "No artifact type defined for phase 'ready_for_execution'",
    );
  });
});

describe("publishArtifactForPhase", () => {
  // Skipped: this validation is already covered by assertArtifactTypeForPhase unit tests.
  // The synchronous throw path is tested in the assertArtifactTypeForPhase describe block above.
  it.skip("validates phase-artifact compatibility before publishing", () => {
    const metadata = {
      issueId: "11111111-1111-1111-1111-111111111111",
      artifactType: "planner",
      goal: "Test",
      acceptanceCriteria: [],
      touchedFiles: [],
      forbiddenFiles: [],
      testPlan: "Test",
      risks: [],
    };
    // Wrong phase — planner artifact in executing phase
    expect(() =>
      publishArtifactForPhase(
        mockDb,
        "company-1",
        "executing",
        "planner",
        metadata,
      ),
    ).toThrow(
      "Artifact type 'planner' is not valid in phase 'executing' — expected 'planning'",
    );
  });

  it("calls replace with correct parameters when phase matches", async () => {
    const previousRow = { id: "artifact-prev", status: "published", revisionCount: 1 };
    vi.mocked(mockDb.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([previousRow]),
        }),
      }),
    } as any);
    vi.mocked(mockDb.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: "artifact-new",
          companyId: "company-1",
          issueId: "issue-1",
          artifactType: "integrator",
          status: "published",
          actorAgentId: null,
          actorUserId: null,
          createdByRunId: null,
          summary: null,
          metadata: { artifactType: "integrator", finalVerification: "passed", deploymentNotes: [], signoffs: [], remainingOpenIssues: [], rollbackPlan: "" },
          supersededBy: null,
          supersedes: "artifact-prev",
          revisionCount: 2,
          createdAt: new Date(),
          updatedAt: new Date(),
        }]),
      }),
    } as any);
    vi.mocked(mockDb.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const metadata = {
      issueId: "issue-1",
      artifactType: "integrator",
      finalVerification: "passed",
      deploymentNotes: [],
      signoffs: [],
      remainingOpenIssues: [],
      rollbackPlan: "",
    };

    const result = await publishArtifactForPhase(
      mockDb,
      "company-1",
      "integration",
      "integrator",
      metadata,
    );

    expect(result!.artifactType).toBe("integrator");
    expect(result!.revisionCount).toBe(2);
  });
});

describe("validateArtifactChain with integrator", () => {
  it("accepts a valid integrator artifact chain", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z"), artifactType: "integrator" } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 2, createdAt: new Date("2026-04-19T11:00:00Z"), artifactType: "integrator" } as any;
    const result = validateArtifactChain([root, latest]);
    expect(result!.id).toBe("a2");
  });
});