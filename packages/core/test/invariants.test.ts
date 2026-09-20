/**
 * Le venti invarianti come test di contratto.
 *
 * Ogni invariante ha esattamente un test qui, con lo stesso `id` di
 * `src/invariants.ts`. Quelle non ancora coperte dalla milestone corrente
 * restano `todo`: diventano verdi milestone dopo milestone, mai saltate.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_TABLES_WITHOUT_COMPANY_ID } from "@opifer/db";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVARIANTS, invariantById } from "../src/invariants.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function walk(dir: string, skip = new Set(["node_modules", "dist", ".git"])): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, skip)));
    else out.push(full);
  }
  return out;
}

async function workspacePackageJsons(): Promise<Record<string, unknown>[]> {
  const files = (await walk(path.join(REPO_ROOT, "packages"))).filter((f) => path.basename(f) === "package.json");
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>));
}

describe("le venti invarianti", () => {
  it("sono esattamente venti, con id unici, e ognuna ha un test qui", async () => {
    expect(INVARIANTS).toHaveLength(20);
    expect(new Set(INVARIANTS.map((i) => i.id)).size).toBe(20);
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    for (const inv of INVARIANTS) {
      expect(source, `manca il test per "${inv.id}"`).toContain(`invariantById("${inv.id}")`);
    }
  });

  describe("nucleo", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it.todo(invariantById("nucleo-stretto").title);

    it(invariantById("un-solo-archivio").title, async () => {
      // Nessun pacchetto del core dipende da un secondo archivio.
      const forbidden = ["redis", "ioredis", "mongodb", "mongoose", "better-sqlite3", "sqlite3", "mysql2", "level", "amqplib", "kafkajs", "bullmq"];
      for (const pkg of await workspacePackageJsons()) {
        const deps = Object.keys({
          ...(pkg["dependencies"] as Record<string, string> | undefined),
          ...(pkg["devDependencies"] as Record<string, string> | undefined),
        });
        for (const dep of deps) expect(forbidden, `${pkg["name"]} dipende da ${dep}`).not.toContain(dep);
      }
    });

    it(invariantById("ogni-riga-a-una-azienda").title, async () => {
      const rows = await db.sql<{ table_name: string }[]>`
        SELECT t.table_name
        FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'company_id'
          )
        ORDER BY t.table_name
      `;
      const without = rows.map((r) => r.table_name).filter((t) => !DOMAIN_TABLES_WITHOUT_COMPANY_ID.includes(t));
      expect(without, "tabelle senza company_id").toEqual([]);
    });

    it(invariantById("un-solo-linguaggio").title, async () => {
      const otherLanguages = new Set([".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".kt", ".swift"]);
      const files = await walk(path.join(REPO_ROOT, "packages"));
      const offenders = files.filter((f) => otherLanguages.has(path.extname(f)));
      expect(offenders).toEqual([]);
    });
  });

  describe("conversazione e costi", () => {
    it.todo(invariantById("prefisso-stabile").title);
    it.todo(invariantById("una-sola-rottura").title);
    it.todo(invariantById("alternanza-dei-ruoli").title);
    it.todo(invariantById("budget-prima-della-chiamata").title);
  });

  describe("lavoro", () => {
    it.todo(invariantById("checkout-atomico").title);
    it.todo(invariantById("ogni-task-conosce-il-suo-perche").title);
    it.todo(invariantById("al-piu-una-volta").title);
    it.todo(invariantById("niente-replay-dei-tool").title);
    it.todo(invariantById("finito-significa-verificato").title);
  });

  describe("governo", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it.todo(invariantById("permesso-per-ruolo-su-ogni-tool").title);
    it.todo(invariantById("segreti-mai-nel-contesto").title);

    it(invariantById("audit-immutabile").title, async () => {
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Prova') RETURNING id`;
      const [entry] = await db.sql<{ id: string }[]>`
        INSERT INTO audit_log (company_id, actor_kind, action, subject_kind)
        VALUES (${company!.id}, 'sistema', 'prova', 'test') RETURNING id
      `;
      await expect(db.sql`UPDATE audit_log SET action = 'modificata' WHERE id = ${entry!.id}`).rejects.toThrow(/immutabile/);
      await expect(db.sql`DELETE FROM audit_log WHERE id = ${entry!.id}`).rejects.toThrow(/immutabile/);
      const [still] = await db.sql<{ action: string }[]>`SELECT action FROM audit_log WHERE id = ${entry!.id}`;
      expect(still?.action).toBe("prova");
    });

    it.todo(invariantById("configurazione-versionata").title);
  });

  describe("apprendimento", () => {
    it.todo(invariantById("imparare-fuori-dal-turno").title);
    it.todo(invariantById("mai-cancellare-cio-che-si-e-imparato").title);
    it.todo(invariantById("la-conoscenza-sale-solo-con-governo").title);
  });
});
