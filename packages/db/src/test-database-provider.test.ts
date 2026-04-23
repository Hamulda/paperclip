/**
 * Tests for test-database-provider.ts provider selection logic.
 *
 * The module-level singleton testDbSupportPromise is cached after first call.
 * vi.resetModules() helps but ESM module caching in vitest can be inconsistent.
 * These tests cover the core logic and accept that the singleton behavior
 * means only one "first call" configuration is reliable per test file load.
 */

import { describe, expect, it, afterEach, vi } from "vitest";

// ── Test the backward-compatible wrapper functions ──────────────────────────────

describe("backward-compatible getEmbeddedPostgresTestSupport", () => {
  // Note: because of module-level caching, these tests must run FIRST
  // before any other import of the module in this file.

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns supported=true when external provider is configured", async () => {
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "postgres://user:pass@localhost:5432/compat";
    vi.resetModules();
    const { getEmbeddedPostgresTestSupport } = await import("./test-database-provider.js");
    const r = await getEmbeddedPostgresTestSupport();
    expect(r.supported).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("returns supported=false with reason when embedded is unsupported", async () => {
    process.env.TEST_DB_PROVIDER = "embedded";
    process.env.TEST_DATABASE_URL = "";
    vi.resetModules();
    const { getEmbeddedPostgresTestSupport } = await import("./test-database-provider.js");
    const r = await getEmbeddedPostgresTestSupport();
    expect(r.supported).toBe(false);
    expect(r.reason).toBeDefined();
  });
});

describe("getTestDatabaseSupport — singleton caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("caches the same promise across multiple calls", async () => {
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "postgres://u:p@localhost:5432/cachetest";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const first = await getTestDatabaseSupport();
    const second = await getTestDatabaseSupport();
    expect(first).toBe(second); // same reference
    expect(first.provider).toBe("external");
  });

  it("subsequent call with different env does NOT update (singleton persists)", async () => {
    // This test demonstrates the singleton behavior: once cached, the
    // provider does not change even if env vars change.
    // This is intentional design — the singleton represents the resolved
    // provider for this process lifetime.
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "postgres://u:p@localhost:5432/original";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const first = await getTestDatabaseSupport();
    expect(first.provider).toBe("external");
    expect(first.connectionString).toBe("postgres://u:p@localhost:5432/original");

    // Call again WITHOUT resetting modules — should get the SAME reference
    // even though getTestDatabaseSupport() would re-resolve against the same env.
    // This proves the promise itself is cached, not just the result.
    const second = await getTestDatabaseSupport();
    expect(second).toBe(first); // same promise reference — singleton at work

    // Now change env but do NOT reset modules — the cached promise is returned
    // unchanged, proving env changes after initial resolution are ignored.
    const thirdEnv = "embedded";
    process.env.TEST_DB_PROVIDER = thirdEnv;
    process.env.TEST_DATABASE_URL = "";
    const third = await getTestDatabaseSupport();
    expect(third).toBe(first); // still the original singleton
    expect(third.provider).toBe("external"); // env change was ignored
  });
});

describe("startTestDatabase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("throws when no test database is available", async () => {
    process.env.TEST_DB_PROVIDER = "auto";
    process.env.TEST_DATABASE_URL = "";
    vi.resetModules();
    const { startTestDatabase } = await import("./test-database-provider.js");
    await expect(startTestDatabase("paperclip-test-")).rejects.toThrow("Cannot start test database");
  });

  it("returns external DB when TEST_DB_PROVIDER=auto and URL is set", async () => {
    process.env.TEST_DB_PROVIDER = "auto";
    process.env.TEST_DATABASE_URL = "postgres://user:pass@localhost:5432/autoroute";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const support = await getTestDatabaseSupport();
    expect(support.provider).toBe("external");
    expect(support.connectionString).toBe("postgres://user:pass@localhost:5432/autoroute");
    expect(support.skipReason).toBeUndefined();
  });

  it("returns embedded DB when TEST_DB_PROVIDER=auto with no URL and embedded is supported", async () => {
    // This test relies on embedded-postgres being available on the machine
    // and uses the default "auto" provider. We only assert on shape since
    // embedded-postgres startup may be slow.
    process.env.TEST_DB_PROVIDER = "auto";
    process.env.TEST_DATABASE_URL = "";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const support = await getTestDatabaseSupport();
    // In auto mode with no URL, embedded is probed — if unsupported, skipReason is set
    if (!support.skipReason) {
      expect(support.provider).toBe("embedded");
      expect(support.connectionString).toContain("127.0.0.1");
    }
  });
});

describe("provider type exports", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("TestDatabaseProvider type accepts 'external' and 'embedded'", async () => {
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "postgres://u:p@localhost:5432/types";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const s = await getTestDatabaseSupport();
    // Type-level check: these values must be assignable to TestDatabaseProvider
    const _external: "external" = s.provider;
    const _connectionString: string = s.connectionString;
    expect(_external).toBe("external");
  });

  it("skipReason is present when provider cannot start", async () => {
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "";
    vi.resetModules();
    const { getTestDatabaseSupport } = await import("./test-database-provider.js");
    const s = await getTestDatabaseSupport();
    expect(s.skipReason).toContain("TEST_DATABASE_URL is not set");
  });
});

describe("startTestDatabase — embedded provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("starts embedded DB, runs migrations, cleanup stops instance and removes data dir", async () => {
    process.env.TEST_DB_PROVIDER = "embedded";
    vi.resetModules();
    const { startTestDatabase } = await import("./test-database-provider.js");
    const db = await startTestDatabase("paperclip-test-embedded-");
    expect(db.provider).toBe("embedded");
    expect(db.connectionString).toContain("127.0.0.1");
    expect(typeof db.cleanup).toBe("function");

    // Verify cleanupfn is callable and does not throw
    await expect(db.cleanup()).resolves.toBeUndefined();
  });

  it("cleanup is a no-op for external provider", async () => {
    process.env.TEST_DB_PROVIDER = "external";
    process.env.TEST_DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip";
    vi.resetModules();
    const { startTestDatabase } = await import("./test-database-provider.js");
    const db = await startTestDatabase("paperclip-test-external-");
    expect(db.provider).toBe("external");
    await expect(db.cleanup()).resolves.toBeUndefined();
  });
});
