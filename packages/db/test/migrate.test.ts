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

describe("migrazioni avanti e indietro", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("ogni migrazione ha up e down e i numeri sono consecutivi", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    migrations.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.upSql.trim()).not.toBe("");
      expect(m.downSql.trim()).not.toBe("");
    });
  });

  it("parte da uno schema vuoto", async () => {
    const status = await migrationStatus(db.sql);
    expect(status.applied).toHaveLength(0);
    expect(status.pending.length).toBeGreaterThan(0);
    expect(await tableNames(db)).toEqual(["schema_migrations"]);
  });

  it("applica tutte le migrazioni in avanti", async () => {
    const applied = await migrateUp(db.sql);
    expect(applied.length).toBeGreaterThan(0);
    const status = await migrationStatus(db.sql);
    expect(status.pending).toHaveLength(0);
    expect(await tableNames(db)).toContain("companies");
    expect(await tableNames(db)).toContain("audit_log");
  });

  it("è idempotente: una seconda esecuzione non applica nulla", async () => {
    const applied = await migrateUp(db.sql);
    expect(applied).toHaveLength(0);
  });

  it("torna indietro fino allo schema vuoto", async () => {
    const all = await loadMigrations();
    const reverted = await migrateDown(db.sql, { to: 0 });
    expect(reverted).toHaveLength(all.length);
    expect(await tableNames(db)).toEqual(["schema_migrations"]);
    const status = await migrationStatus(db.sql);
    expect(status.applied).toHaveLength(0);
  });

  it("riapplica in avanti dopo il ritorno (avanti e indietro ripetibili)", async () => {
    await migrateUp(db.sql);
    const before = await tableNames(db);
    await migrateDown(db.sql, { steps: 1 });
    await migrateUp(db.sql);
    expect(await tableNames(db)).toEqual(before);
  });
});
