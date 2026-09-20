import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

async function tableNames(db: TestDatabase): Promise<string[]> {
  const rows = await db.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((r) => r.table_name);
}

describe("forward and backward migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("every migration has up and down and the numbers are consecutive", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    migrations.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.upSql.trim()).not.toBe("");
      expect(m.downSql.trim()).not.toBe("");
    });
  });

  it("starts from an empty schema", async () => {
    const status = await migrationStatus(db.sql);
    expect(status.applied).toHaveLength(0);
    expect(status.pending.length).toBeGreaterThan(0);
    expect(await tableNames(db)).toEqual(["schema_migrations"]);
  });

  it("applies all migrations forward", async () => {
    const applied = await migrateUp(db.sql);
    expect(applied.length).toBeGreaterThan(0);
    const status = await migrationStatus(db.sql);
    expect(status.pending).toHaveLength(0);
    expect(await tableNames(db)).toContain("companies");
    expect(await tableNames(db)).toContain("audit_log");
  });

  it("is idempotent: a second run applies nothing", async () => {
    const applied = await migrateUp(db.sql);
    expect(applied).toHaveLength(0);
  });

  it("goes back down to the empty schema", async () => {
    const all = await loadMigrations();
    const reverted = await migrateDown(db.sql, { to: 0 });
    expect(reverted).toHaveLength(all.length);
    expect(await tableNames(db)).toEqual(["schema_migrations"]);
    const status = await migrationStatus(db.sql);
    expect(status.applied).toHaveLength(0);
  });

  it("re-applies forward after going back (forward and backward are repeatable)", async () => {
    await migrateUp(db.sql);
    const before = await tableNames(db);
    await migrateDown(db.sql, { steps: 1 });
    await migrateUp(db.sql);
    expect(await tableNames(db)).toEqual(before);
  });
});
