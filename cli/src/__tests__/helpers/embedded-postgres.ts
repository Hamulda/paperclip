export {
  getTestDatabaseSupport,
  startTestDatabase,
  type TestDatabaseSupport,
  type TestDatabase,
  type TestDatabaseProvider,
} from "@paperclipai/db";

// Backward-compatible re-exports for tests that still use the old API.
// Prefer getTestDatabaseSupport / startTestDatabase in new tests.
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";