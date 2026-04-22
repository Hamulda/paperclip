export {
  getTestDatabaseSupport,
  startTestDatabase,
  type TestDatabaseSupport,
  type TestDatabase,
  type TestDatabaseProvider,
} from "@paperclipai/db";

// Backward-compatible re-exports
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";