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
// Regression test 1: session-compaction module has no backward dependency on
// heartbeat.ts. Previously session-compaction.ts line 9 had:
//   import { parseSessionCompactionPolicy } from "./heartbeat.js";
// creating a backward dependency cycle.
//
// Fix: parseSessionCompactionPolicy is now defined locally in session-compaction.ts
// (calling adapter-utils directly). heartbeat.ts re-exports it from session-compaction.ts
// for backward compatibility with external callers.
//
// We verify the fix works by:
// 1. Testing evaluateSessionCompaction() returns correct shape with a mock
// 2. Verifying session-compaction.ts has no import from heartbeat.ts
// 3. Verifying heartbeat.ts re-exports parseSessionCompactionPolicy from session-compaction.ts
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

  it("session-compaction.ts does NOT import parseSessionCompactionPolicy from heartbeat.ts (source check)", () => {
    // The backward dependency was: session-compaction.ts -> heartbeat.ts
    // Fix: parseSessionCompactionPolicy is now defined locally in session-compaction.ts
    // and heartbeat.ts re-exports it from session-compaction.ts.
    // session-compaction.ts should NOT import from heartbeat.ts anymore.
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/session-compaction.ts",
      "utf8",
    );

    // session-compaction.ts should NOT import anything from heartbeat.js
    expect(source).not.toContain('from "./heartbeat.js"');
    // session-compaction.ts should have its own parseSessionCompactionPolicy
    expect(source).toMatch(/export function parseSessionCompactionPolicy/);
  });

  it("heartbeat.ts re-exports parseSessionCompactionPolicy from session-compaction.ts (source check)", () => {
    // heartbeat.ts now re-exports parseSessionCompactionPolicy from session-compaction.ts
    // to maintain backward compatibility for external callers (tests, etc.)
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // heartbeat.ts imports parseSessionCompactionPolicy from session-compaction.ts
    expect(source).toMatch(/import\s*\{[^}]*parseSessionCompactionPolicy[^}]*\}\s*from\s*"\.\/session-compaction\.js"/);
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
// Regression test 7: withAgentStartLock and startLocksByAgent are a single
// canonical copy in run-claim-lifecycle.ts. heartbeat.ts previously had its own
// private copy at lines ~314-329, creating a split-brain lock namespace where
// startNextQueuedRunForAgent used a different Map than callers importing from
// run-claim-lifecycle.
//
// The fix: heartbeat.ts now imports withAgentStartLock from run-claim-lifecycle.
// We verify:
// 1. heartbeat.ts does NOT have a private startLocksByAgent Map
// 2. heartbeat.ts does NOT have a private withAgentStartLock function
// 3. heartbeat.ts imports withAgentStartLock from run-claim-lifecycle.js
// =============================================================================
describe("withAgentStartLock canonical source verification", () => {
  it("heartbeat.ts does NOT have a private startLocksByAgent Map", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // The old private copy pattern was:
    //   const startLocksByAgent = new Map<string, Promise<void>>();
    const privateMapRe = /^const startLocksByAgent\s*=\s*new\s+Map/m;
    expect(source).not.toMatch(privateMapRe);
  });

  it("heartbeat.ts does NOT have a private withAgentStartLock function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // The old private copy was an async function:
    //   async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
    const privateFnRe = /^async function withAgentStartLock/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts imports withAgentStartLock from run-claim-lifecycle.js", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    expect(source).toMatch(
      /import\s*\{[^}]*withAgentStartLock[^}]*\}\s*from\s*"\.\/run-claim-lifecycle\.js"/,
    );
  });
});

// =============================================================================
// Regression test 8: parseHeartbeatPolicy is a single canonical copy in
// run-claim-lifecycle.ts. heartbeat.ts previously had its own private copy at
// line ~1258, creating a split-brain risk where the two implementations could
// drift.
//
// The fix: parseHeartbeatPolicy is now only in run-claim-lifecycle.ts.
// heartbeat.ts imports it from there and has no private copy.
// We verify:
// 1. heartbeat.ts does NOT have a private parseHeartbeatPolicy function
// 2. heartbeat.ts imports parseHeartbeatPolicy from run-claim-lifecycle.js
// 3. run-claim-lifecycle.ts does NOT use dynamic require()
// =============================================================================
describe("parseHeartbeatPolicy canonical source verification", () => {
  it("heartbeat.ts does NOT have a private parseHeartbeatPolicy function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    const privateFnRe = /^  function parseHeartbeatPolicy/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts imports parseHeartbeatPolicy from run-claim-lifecycle.js", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    expect(source).toMatch(
      /import\s*\{[^}]*parseHeartbeatPolicy[^}]*\}\s*from\s*"\.\/run-claim-lifecycle\.js"/,
    );
  });

  it("run-claim-lifecycle.ts parseHeartbeatPolicy does NOT use dynamic require", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/run-claim-lifecycle.ts",
      "utf8",
    );

    // The old pattern was: const { parseObject, asBoolean } = require("../adapters/utils.js");
    expect(source).not.toMatch(/require\s*\(\s*["']\.\.\/adapters\/utils\.js["']\s*\)/);
  });
});

// =============================================================================
// Regression test 9: session-resolver.ts is the canonical source for session
// resolution functions. heartbeat.ts previously had private copies of:
// - getTaskSession
// - getRuntimeState
// - resolveSessionBeforeForWakeup
// - resolveExplicitResumeSessionOverride
// causing split-brain behavior when external callers used run-claim-lifecycle
// which imported from session-state-manager but heartbeat had its own copies.
//
// The fix: all four functions are now in session-resolver.ts with db as explicit
// first parameter. heartbeat.ts imports from session-resolver.ts.
// We verify:
// 1. heartbeat.ts does NOT have private getTaskSession or getRuntimeState
// 2. heartbeat.ts imports the four functions from session-resolver.ts
// 3. session-resolver.ts exports all four functions
// 4. session-compaction.ts does NOT import anything from heartbeat.ts
// =============================================================================
describe("session-resolver canonical source verification", () => {
  it("heartbeat.ts does NOT have a private getTaskSession function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // The old private copy pattern was:
    //   async function getTaskSession(
    const privateFnRe = /^  async function getTaskSession/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts does NOT have a private getRuntimeState function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    // The old private copy pattern was:
    //   async function getRuntimeState(
    const privateFnRe = /^  async function getRuntimeState/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts does NOT have a private resolveSessionBeforeForWakeup function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    const privateFnRe = /^  async function resolveSessionBeforeForWakeup/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts does NOT have a private resolveExplicitResumeSessionOverride function", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    const privateFnRe = /^  async function resolveExplicitResumeSessionOverride/m;
    expect(source).not.toMatch(privateFnRe);
  });

  it("heartbeat.ts imports session resolution functions from session-resolver.js", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/heartbeat.ts",
      "utf8",
    );

    expect(source).toMatch(
      /import\s*\{[^}]*getTaskSession[^}]*\}\s*from\s*"\.\/session-resolver\.js"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*getRuntimeState[^}]*\}\s*from\s*"\.\/session-resolver\.js"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*resolveSessionBeforeForWakeup[^}]*\}\s*from\s*"\.\/session-resolver\.js"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*resolveExplicitResumeSessionOverride[^}]*\}\s*from\s*"\.\/session-resolver\.js"/,
    );
  });

  it("session-resolver.ts exports all four session resolution functions", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/session-resolver.ts",
      "utf8",
    );

    expect(source).toMatch(/export async function getTaskSession/);
    expect(source).toMatch(/export async function getRuntimeState/);
    expect(source).toMatch(/export async function resolveSessionBeforeForWakeup/);
    expect(source).toMatch(/export async function resolveExplicitResumeSessionOverride/);
  });

  it("session-resolver.ts does NOT import from heartbeat.ts (no reverse dependency)", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      "/Users/vojtechhamada/paperclip/server/src/services/session-resolver.ts",
      "utf8",
    );

    expect(source).not.toContain('from "./heartbeat.js"');
    expect(source).not.toContain('from "../services/heartbeat.js"');
  });
});
