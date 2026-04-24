// Canonical test database provider API.
export {
  getTestDatabaseSupport,
  startTestDatabase,
  type TestDatabaseSupport,
  type TestDatabase,
  type TestDatabaseProvider,
} from "@paperclipai/db";

// Legacy re-exports from the provider module.
// Use getTestDatabaseSupport / startTestDatabase directly for new code.
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db/test-database-provider";
