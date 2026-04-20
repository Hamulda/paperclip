import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { swarmDigestRoutes } from "../routes/swarm-digest.js";
import type {
  SwarmDigest,
  SwarmDigestAgent,
  SwarmDigestRun,
  SwarmDigestWorkspace,
  SwarmDigestService,
  SwarmDigestFileClaimConflict,
  SwarmDigestFileClaimStale,
  SwarmDigestServiceDegraded,
  SwarmDigestRunStuck,
  SwarmDigestHandoff,
} from "@paperclipai/shared";

const mockBuildSwarmDigest = vi.hoisted(() =>
  vi.fn<
    [Db, { companyId: string; projectId: string | null; currentRunId?: string | null; currentAgentId?: string | null }],
    Promise<SwarmDigest>
  >(),
);

const mockCountRunningHotCodingRuns = vi.hoisted(() => vi.fn<[Db, string, (string | undefined)?], Promise<number>>());
const mockGetEffectiveHotCodingCapacity = vi.hoisted(() => vi.fn<[Db, string, (string | undefined)?], Promise<number>>());

vi.mock("../services/swarm-digest.js", () => ({
  buildSwarmDigest: mockBuildSwarmDigest,
}));

vi.mock("../services/hot-run-governor.js", () => ({
  countRunningHotCodingRuns: mockCountRunningHotCodingRuns,
  getEffectiveHotCodingCapacity: mockGetEffectiveHotCodingCapacity,
  SESSIONED_LOCAL_ADAPTERS: new Set(["claude", "codex", "cursor"]),
  HEARTBEAT_MAX_CONCURRENT_HOT_CODING_RUNS_DEFAULT: 3,
}));

function createMockDigest(overrides: Partial<{
  activeAgents: SwarmDigestAgent[];
  activeRuns: SwarmDigestRun[];
  workspaces: SwarmDigestWorkspace[];
  services: SwarmDigestService[];
  fileClaimConflicts: SwarmDigestFileClaimConflict[];
  fileClaimStale: SwarmDigestFileClaimStale[];
  servicesDegraded: SwarmDigestServiceDegraded[];
  runsStuck: SwarmDigestRunStuck[];
  recentHandoffs: SwarmDigestHandoff[];
}> = {}): SwarmDigest {
  return {
    companyId: "company-1",
    projectId: "project-1",
    generatedAt: "2026-04-19T10:00:00.000Z",
    activeAgents: [],
    activeRuns: [],
    workspaces: [],
    services: [],
    fileClaimConflicts: [],
    fileClaimStale: [],
    servicesDegraded: [],
    runsStuck: [],
    recentHandoffs: [],
    ...overrides,
  };
}

function createApp(db?: Db, authenticated = true) {
  const app = express();
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "admin", status: "active" },
        ],
      };
      next();
    });
  } else {
    app.use((req, _res, next) => {
      (req as any).actor = undefined;
      next();
    });
  }
  app.use(swarmDigestRoutes(db));
  return app;
}

describe("GET /companies/:companyId/swarm-digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when actor is not authenticated", async () => {
    // Set actor to { type: "none" } to properly trigger 401 via assertAuthenticated
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(swarmDigestRoutes({} as Db));

    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(401);
  });

  it("returns full digest with all four diagnostic arrays populated", async () => {
    const mockDigest = createMockDigest({
      activeAgents: [{ id: "agent-1", name: "Alice", status: "running" }],
      activeRuns: [{ id: "run-1", agentId: "agent-1", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null }],
      workspaces: [{ id: "ws-1", name: "feature-x", branchName: "feature-x", worktreePath: null, status: "active", sourceIssueId: null }],
      services: [{ id: "svc-1", serviceName: "web", status: "running", url: "http://localhost:3000", ownerAgentId: "agent-1" }],
      fileClaimConflicts: [{ claimPath: "src/a.ts", claimType: "file", conflictingAgentId: "agent-2", conflictingRunId: "run-2" }],
      fileClaimStale: [{ id: "claim-1", claimPath: "src/b.ts", claimType: "file", agentId: "agent-1", runId: "run-1", expiresAt: "2026-04-19T10:05:00.000Z", minutesUntilExpiry: 4 }],
      servicesDegraded: [{ id: "svc-2", serviceName: "api", status: "stopped", healthStatus: "degraded", url: null, ownerAgentId: null }],
      runsStuck: [{ id: "run-2", agentId: "agent-2", issueId: "issue-1", issueIdentifier: "PAP-1", issueTitle: "Fix bug", status: "queued", startedAt: "2026-04-19T09:00:00.000Z", minutesWaiting: 55 }],
      recentHandoffs: [{
        id: "hc-1",
        agentId: "agent-1",
        agentName: "Alice",
        runId: "run-1",
        issueId: "issue-1",
        issueIdentifier: "PAP-1",
        summary: "Completed auth module",
        filesTouched: ["src/auth/login.ts"],
        currentState: "Auth complete",
        remainingWork: ["Add tests"],
        blockers: [],
        recommendedNextStep: "Review PR",
        emittedAt: "2026-04-19T09:55:00.000Z",
      }],
    });

    mockBuildSwarmDigest.mockResolvedValueOnce(mockDigest);
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(2);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(res.body.projectId).toBe("project-1");
    expect(res.body.generatedAt).toBe("2026-04-19T10:00:00.000Z");
    expect(res.body.activeAgents).toHaveLength(1);
    expect(res.body.activeRuns).toHaveLength(1);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.fileClaimConflicts).toHaveLength(1);
    expect(res.body.fileClaimStale).toHaveLength(1);
    expect(res.body.servicesDegraded).toHaveLength(1);
    expect(res.body.runsStuck).toHaveLength(1);
    expect(res.body.recentHandoffs).toHaveLength(1);
    expect(res.body.hotSlotUsage).toEqual({ current: 2, max: 3 });
    expect(res.body.queuedHotRunsCount).toBe(0);
  });

  it("returns empty arrays when no issues exist", async () => {
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest());
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.fileClaimStale).toEqual([]);
    expect(res.body.servicesDegraded).toEqual([]);
    expect(res.body.runsStuck).toEqual([]);
    expect(res.body.recentHandoffs).toEqual([]);
    expect(res.body.hotSlotUsage.current).toBe(0);
    expect(res.body.hotSlotUsage.max).toBe(3);
  });

  it("passes projectId query param to buildSwarmDigest when provided", async () => {
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest());
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    await request(app).get("/companies/company-1/swarm-digest?projectId=project-42");

    expect(mockBuildSwarmDigest).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ companyId: "company-1", projectId: "project-42" }),
    );
  });

  it("passes projectId to hot slot functions when scoped to a project", async () => {
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest());
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(1);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(2);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    await request(app).get("/companies/company-1/swarm-digest?projectId=project-42");

    expect(mockCountRunningHotCodingRuns).toHaveBeenCalledWith(
      mockDb,
      "company-1",
      "project-42",
    );
    expect(mockGetEffectiveHotCodingCapacity).toHaveBeenCalledWith(
      mockDb,
      "company-1",
      "project-42",
    );
  });

  it("does not pass projectId to hot slot functions when viewing company-wide", async () => {
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest());
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    await request(app).get("/companies/company-1/swarm-digest");

    expect(mockCountRunningHotCodingRuns).toHaveBeenCalledWith(
      mockDb,
      "company-1",
      undefined,
    );
    expect(mockGetEffectiveHotCodingCapacity).toHaveBeenCalledWith(
      mockDb,
      "company-1",
      undefined,
    );
  });

  it("returns correct hotSlotUsage shape when hot runs are at capacity", async () => {
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest());
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(3);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.hotSlotUsage).toEqual({ current: 3, max: 3 });
  });

  it("includes stale claim data with correct fields in response", async () => {
    const staleClaims = [{
      id: "claim-stale-1",
      claimPath: "src/expiring.ts",
      claimType: "file",
      agentId: "agent-1",
      runId: "run-1",
      expiresAt: "2026-04-19T10:02:00.000Z",
      minutesUntilExpiry: 1,
    }];
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest({ fileClaimStale: staleClaims }));
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.fileClaimStale[0]).toMatchObject({
      id: "claim-stale-1",
      claimPath: "src/expiring.ts",
      minutesUntilExpiry: 1,
    });
  });

  it("includes degraded service data with healthStatus in response", async () => {
    const degradedSvcs = [{
      id: "svc-bad",
      serviceName: "broken-api",
      status: "failed",
      healthStatus: "unhealthy",
      url: null,
      ownerAgentId: null,
    }];
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest({ servicesDegraded: degradedSvcs }));
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.servicesDegraded[0].healthStatus).toBe("unhealthy");
  });

  it("includes stuck run data with minutesWaiting in response", async () => {
    const stuckRuns = [{
      id: "run-stuck-1",
      agentId: "agent-1",
      issueId: "issue-x",
      issueIdentifier: "PAP-99",
      issueTitle: "Long task",
      status: "queued",
      startedAt: "2026-04-19T08:00:00.000Z",
      minutesWaiting: 110,
    }];
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest({ runsStuck: stuckRuns }));
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.runsStuck[0].minutesWaiting).toBe(110);
  });

  it("includes recent handoff data with all required fields in response", async () => {
    const handoffs = [{
      id: "hc-2",
      agentId: "agent-2",
      agentName: "Bob",
      runId: "run-3",
      issueId: null,
      issueIdentifier: null,
      summary: "Handed off work on auth",
      filesTouched: ["auth.ts", "session.ts"],
      currentState: "Auth implemented",
      remainingWork: ["Tests"],
      blockers: [],
      recommendedNextStep: "Write tests",
      emittedAt: "2026-04-19T09:00:00.000Z",
    }];
    mockBuildSwarmDigest.mockResolvedValueOnce(createMockDigest({ recentHandoffs: handoffs }));
    mockCountRunningHotCodingRuns.mockResolvedValueOnce(0);
    mockGetEffectiveHotCodingCapacity.mockResolvedValueOnce(3);

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        then: (resolve: any) => resolve([{ count: 0 }]),
      })),
    } as unknown as Db;

    const app = createApp(mockDb);
    const res = await request(app).get("/companies/company-1/swarm-digest");

    expect(res.status).toBe(200);
    expect(res.body.recentHandoffs[0]).toMatchObject({
      agentName: "Bob",
      summary: "Handed off work on auth",
      recommendedNextStep: "Write tests",
    });
  });
});
