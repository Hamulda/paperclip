import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hot coding governor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat hot coding concurrency governor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hot-coding-governor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Wait for runs to settle
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (runs.every((run) => run.status !== "queued" && run.status !== "running")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function createAgent(agentId: string, companyId: string, adapterType: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${adapterType}`,
      role: "engineer",
      status: "running",
      adapterType,
      adapterConfig: {},
      runtimeConfig: JSON.stringify({
        heartbeat: { enabled: true, intervalSec: 60 },
      }),
      permissions: {},
    });
  }

  async function createQueuedRun(runId: string, companyId: string, agentId: string) {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: { issueId: randomUUID() },
    });
  }

  it("governor defers hot coding runs when limit is reached", async () => {
    const companyId = randomUUID();
    await createCompany(companyId);

    // Create 3 hot coding agents (claude_local is in SESSIONED_LOCAL_ADAPTERS)
    const agentIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const agentId of agentIds) {
      await createAgent(agentId, companyId, "claude_local");
    }

    // Create 3 queued runs, one for each agent
    const runIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      await createQueuedRun(runIds[i], companyId, agentIds[i]);
    }

    const heartbeat = heartbeatService(db);

    // Resume queued runs - governor should defer the 3rd run
    await heartbeat.resumeQueuedRuns();

    // Wait for any async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check: runs should either be running, succeeded, or queued
    // The key is that NOT ALL 3 should have transitioned to succeeded/running
    // At least 1 should still be queued (deferred by the governor)
    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);

    const queuedCount = allRuns.filter((r) => r.status === "queued").length;

    // The governor should have deferred at least 1 run
    // So at least 1 should still be in queued status
    expect(queuedCount).toBeGreaterThanOrEqual(1);
  });

  it("governor does not affect non-hot-coding adapters", async () => {
    const companyId = randomUUID();
    await createCompany(companyId);

    // Create a non-hot-coding agent
    const agentId = randomUUID();
    await createAgent(agentId, companyId, "http_remote");

    // Create 2 queued runs
    await createQueuedRun(randomUUID(), companyId, agentId);
    await createQueuedRun(randomUUID(), companyId, agentId);

    const heartbeat = heartbeatService(db);

    // Resume queued runs
    await heartbeat.resumeQueuedRuns();

    // Wait for any async operations
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Per-agent limit is 1, so 1 should run, 1 should stay queued
    // But the hot coding governor should NOT affect this at all
    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);

    const runningCount = allRuns.filter((r) => r.status === "running").length;

    // Per-agent limit of 1 applies
    expect(runningCount).toBeLessThanOrEqual(1);
  });
});
