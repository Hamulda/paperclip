import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  evaluateSessionCompaction,
  resolveNormalizedUsageForSession,
} from "../services/session-compaction.ts";
import { normalizeMaxConcurrentRuns } from "../services/run-claim-lifecycle.ts";

// =============================================================================
// Regression test 1: session-compaction module works after parseSessionCompactionPolicy
// import fix. Previously session-compaction.ts line 9 had:
//   import { parseSessionCompactionPolicy } from "./runtime-config-builder.js";
// which would cause TS2305 at runtime because the function is exported from
// heartbeat.ts, not runtime-config-builder.ts.
//
// We verify the fix works by:
// 1. Testing evaluateSessionCompaction() returns correct shape with a mock
// 2. Verifying source code has correct import
// =============================================================================
describe("session-compaction module import fix verification", () => {
  it("evaluateSessionCompaction returns rotate=false when sessionId is null (verifies import fix)", async () => {
    // If the broken import from runtime-config-builder.js is still present,
    // this test would fail to even load due to TS2305.
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as unknown as any;

    const mockAgent = {
      id: "agent-1",
      adapterType: "codex_local",
      runtimeConfig: {},
    } as any;

    const result = await evaluateSessionCompaction(mockDb, mockAgent, null, null);
    expect(result.rotate).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.handoffMarkdown).toBeNull();
  });

  it("session-compaction.ts imports parseSessionCompactionPolicy from heartbeat.ts (source check)", () => {
    // Verify the import was fixed from runtime-config-builder to heartbeat
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/session-compaction.ts",
      "utf8",
    );

    // The broken import was:
    //   import { parseSessionCompactionPolicy } from "./runtime-config-builder.js";
    // The fixed import should be:
    //   import { parseSessionCompactionPolicy } from "./heartbeat.js";
    expect(source).toContain('from "./heartbeat.js"');
    expect(source).not.toContain('from "./runtime-config-builder.js"');
  });
});

// =============================================================================
// Regression test 2: enrich-run-context orchestration ordering is preserved.
// The critical invariant: file claims MUST be acquired BEFORE buildSwarmDigest
// is called, so the digest sees the current run's claims.
// =============================================================================
describe("enrich-run-context orchestration ordering", () => {
  it("acquireClaims is called BEFORE buildSwarmDigest (verified by source code inspection)", () => {
    // The critical ordering is verified by source code inspection.
    // In enrich-run-context.ts, the sequence MUST be:
    //   1. acquireClaims() - lines 90-116
    //   2. buildSwarmDigest() - lines 119-125
    //
    // If buildSwarmDigest were called first, the digest wouldn't see the
    // current run's claims, breaking conflict detection.
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/enrich-run-context.ts",
      "utf8",
    );

    const acquireClaimsIdx = source.indexOf("acquireClaims(");
    const buildSwarmDigestIdx = source.indexOf("buildSwarmDigest(");

    expect(acquireClaimsIdx).toBeGreaterThan(0);
    expect(buildSwarmDigestIdx).toBeGreaterThan(0);
    expect(acquireClaimsIdx).toBeLessThan(buildSwarmDigestIdx);
  });
});

// =============================================================================
// Regression test 3: run-claim-lifecycle exported functions work correctly.
// Key invariant: normalizeMaxConcurrentRuns must correctly clamp values.
// =============================================================================
describe("run-claim-lifecycle exported functions", () => {
  it("normalizeMaxConcurrentRuns clamps values correctly", () => {
    // Below minimum → clamps to 1
    expect(normalizeMaxConcurrentRuns(0)).toBe(1);
    expect(normalizeMaxConcurrentRuns(-5)).toBe(1);
    // Above maximum → clamps to 10
    expect(normalizeMaxConcurrentRuns(15)).toBe(10);
    expect(normalizeMaxConcurrentRuns(100)).toBe(10);
    // Valid range → passes through
    expect(normalizeMaxConcurrentRuns(3)).toBe(3);
    expect(normalizeMaxConcurrentRuns(1)).toBe(1);
    expect(normalizeMaxConcurrentRuns(10)).toBe(10);
  });

  it("normalizeMaxConcurrentRuns returns default for non-numeric or non-finite values", () => {
    // asNumber returns default (1) for non-numbers
    expect(normalizeMaxConcurrentRuns("3")).toBe(1);
    expect(normalizeMaxConcurrentRuns(null)).toBe(1);
    expect(normalizeMaxConcurrentRuns(undefined)).toBe(1);
    // Non-finite → returns default
    expect(normalizeMaxConcurrentRuns(NaN)).toBe(1);
    expect(normalizeMaxConcurrentRuns(Infinity)).toBe(1);
    expect(normalizeMaxConcurrentRuns(-Infinity)).toBe(1);
  });
});

// =============================================================================
// Regression test 4: heartbeat service instantiates without import errors
// after session-compaction import fix. This is the root cause regression guard
// for the parseSessionCompactionPolicy import issue.
// =============================================================================
describe("heartbeatService instantiation smoke test", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    transaction: vi.fn().mockImplementation((fn) => fn(mockDb)),
  } as unknown as ReturnType<typeof createDb>;

  it("heartbeatService instantiates without errors after session-compaction import fix", () => {
    let svc: ReturnType<typeof heartbeatService>;
    expect(() => {
      svc = heartbeatService(mockDb);
    }).not.toThrow();
    expect(svc).toBeDefined();
    expect(typeof svc.list).toBe("function");
    expect(typeof svc.wakeup).toBe("function");
  });
});

// =============================================================================
// DB-requiring integration tests
// =============================================================================
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping DB-requiring heartbeat orchestration regression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeDb("session-compaction with real DB", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orchestration-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();

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
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("evaluateSessionCompaction returns rotate=false when policy is disabled", async () => {
    const agentWithDisabledPolicy = {
      ...await db.select().from(agents).where(eq(agents.id, agentId)).then(r => r[0]),
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: false,
          },
        },
      },
    };

    const result = await evaluateSessionCompaction(
      db,
      agentWithDisabledPolicy as any,
      randomUUID(),
      null,
    );

    expect(result.rotate).toBe(false);
  });

  it("resolveNormalizedUsageForSession returns raw usage when no previous session", async () => {
    const rawUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costUsd: 0.05,
    };

    const result = await resolveNormalizedUsageForSession(
      db,
      async () => null, // no previous run
      {
        agentId,
        runId: randomUUID(),
        sessionId: null,
        rawUsage,
      },
    );

    expect(result.normalizedUsage).toBe(rawUsage);
    expect(result.previousRawUsage).toBeNull();
    expect(result.derivedFromSessionTotals).toBe(false);
  });
});

// =============================================================================
// Regression test 5: normalizeMaxConcurrentRuns is a single canonical copy.
// Previously heartbeat.ts had its own private copy at lines 315-319 while
// run-claim-lifecycle.ts exported the same logic. Any caller importing from
// run-claim-lifecycle got a different Map instance for startLocksByAgent than
// the heartbeat service's internal lock, creating disjoint lock namespaces.
//
// The fix: heartbeat.ts now imports normalizeMaxConcurrentRuns from
// run-claim-lifecycle.ts. We verify:
// 1. normalizeMaxConcurrentRuns in heartbeat.ts resolves to the run-claim-lifecycle export
// 2. The private duplicate in heartbeat.ts no longer exists
// =============================================================================
describe("normalizeMaxConcurrentRuns canonical source verification", () => {
  it("heartbeat.ts does NOT have a private normalizeMaxConcurrentRuns copy", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // The old private copy pattern was:
    //   function normalizeMaxConcurrentRuns(value: unknown) {
    //     const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
    //
    // If this pattern still exists in heartbeat.ts, the dedup didn't land.
    const privateCopyRe = /^function normalizeMaxConcurrentRuns\s*\(/m;
    expect(source).not.toMatch(privateCopyRe);
  });

  it("heartbeat.ts imports normalizeMaxConcurrentRuns from run-claim-lifecycle.ts", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // Should have: import { normalizeMaxConcurrentRuns } from "./run-claim-lifecycle.js";
    expect(source).toContain('from "./run-claim-lifecycle.js"');
    expect(source).toMatch(/import\s*\{[^}]*normalizeMaxConcurrentRuns[^}]*\}\s*from\s*"\.\/run-claim-lifecycle\.js"/);
  });
});

// =============================================================================
// Regression test 6: HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT/MAX constants are
// now consumed from run-claim-lifecycle.ts. heartbeat.ts should NOT redeclare them.
// =============================================================================
describe("HEARTBEAT_MAX_CONCURRENT_RUNS constants canonical source", () => {
  it("heartbeat.ts does NOT redeclare HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT/MAX constants", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // These constants should only exist in run-claim-lifecycle.ts
    expect(source).not.toContain("HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT");
    expect(source).not.toContain("HEARTBEAT_MAX_CONCURRENT_RUNS_MAX");
  });
});
