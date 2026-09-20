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
    let db: TestDatabase;
    let session: { id: string; companyId: string };

    beforeAll(async () => {
      db = await createTestDatabase();
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Prova') RETURNING id`;
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Agente') RETURNING id`;
      const [row] = await db.sql<{ id: string }[]>`
        INSERT INTO sessions (company_id, agent_id, system_prompt, system_prompt_hash, model)
        VALUES (${company!.id}, ${agent!.id}, 'prefisso', 'abc', 'finto/eco') RETURNING id
      `;
      session = { id: row!.id, companyId: company!.id };
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it(invariantById("prefisso-stabile").title, async () => {
      // Il prompt di sistema di una sessione non cambia: il database lo rifiuta.
      await expect(db.sql`UPDATE sessions SET system_prompt = 'altro' WHERE id = ${session.id}`).rejects.toThrow(/prefisso stabile/);
      await expect(db.sql`UPDATE sessions SET system_prompt_hash = 'zzz' WHERE id = ${session.id}`).rejects.toThrow(/prefisso stabile/);
      await db.sql`UPDATE sessions SET title = 'titolo' WHERE id = ${session.id}`;
      const [row] = await db.sql<{ system_prompt: string }[]>`SELECT system_prompt FROM sessions WHERE id = ${session.id}`;
      expect(row?.system_prompt).toBe("prefisso");
    });

    it.todo(invariantById("una-sola-rottura").title);

    it(invariantById("alternanza-dei-ruoli").title, async () => {
      const insert = (seq: number, role: string) =>
        db.sql`INSERT INTO messages (company_id, session_id, seq, role, content) VALUES (${session.companyId}, ${session.id}, ${seq}, ${role}, '[]'::jsonb)`;
      await expect(insert(1, "assistant")).rejects.toThrow(/inizia sempre con un messaggio utente/);
      await insert(1, "user");
      await expect(insert(2, "user")).rejects.toThrow(/alternanza dei ruoli/);
      await insert(2, "assistant");
      await expect(insert(3, "assistant")).rejects.toThrow(/alternanza dei ruoli/);
      await insert(3, "tool");
      await insert(4, "assistant");
      const roles = (await db.sql<{ role: string }[]>`SELECT role FROM messages WHERE session_id = ${session.id} ORDER BY seq`).map((r) => r.role);
      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it.todo(invariantById("budget-prima-della-chiamata").title);
  });

  describe("lavoro", () => {
    it.todo(invariantById("checkout-atomico").title);
    it.todo(invariantById("ogni-task-conosce-il-suo-perche").title);
    it.todo(invariantById("al-piu-una-volta").title);
    it(invariantById("niente-replay-dei-tool").title, async () => {
      // Un turno muore dopo che il modello ha chiesto un tool: alla ripresa il tool non viene rieseguito.
      const { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, ProviderRegistry } = await import("@opifer/runtime");
      const { FakeProvider } = await import("@opifer/runtime/testing");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const db = await createTestDatabase();
      try {
        const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Prova') RETURNING id`;
        const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Agente') RETURNING id`;
        const executions: string[] = [];
        const tools = new NativeToolExecutor(NATIVE_TOOLS);
        const spied = {
          definitions: () => tools.definitions(),
          execute: async (name: string, args: Record<string, unknown>, ctx: Parameters<typeof tools.execute>[2]) => {
            executions.push(name);
            return tools.execute(name, args, ctx);
          },
        };
        const provider = new FakeProvider((request) => (request.messages.at(-1)!.role === "tool" ? { kind: "text", text: "fatto" } : { kind: "tools", calls: [{ name: "list_files", arguments: {} }] }));
        const build = () =>
          new AgentRuntime({ sql: db.sql, providers: new ProviderRegistry().register(provider), tools: spied, workRoot: "", defaultModel: "finto/eco" });
        const workdir = await mkdtemp(path.join(tmpdir(), "opifer-replay-"));
        const session = await build().startSession({ companyId: company!.id, agentId: agent!.id, workdir });
        // crash simulato: utente + chiamata a tool senza risultato, esecuzione rimasta "in corso"
        const store = build().store;
        const crashed = await store.createRun(session);
        await store.appendMessage(session, "user", [{ type: "text", text: "elenca" }], { runId: crashed.id });
        await store.appendMessage(session, "assistant", [{ type: "tool_call", id: "c1", name: "list_files", arguments: {} }], { runId: crashed.id });

        const restarted = build();
        await restarted.recoverSession(session.id);
        const result = await restarted.runTurn({ sessionId: session.id, text: "continua" });
        expect(result.run.status).toBe("conclusa");
        // il tool della chiamata appesa non è stato rieseguito: l'unica esecuzione è quella del nuovo turno
        expect(executions).toEqual(["list_files"]);
        const messages = await restarted.store.listMessages(session.id);
        const settled = messages[2]!;
        expect(settled.role).toBe("tool");
        expect(settled.content[0]).toMatchObject({ type: "tool_result", toolCallId: "c1", isError: true });
      } finally {
        await db.destroy();
      }
    });
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
