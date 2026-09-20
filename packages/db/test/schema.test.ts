import { getTableColumns, getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

const DRIZZLE_TABLES = [
  schema.companies,
  schema.users,
  schema.memberships,
  schema.agents,
  schema.agentRevisions,
  schema.auditLog,
  schema.sessions,
  schema.runs,
  schema.messages,
  schema.runEvents,
  schema.budgetPolicies,
  schema.costEvents,
  schema.budgetReservations,
  schema.approvals,
  schema.toolPolicies,
  schema.secrets,
  schema.secretBindings,
  schema.secretAccessEvents,
  schema.goals,
  schema.projects,
  schema.tasks,
  schema.taskComments,
  schema.taskRelations,
  schema.workProducts,
  schema.wakeups,
  schema.learningSettings,
  schema.memories,
  schema.skills,
  schema.skillVersions,
  schema.skillUsage,
  schema.learningReviews,
  schema.promotions,
  schema.learningBackups,
];

describe("the Drizzle schema mirrors the migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it("every Drizzle table exists in the database with the same columns", async () => {
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
      expect(inDatabase, `columns of ${name}`).toEqual(inDrizzle);
    }
  });

  it("every database table has a Drizzle definition", async () => {
    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const inDatabase = rows
      .map((r) => r.table_name)
      .filter((t) => t !== "schema_migrations")
      .sort();
    const inDrizzle = DRIZZLE_TABLES.map((t) => getTableName(t)).sort();
    expect(inDatabase).toEqual(inDrizzle);
  });

  it("typed queries work (insert and read a company)", async () => {
    const [inserted] = await db.db.insert(schema.companies).values({ name: "Test company", mission: "Try out the schema" }).returning();
    expect(inserted?.status).toBe("active");
    const found = await db.db.query.companies.findFirst();
    expect(found?.name).toBe("Test company");
  });
});
