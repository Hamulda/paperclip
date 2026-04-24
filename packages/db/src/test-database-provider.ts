import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type TestDatabaseProvider = "external" | "embedded";

export type TestDatabaseSupport = {
  provider: TestDatabaseProvider;
  connectionString: string;
  skipReason?: string;
  reason?: string; // embedded-only, here for backward compat
};

export type TestDatabase = {
  provider: TestDatabaseProvider;
  connectionString: string;
  cleanup(): Promise<void>;
};

let testDbSupportPromise: Promise<TestDatabaseSupport> | null = null;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

async function probeEmbeddedPostgresSupport(): Promise<{ supported: boolean; reason?: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-postgres-probe-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await instance.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function resolveExternalTestDatabaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  return url || null;
}

/**
 * Resolves the test database provider based on TEST_DB_PROVIDER and TEST_DATABASE_URL.
 *
 * Provider logic:
 * - TEST_DB_PROVIDER=external  → always use TEST_DATABASE_URL, fail if not set
 * - TEST_DB_PROVIDER=embedded  → always use embedded (skip if unsupported)
 * - TEST_DB_PROVIDER=auto (default):
 *     - if TEST_DATABASE_URL is set → use external
 *     - otherwise → probe and use embedded (skip with reason if unsupported)
 * - TEST_DB_PROVIDER unset (default):
 *     - treated as "auto"
 */
function resolveTestDbProvider(): TestDatabaseProvider | "auto" {
  const env = process.env.TEST_DB_PROVIDER?.trim().toLowerCase();
  if (env === "external" || env === "embedded") return env;
  return "auto";
}

/**
 * Probe which test database backends are available on this machine.
 * Result is cached after first call.
 */
export async function getTestDatabaseSupport(): Promise<TestDatabaseSupport> {
  if (!testDbSupportPromise) {
    testDbSupportPromise = resolveTestDbSupport();
  }
  return await testDbSupportPromise;
}

async function resolveTestDbSupport(): Promise<TestDatabaseSupport> {
  const provider = resolveTestDbProvider();
  const externalUrl = resolveExternalTestDatabaseUrl();

  // Explicit external request
  if (provider === "external") {
    if (!externalUrl) {
      return {
        provider: "external",
        connectionString: "",
        skipReason: "TEST_DB_PROVIDER=external but TEST_DATABASE_URL is not set",
        reason: "TEST_DB_PROVIDER=external but TEST_DATABASE_URL is not set",
      };
    }
    return { provider: "external", connectionString: externalUrl };
  }

  // External via auto when URL is provided
  if (externalUrl) {
    return { provider: "external", connectionString: externalUrl };
  }

  // Embedded path
  if (provider === "embedded") {
    const probe = await probeEmbeddedPostgresSupport();
    if (!probe.supported) {
      return {
        provider: "embedded",
        connectionString: "",
        skipReason: `embedded-postgres not supported on this machine: ${probe.reason}`,
        reason: probe.reason,
      };
    }
    const port = await getAvailablePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-db-"));
    return {
      provider: "embedded",
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      // Store temp dir for cleanup — communicated via non-exported field via closure
    } as TestDatabaseSupport & { _tempDir?: string };
  }

  // Auto with no external URL — probe embedded
  const probe = await probeEmbeddedPostgresSupport();
  if (probe.supported) {
    const port = await getAvailablePort();
    return {
      provider: "embedded",
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    };
  }

  return {
    provider: "embedded",
    connectionString: "",
    skipReason: `No test database available. Set TEST_DATABASE_URL for an external Postgres, or fix embedded-postgres: ${probe.reason}`,
    reason: probe.reason,
  };
}

/**
 * Start a test database instance. Returns a connection string and cleanup fn.
 * Only valid when getTestDatabaseSupport() indicates support (no skipReason).
 */
export async function startTestDatabase(
  tempDirPrefix: string,
): Promise<TestDatabase> {
  const support = await getTestDatabaseSupport();

  if (support.skipReason) {
    throw new Error(`Cannot start test database: ${support.skipReason}`);
  }

  const testDbProvider = resolveTestDbProvider();

  if (support.provider === "external") {
    // External DB — skip migrations if TEST_DB_PROVIDER=external was explicitly set
    // (the DB is pre-managed; migrations would require a live server which may not be available)
    // When URL is auto-detected (auto mode with TEST_DATABASE_URL set), still run migrations.
    if (testDbProvider === "external") {
      return {
        provider: "external",
        connectionString: support.connectionString,
        cleanup: async () => {
          // External DB is managed externally — nothing to clean up
        },
      };
    }
    await applyPendingMigrations(support.connectionString);
    return {
      provider: "external",
      connectionString: support.connectionString,
      cleanup: async () => {
        // External DB is managed externally — nothing to clean up
      },
    };
  }

  // Embedded path
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      provider: "embedded",
      connectionString,
      cleanup: async () => {
        await instance.stop().catch(() => {});
        fs.rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await instance.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}

/**
 * Backward-compatible re-exports for existing test files.
 * @deprecated Use getTestDatabaseSupport() / startTestDatabase() directly.
 */
export const getEmbeddedPostgresTestSupport = (): Promise<{
  supported: boolean;
  reason?: string;
}> =>
  getTestDatabaseSupport().then((s) => ({ supported: !s.skipReason, reason: s.reason }));

export const startEmbeddedPostgresTestDatabase = (
  tempDirPrefix: string,
): Promise<{ connectionString: string; cleanup(): Promise<void> }> =>
  startTestDatabase(tempDirPrefix).then((db) => ({
    connectionString: db.connectionString,
    cleanup: db.cleanup,
  }));

export type EmbeddedPostgresTestDatabase = { connectionString: string; cleanup(): Promise<void> };
export type EmbeddedPostgresTestSupport = { supported: boolean; reason?: string };