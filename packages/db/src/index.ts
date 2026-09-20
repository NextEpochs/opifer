export { connect, connectionString, waitForDatabase } from "./client.js";
export type { Database, DatabaseConfig, DatabaseHandle } from "./client.js";
export {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
} from "./migrate.js";
export type { AppliedMigration, MigrateDownOptions, MigrateOptions, Migration, MigrationStatus } from "./migrate.js";
export { embeddedConfig, startEmbeddedPostgres } from "./embedded.js";
export type { EmbeddedCluster, EmbeddedOptions } from "./embedded.js";
export * as schema from "./schema.js";
export { DOMAIN_TABLES_WITHOUT_COMPANY_ID } from "./schema.js";
export { audit } from "./audit.js";
export type { AuditInput } from "./audit.js";
