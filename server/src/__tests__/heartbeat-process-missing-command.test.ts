import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping process-missing-command heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat process adapter missing command guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-process-missing-command-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
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
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to delete agents after 5 attempts");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.clearAllMocks();
    await tempDb?.cleanup();
  });

  it("cancels run with invalid_agent_config when process agent has empty adapterConfig", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    // Create a process agent with EMPTY adapterConfig (no command)
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BadProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {}, // Missing command!
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: null,
      processGroupId: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });

    // Trigger heartbeat scheduler to pick up the queued run
    await heartbeatService.startNextQueuedRunForAgent(agentId);

    // Wait for the run to settle
    const settledRun = await waitForRunToSettle(heartbeatService, runId);

    expect(settledRun).not.toBeNull();
    expect(settledRun!.status).toBe("failed");
    expect(settledRun!.errorCode).toBe("invalid_agent_config");
    expect(settledRun!.error).toContain("config.command");
  });

  it("allows run to proceed when process agent has valid command in adapterConfig", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    // Create a process agent with a valid command
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GoodProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo", args: ["hello"] },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: null,
      processGroupId: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });

    // Trigger heartbeat scheduler
    await heartbeatService.startNextQueuedRunForAgent(agentId);

    // Wait for the run to settle
    const settledRun = await waitForRunToSettle(heartbeatService, runId);

    // The run may succeed (mocked adapter) or fail for other reasons,
    // but it should NOT fail with invalid_agent_config
    expect(settledRun).not.toBeNull();
    expect(settledRun!.errorCode).not.toBe("invalid_agent_config");
  });
});
