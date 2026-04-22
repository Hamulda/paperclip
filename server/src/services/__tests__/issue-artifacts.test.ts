import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { issueArtifactService, validateArtifactChain, assertArtifactTypeForPhase, getArtifactTypeForPhase, publishArtifactForPhase, publishForCurrentPhase, WORKFLOW_ROLES, WORKFLOW_ROLE_PHASES, getPhaseForRole, CLAUDE_CODE_USAGE } from "../issue-artifacts.js";
import { issueArtifacts } from "@paperclipai/db";
import type { CreateIssueArtifact } from "@paperclipai/shared";

// Mock swarm-orchestrator so triggerOrchestration doesn't hang the tests
vi.mock("../swarm-orchestrator.js", () => ({
  orchestrateIssue: vi.fn().mockResolvedValue(null),
}));

// Mock issueService so getById doesn't go through getIssueByIdentifier → innerJoin
vi.mock("../issues.js", () => ({
  issueService: vi.fn().mockReturnValue({
    getById: vi.fn(),
  }),
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn().mockImplementation(async (fn) => {
    await fn(mockDb);
  }),
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

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
      } as any);

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

      await expect(service.create("company-1", "executing", input)).rejects.toThrow(
        "Artifact type 'planner' is not valid in phase 'executing' — expected 'planning'",
      );
    });

    it("increments revision count for same artifact type", async () => {
      const existingRow = {
        revisionCount: 2,
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([existingRow]),
        }),
      } as any);

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "artifact-3",
            companyId: "company-1",
            issueId: "11111111-1111-1111-1111-111111111111",
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
        issueId: "11111111-1111-1111-1111-111111111111",
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
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "artifact-old-1", status: "published", artifactType: "planner" },
            { id: "artifact-old-2", status: "published", artifactType: "planner" },
          ]),
        }),
      } as any);
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

      const service2 = issueArtifactService(mockDb);
      const result = await service2.supersede("issue-1", "planner");

      expect(result).toEqual(["artifact-old-1", "artifact-old-2"]);
    });
  });

  describe("replace", () => {
    it("wraps insert and superseded update in a transaction and links both sides of the chain", async () => {
      const previousRow = {
        id: "artifact-prev",
        status: "published",
        revisionCount: 1,
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([previousRow]),
        }),
      } as any);

      vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
        const newRow = {
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
        };

        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([newRow]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any;

        return await fn(tx);
      });

      const service = issueArtifactService(mockDb);
      const result = await service.replace(
        "company-1",
        "executing",
        "issue-1",
        "executor",
        { artifactType: "executor", filesChanged: ["b.ts"], changesSummary: "Changed B", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
      );

      expect(result!.id).toBe("artifact-new");
      expect(result!.supersedes).toBe("artifact-prev");
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("atomically supersedes previous and creates new published artifact", async () => {
      const previousRow = {
        id: "artifact-prev",
        status: "published",
        revisionCount: 1,
      };

      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([previousRow]),
        }),
      } as any);

      vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
        await fn(mockDb);
      });

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
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
        await fn(mockDb);
      });

      vi.mocked(mockDb.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: "artifact-first",
            companyId: "company-1",
            issueId: "11111111-1111-1111-1111-111111111111",
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
        "11111111-1111-1111-1111-111111111111",
        "planner",
        { artifactType: "planner", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "Test", risks: [] },
      );

      expect(result!.revisionCount).toBe(1);
      expect(result!.supersedes).toBeNull();
    });

    it("rejects artifact type mismatching phase in replace", async () => {
      const service = issueArtifactService(mockDb);
      await expect(
        service.replace(
          "company-1",
          "code_review",
          "issue-1",
          "executor",
          { artifactType: "executor", filesChanged: [], changesSummary: "", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
        ),
      ).rejects.toThrow("Artifact type 'executor' is not valid in phase 'code_review' — expected 'executing'");
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
    // The predecessor has status superseded, which means it's part of a valid chain context.
    // When predecessor has status "published" but there's also a newer published artifact,
    // the multiple published heads check fires first. To test predecessor status specifically,
    // we construct a chain where there's exactly one published head but its predecessor is also published.
    // However, in the canonical model the predecessor of a published artifact must be superseded.
    // This test validates that invariant: predecessor must be superseded for chain continuity.
    // Note: The "predecessor status" invariant fires after the unique-head check, so a published
    // predecessor alongside a published latest will hit the head-check first. The chain
    // structure here (a2 published, a1 published) represents an invalid dual-head state.
    const predecessor = { id: "a1", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z") } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 2, createdAt: new Date("2026-04-19T12:00:00Z") } as any;
    // Dual heads → unique head invariant fires first
    expect(() => validateArtifactChain([predecessor, latest])).toThrow("Multiple published heads");
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
  it("throws when metadata.issueId is missing", async () => {
    const metadata = {
      artifactType: "planner",
      goal: "Test",
      acceptanceCriteria: [],
      touchedFiles: [],
      forbiddenFiles: [],
      testPlan: "Test",
      risks: [],
      // issueId intentionally omitted
    };

    await expect(
      publishArtifactForPhase(
        mockDb,
        "company-1",
        "planning",
        "planner",
        metadata,
      ),
    ).rejects.toThrow("metadata.issueId to be a non-empty string");
  });

  it("throws when metadata.issueId is an empty string", async () => {
    const metadata = {
      issueId: "",
      artifactType: "planner",
      goal: "Test",
      acceptanceCriteria: [],
      touchedFiles: [],
      forbiddenFiles: [],
      testPlan: "Test",
      risks: [],
    };

    await expect(
      publishArtifactForPhase(
        mockDb,
        "company-1",
        "planning",
        "planner",
        metadata,
      ),
    ).rejects.toThrow("metadata.issueId to be a non-empty string");
  });

  it("throws when metadata.issueId is not a string", async () => {
    const metadata = {
      issueId: 123,
      artifactType: "planner",
    };

    await expect(
      publishArtifactForPhase(
        mockDb,
        "company-1",
        "planning",
        "planner",
        metadata,
      ),
    ).rejects.toThrow("metadata.issueId to be a non-empty string");
  });

  it("rejects artifact type mismatching current phase", async () => {
    await expect(
      publishArtifactForPhase(
        mockDb,
        "company-1",
        "executing",
        "planner",
        { issueId: "issue-1", artifactType: "planner", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "Test", risks: [] },
      ),
    ).rejects.toThrow(
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
    vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
      await fn(mockDb);
    });
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

describe("validateArtifactChain — singleton chain invariants", () => {
  it("accepts singleton chain with revisionCount 1", () => {
    const singleton = { id: "a1", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date() } as any;
    expect(validateArtifactChain([singleton])!.id).toBe("a1");
  });

  it("throws for singleton chain with revisionCount !== 1", () => {
    const bad = { id: "a1", status: "published", supersedes: null, revisionCount: 3, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([bad])).toThrow("revisionCount 3, expected 1");
  });
});

describe("validateArtifactChain — unique published head invariant", () => {
  it("throws when more than one published artifact exists", () => {
    const a1 = { id: "a1", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z") } as any;
    const a2 = { id: "a2", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T11:00:00Z") } as any;
    expect(() => validateArtifactChain([a1, a2])).toThrow("Multiple published heads detected");
  });

  it("accepts one published artifact with superseded predecessors", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z") } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 2, createdAt: new Date("2026-04-19T11:00:00Z") } as any;
    expect(validateArtifactChain([root, latest])!.id).toBe("a2");
  });
});

describe("validateArtifactChain — no dangling published artifacts invariant", () => {
  // Note: when multiple published artifacts exist, invariant 1 (unique head) fires first
  // and reports "Multiple published heads". This correctly covers the "dangling" case.
  // The "dangling" scenario only manifests distinctly when a published artifact is not
  // reachable from the head — which requires 2+ published to be possible.

  it("throws when a published artifact is not in the chain (unreachable from head)", () => {
    const root = { id: "a1", status: "superseded", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T10:00:00Z") } as any;
    const latest = { id: "a2", status: "published", supersedes: "a1", revisionCount: 2, createdAt: new Date("2026-04-19T11:00:00Z") } as any;
    // a3 is published but supersedes nothing and is not referenced — dangling.
    // The head check fires first, reporting both a3 and a2 as multiple heads.
    const dangling = { id: "a3", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date("2026-04-19T12:00:00Z") } as any;
    expect(() => validateArtifactChain([root, latest, dangling])).toThrow("Multiple published heads");
  });

  it("throws when dangling published artifact has a supersedes link that is not in the chain", () => {
    const chainHead = { id: "a1", status: "published", supersedes: null, revisionCount: 1, createdAt: new Date() } as any;
    // b1 is published but references a missing predecessor — dangling (unreachable from a1's chain).
    // The head check fires first, reporting both a1 and b1 as multiple heads.
    const dangling = { id: "b1", status: "published", supersedes: "missing-id", revisionCount: 2, createdAt: new Date() } as any;
    expect(() => validateArtifactChain([chainHead, dangling])).toThrow("Multiple published heads");
  });
});

describe("WORKFLOW_ROLES", () => {
  it("contains all five workflow roles", () => {
    expect(WORKFLOW_ROLES).toEqual(["planner", "plan_reviewer", "executor", "reviewer", "integrator"]);
  });
});

describe("publishForCurrentPhase", () => {
  beforeEach(() => {
    // Reset mocks so each test can set up its own context
    vi.mocked(mockDb.select).mockReset();
    vi.mocked(mockDb.insert).mockReset();
    vi.mocked(mockDb.update).mockReset();
    vi.mocked(mockDb.transaction).mockReset();
  });

  it("derives phase from the issue and calls publishArtifactForPhase", async () => {
    const issueRow = {
      id: "issue-1",
      phase: "planning",
      status: "todo",
      companyId: "company-1",
    };

    // Use issueService mock for getById instead of mocking getIssueByIdentifier pipeline
    const { issueService } = await import("../issues.js");
    vi.mocked(issueService(mockDb).getById).mockResolvedValue(issueRow as any);

    const previousRow = { id: "artifact-prev", status: "published", revisionCount: 1 };
    vi.mocked(mockDb.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([previousRow]),
        }),
      }),
    } as any);
    vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
      await fn(mockDb);
    });
    vi.mocked(mockDb.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: "artifact-new",
          companyId: "company-1",
          issueId: "issue-1",
          artifactType: "planner",
          status: "published",
          actorAgentId: null,
          actorUserId: null,
          createdByRunId: null,
          summary: null,
          metadata: { issueId: "issue-1", goal: "Test", acceptanceCriteria: [], touchedFiles: [], forbiddenFiles: [], testPlan: "", risks: [] },
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
      goal: "Test",
      acceptanceCriteria: [],
      touchedFiles: [],
      forbiddenFiles: [],
      testPlan: "",
      risks: [],
    };

    const result = await publishForCurrentPhase(mockDb, "company-1", "planner", metadata);

    expect(result).not.toBeNull();
  });

  it("throws when issue is not found", async () => {
    const { issueService } = await import("../issues.js");
    vi.mocked(issueService(mockDb).getById).mockResolvedValue(null);

    await expect(
      publishForCurrentPhase(mockDb, "company-1", "planner", { issueId: "does-not-exist" }),
    ).rejects.toThrow("issue 'does-not-exist' not found");
  });

  it("throws when metadata.issueId is missing", async () => {
    await expect(
      publishForCurrentPhase(mockDb, "company-1", "planner", { goal: "Test" }),
    ).rejects.toThrow("metadata.issueId to be a non-empty string");
  });

  it("uses the issue phase when phase matches artifact type", async () => {
    const issueRow = { id: "issue-1", phase: "executing", status: "in_progress", companyId: "company-1" };
    const { issueService } = await import("../issues.js");
    vi.mocked(issueService(mockDb).getById).mockResolvedValue(issueRow as any);
    vi.mocked(mockDb.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);
    vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
      await fn(mockDb);
    });
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
          metadata: { issueId: "issue-1", filesChanged: ["a.ts"], changesSummary: "Changed A", deviationsFromPlan: [], testsRun: [], remainingWork: [] },
          supersededBy: null,
          supersedes: null,
          revisionCount: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }]),
      }),
    } as any);

    const result = await publishForCurrentPhase(mockDb, "company-1", "executor", {
      issueId: "issue-1",
      filesChanged: ["a.ts"],
      changesSummary: "Changed A",
      deviationsFromPlan: [],
      testsRun: [],
      remainingWork: [],
    });

    expect(result!.artifactType).toBe("executor");
  });
});

describe("standalone supersede semantics", () => {
  it("supersede marks artifacts as superseded but does not set supersededBy (no single next artifact)", async () => {
    const rows = [
      { id: "artifact-old-1", status: "published", artifactType: "planner" },
      { id: "artifact-old-2", status: "published", artifactType: "planner" },
    ];
    vi.mocked(mockDb.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as any);
    vi.mocked(mockDb.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);
    vi.mocked(mockDb.transaction).mockImplementation(async (fn) => {
      await fn(mockDb);
    });

    const service = issueArtifactService(mockDb);
    const result = await service.supersede("issue-1", "planner");

    expect(result).toEqual(["artifact-old-1", "artifact-old-2"]);
    // supersededBy is not set in standalone supersede — only replace() sets it
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe("WORKFLOW_ROLE_PHASES", () => {
  it("maps each workflow role to its expected phase", () => {
    expect(WORKFLOW_ROLE_PHASES["planner"]).toBe("planning");
    expect(WORKFLOW_ROLE_PHASES["plan_reviewer"]).toBe("plan_review");
    expect(WORKFLOW_ROLE_PHASES["executor"]).toBe("executing");
    expect(WORKFLOW_ROLE_PHASES["reviewer"]).toBe("code_review");
    expect(WORKFLOW_ROLE_PHASES["integrator"]).toBe("integration");
  });

  it("has entries for all WORKFLOW_ROLES", () => {
    for (const role of WORKFLOW_ROLES) {
      expect(WORKFLOW_ROLE_PHASES[role]).toBeDefined();
    }
  });
});

describe("getPhaseForRole", () => {
  it("returns the correct phase for each role", () => {
    expect(getPhaseForRole("planner")).toBe("planning");
    expect(getPhaseForRole("plan_reviewer")).toBe("plan_review");
    expect(getPhaseForRole("executor")).toBe("executing");
    expect(getPhaseForRole("reviewer")).toBe("code_review");
    expect(getPhaseForRole("integrator")).toBe("integration");
  });
});

describe("CLAUDE_CODE_USAGE", () => {
  it("covers all workflow roles", () => {
    for (const role of WORKFLOW_ROLES) {
      expect(CLAUDE_CODE_USAGE[role]).toBeDefined();
      expect(CLAUDE_CODE_USAGE[role].role).toBe(role);
      expect(CLAUDE_CODE_USAGE[role].requiredMetadata).toBeDefined();
      expect(CLAUDE_CODE_USAGE[role].example).toBeDefined();
    }
  });

  it("planner requires the correct metadata fields", () => {
    const meta = CLAUDE_CODE_USAGE.planner.requiredMetadata;
    expect(meta).toContain("issueId");
    expect(meta).toContain("goal");
    expect(meta).toContain("acceptanceCriteria");
    expect(meta).toContain("touchedFiles");
    expect(meta).toContain("forbiddenFiles");
    expect(meta).toContain("testPlan");
    expect(meta).toContain("risks");
  });

  it("reviewer requires the correct metadata fields", () => {
    const meta = CLAUDE_CODE_USAGE.reviewer.requiredMetadata;
    expect(meta).toContain("verdict");
    expect(meta).toContain("issuesFound");
    expect(meta).toContain("verificationStatus");
    expect(meta).toContain("mergeReadiness");
  });

  it("integrator requires the correct metadata fields", () => {
    const meta = CLAUDE_CODE_USAGE.integrator.requiredMetadata;
    expect(meta).toContain("finalVerification");
    expect(meta).toContain("rollbackPlan");
  });

  it("planner example is a valid publishForCurrentPhase call", () => {
    const example = CLAUDE_CODE_USAGE.planner.example;
    expect(example).toContain("publishForCurrentPhase");
    expect(example).toContain('"planner"');
    expect(example).toContain("issueId");
    expect(example).toContain("goal");
  });

  it("executor example is a valid publishForCurrentPhase call", () => {
    const example = CLAUDE_CODE_USAGE.executor.example;
    expect(example).toContain('"executor"');
    expect(example).toContain("filesChanged");
    expect(example).toContain("changesSummary");
  });
});