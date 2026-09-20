import { getTableColumns, getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

const DRIZZLE_TABLES = [schema.companies, schema.users, schema.memberships, schema.agents, schema.agentRevisions, schema.auditLog];

describe("lo schema Drizzle rispecchia le migrazioni", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("ogni tabella Drizzle esiste nel database con le stesse colonne", async () => {
    for (const table of DRIZZLE_TABLES) {
      const name = getTableName(table);
      const rows = await db.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${name}
        ORDER BY column_name
      `;
      const inDatabase = rows.map((r) => r.column_name).sort();
      const inDrizzle = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(inDatabase, `colonne di ${name}`).toEqual(inDrizzle);
    }
  });

  it("ogni tabella del database ha una definizione Drizzle", async () => {
    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const inDatabase = rows.map((r) => r.table_name).filter((t) => t !== "schema_migrations").sort();
    const inDrizzle = DRIZZLE_TABLES.map((t) => getTableName(t)).sort();
    expect(inDatabase).toEqual(inDrizzle);
  });

  it("le query tipizzate funzionano (inserisci e leggi un'azienda)", async () => {
    const [inserted] = await db.db
      .insert(schema.companies)
      .values({ name: "Azienda di prova", mission: "Provare lo schema" })
      .returning();
    expect(inserted?.status).toBe("attiva");
    const found = await db.db.query.companies.findFirst();
    expect(found?.name).toBe("Azienda di prova");
  });
});
