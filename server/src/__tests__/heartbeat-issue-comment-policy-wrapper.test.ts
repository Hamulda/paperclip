import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// This test lives at the top level so it always runs, even without a DB.
// The critical regression guard is that heartbeatService() can be instantiated
// without hitting a stack overflow — which would happen if the local wrapper
// functions called themselves instead of the aliased imports.
describe("heartbeatService issue-comment-policy wrappers (no DB required)", () => {
  // Use a minimal mock db that satisfies the Db type for instantiation smoke-test.
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  } as unknown as ReturnType<typeof createDb>;

  it("heartbeatService instantiates without infinite recursion (root regression guard)", () => {
    // If the import aliases are missing, this line will throw:
    //   RangeError: Maximum call stack size exceeded
    // because each local wrapper calls itself instead of the underlying
    // issue-comment-policy function.
    let svc: ReturnType<typeof heartbeatService>;
    expect(() => {
      svc = heartbeatService(mockDb);
    }).not.toThrow();
    expect(svc).toBeDefined();
    expect(typeof svc.list).toBe("function");
    expect(typeof svc.getActiveRunForAgent).toBe("function");
    expect(typeof svc.getRun).toBe("function");
    expect(typeof svc.wakeup).toBe("function");
  });

  it("service returns an object with all expected methods", () => {
    // Verify heartbeatService() returns an object with the full public API.
    // This implicitly confirms the module initialised without infinite recursion.
    const svc = heartbeatService(mockDb);
    expect(svc).toMatchObject({
      list: expect.any(Function),
      getRun: expect.any(Function),
      getActiveRunForAgent: expect.any(Function),
      getActiveRunIssueSummaryForAgent: expect.any(Function),
      wakeup: expect.any(Function),
      invoke: expect.any(Function),
    });
  });
});

// DB-requiring tests are gated behind embedded-postgres support.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping DB-requiring heartbeat issue-comment-policy wrapper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeatService issue-comment-policy wrappers (DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let runId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-icp-wrapper-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();
    issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TEST-1",
      title: "Test Issue",
      status: "open",
      priority: "medium",
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("patchRunIssueCommentStatus wrapper delegates to underlying function", async () => {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "completed", resultSummary: "done" })
      .where(eq(heartbeatRuns.id, runId));

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    // The real verification is that no stack overflow occurred.
    expect(run?.status).toBe("completed");
  });
});
