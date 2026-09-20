/**
 * The twenty invariants as contract tests.
 *
 * Every invariant has exactly one test here, with the same `id` as in
 * `src/invariants.ts`. Those not yet covered by the current milestone stay
 * `todo`: they turn green milestone after milestone, never skipped.
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

describe("the twenty invariants", () => {
  it("are exactly twenty, with unique ids, and each one has a test here", async () => {
    expect(INVARIANTS).toHaveLength(20);
    expect(new Set(INVARIANTS.map((i) => i.id)).size).toBe(20);
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    for (const inv of INVARIANTS) {
      expect(source, `missing test for "${inv.id}"`).toContain(`invariantById("${inv.id}")`);
    }
  });

  describe("core", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it.todo(invariantById("narrow-core").title);

    it(invariantById("single-store").title, async () => {
      // No core package depends on a second store.
      const forbidden = ["redis", "ioredis", "mongodb", "mongoose", "better-sqlite3", "sqlite3", "mysql2", "level", "amqplib", "kafkajs", "bullmq"];
      for (const pkg of await workspacePackageJsons()) {
        const deps = Object.keys({
          ...(pkg["dependencies"] as Record<string, string> | undefined),
          ...(pkg["devDependencies"] as Record<string, string> | undefined),
        });
        for (const dep of deps) expect(forbidden, `${pkg["name"]} depends on ${dep}`).not.toContain(dep);
      }
    });

    it(invariantById("every-row-belongs-to-a-company").title, async () => {
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
      expect(without, "tables without company_id").toEqual([]);
    });

    it(invariantById("single-language").title, async () => {
      const otherLanguages = new Set([".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".kt", ".swift"]);
      const files = await walk(path.join(REPO_ROOT, "packages"));
      const offenders = files.filter((f) => otherLanguages.has(path.extname(f)));
      expect(offenders).toEqual([]);
    });
  });

  describe("conversation and costs", () => {
    let db: TestDatabase;
    let session: { id: string; companyId: string };

    beforeAll(async () => {
      db = await createTestDatabase();
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Test') RETURNING id`;
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Agent') RETURNING id`;
      const [row] = await db.sql<{ id: string }[]>`
        INSERT INTO sessions (company_id, agent_id, system_prompt, system_prompt_hash, model)
        VALUES (${company!.id}, ${agent!.id}, 'prefix', 'abc', 'fake/echo') RETURNING id
      `;
      session = { id: row!.id, companyId: company!.id };
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it(invariantById("stable-prefix").title, async () => {
      // The system prompt of a session does not change: the database rejects it.
      await expect(db.sql`UPDATE sessions SET system_prompt = 'other' WHERE id = ${session.id}`).rejects.toThrow(/stable prefix/);
      await expect(db.sql`UPDATE sessions SET system_prompt_hash = 'zzz' WHERE id = ${session.id}`).rejects.toThrow(/stable prefix/);
      await db.sql`UPDATE sessions SET title = 'title' WHERE id = ${session.id}`;
      const [row] = await db.sql<{ system_prompt: string }[]>`SELECT system_prompt FROM sessions WHERE id = ${session.id}`;
      expect(row?.system_prompt).toBe("prefix");
    });

    it.todo(invariantById("single-break").title);

    it(invariantById("strict-role-alternation").title, async () => {
      const insert = (seq: number, role: string) =>
        db.sql`INSERT INTO messages (company_id, session_id, seq, role, content) VALUES (${session.companyId}, ${session.id}, ${seq}, ${role}, '[]'::jsonb)`;
      await expect(insert(1, "assistant")).rejects.toThrow(/starts with a user message/);
      await insert(1, "user");
      await expect(insert(2, "user")).rejects.toThrow(/role alternation/);
      await insert(2, "assistant");
      await expect(insert(3, "assistant")).rejects.toThrow(/role alternation/);
      await insert(3, "tool");
      await insert(4, "assistant");
      const roles = (await db.sql<{ role: string }[]>`SELECT role FROM messages WHERE session_id = ${session.id} ORDER BY seq`).map((r) => r.role);
      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it(invariantById("budget-before-the-call").title, async () => {
      // With the cap already reached, the reservation is refused and the model is never called.
      const { BudgetService, PriceBook } = await import("@opifer/gateway");
      const { ProviderRegistry } = await import("@opifer/runtime");
      const { FakeProvider } = await import("@opifer/runtime/testing");
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${session.companyId}, 'Spender') RETURNING id`;
      const [run] = await db.sql<{ id: string }[]>`INSERT INTO runs (company_id, session_id, agent_id) VALUES (${session.companyId}, ${session.id}, ${agent!.id}) RETURNING id`;
      const provider = new FakeProvider(() => ({ kind: "text", text: "never" }));
      const prices = new PriceBook(new ProviderRegistry().register(provider));
      prices.set("fake/echo", { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000, currency: "EUR" });
      const budget = new BudgetService(db.sql, prices);
      await budget.setPolicy({ companyId: session.companyId, scopeKind: "company", cap: 1, currency: "EUR" });
      const context = { companyId: session.companyId, agentId: agent!.id, sessionId: session.id, runId: run!.id };
      const first = await budget.reserve(context, { modelId: "fake/echo", inputTokens: 10, maxOutputTokens: 10 });
      expect(first.allowed).toBe(true);
      if (first.allowed) await budget.settle(first.reservationId, "fake/echo", { inputTokens: 10, outputTokens: 10 });
      const second = await budget.reserve(context, { modelId: "fake/echo", inputTokens: 10, maxOutputTokens: 10 });
      expect(second).toMatchObject({ allowed: false, scope: "company", cap: 1 });
      const [reservations] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM budget_reservations WHERE run_id = ${run!.id}`;
      expect(Number(reservations!.n)).toBe(1);
      const [blocked] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE action = 'budget.blocked' AND subject_id = ${run!.id}`;
      expect(Number(blocked!.n)).toBe(1);
    });
  });

  describe("work", () => {
    it.todo(invariantById("atomic-checkout").title);
    it.todo(invariantById("every-task-knows-its-why").title);
    it.todo(invariantById("at-most-once").title);
    it(invariantById("no-tool-replay").title, async () => {
      // A turn dies after the model asked for a tool: on resume the tool is not re-run.
      const { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, ProviderRegistry } = await import("@opifer/runtime");
      const { FakeProvider } = await import("@opifer/runtime/testing");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const db = await createTestDatabase();
      try {
        const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Test') RETURNING id`;
        const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Agent') RETURNING id`;
        const executions: string[] = [];
        const tools = new NativeToolExecutor(NATIVE_TOOLS);
        const spied = {
          definitions: () => tools.definitions(),
          execute: async (name: string, args: Record<string, unknown>, ctx: Parameters<typeof tools.execute>[2]) => {
            executions.push(name);
            return tools.execute(name, args, ctx);
          },
        };
        const provider = new FakeProvider((request) => (request.messages.at(-1)!.role === "tool" ? { kind: "text", text: "done" } : { kind: "tools", calls: [{ name: "list_files", arguments: {} }] }));
        const build = () =>
          new AgentRuntime({ sql: db.sql, providers: new ProviderRegistry().register(provider), tools: spied, workRoot: "", defaultModel: "fake/echo" });
        const workdir = await mkdtemp(path.join(tmpdir(), "opifer-replay-"));
        const session = await build().startSession({ companyId: company!.id, agentId: agent!.id, workdir });
        // simulated crash: user + tool call without result, run left "running"
        const store = build().store;
        const crashed = await store.createRun(session);
        await store.appendMessage(session, "user", [{ type: "text", text: "list" }], { runId: crashed.id });
        await store.appendMessage(session, "assistant", [{ type: "tool_call", id: "c1", name: "list_files", arguments: {} }], { runId: crashed.id });

        const restarted = build();
        await restarted.recoverSession(session.id);
        const result = await restarted.runTurn({ sessionId: session.id, text: "continue" });
        expect(result.run.status).toBe("completed");
        // the tool of the dangling call was not re-run: the only execution is the one of the new turn
        expect(executions).toEqual(["list_files"]);
        const messages = await restarted.store.listMessages(session.id);
        const settled = messages[2]!;
        expect(settled.role).toBe("tool");
        expect(settled.content[0]).toMatchObject({ type: "tool_result", toolCallId: "c1", isError: true });
      } finally {
        await db.destroy();
      }
    });
    it.todo(invariantById("done-means-verified").title);
  });

  describe("governance", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    });

    it(invariantById("permission-per-role-on-every-tool").title, async () => {
      // Every native tool resolves to one of the three states; without a policy the default is by risk, and high risk asks.
      const { PermissionService } = await import("@opifer/gateway");
      const { NATIVE_TOOLS } = await import("@opifer/runtime");
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Permissions') RETURNING id`;
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Agent', 'engineer') RETURNING id`;
      const permissions = new PermissionService(db.sql);
      for (const tool of NATIVE_TOOLS) {
        const resolved = await permissions.resolve({ companyId: company!.id, agentId: agent!.id, agentRole: "engineer", toolName: tool.definition.name, risk: tool.risk });
        expect(["automatic", "approval", "blocked"]).toContain(resolved.permission);
        if (tool.risk === "high") expect(resolved.permission).toBe("approval");
      }
      await permissions.setPolicy({ companyId: company!.id, targetKind: "role", targetId: "engineer", toolName: "terminal", permission: "blocked" });
      expect((await permissions.resolve({ companyId: company!.id, agentId: agent!.id, agentRole: "engineer", toolName: "terminal", risk: "high" })).permission).toBe("blocked");
      expect((await permissions.resolve({ companyId: company!.id, agentId: agent!.id, agentRole: "designer", toolName: "terminal", risk: "high" })).permission).toBe("approval");
    });

    it(invariantById("secrets-never-in-context").title, async () => {
      // A secret is bound to agent and company, decrypted only when a tool runs, and every access leaves a row.
      const { SecretCipher, SecretService } = await import("@opifer/gateway");
      const { randomBytes } = await import("node:crypto");
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Secrets') RETURNING id`;
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Agent') RETURNING id`;
      const [other] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Other') RETURNING id`;
      const secrets = new SecretService(db.sql, new SecretCipher(randomBytes(32)));
      const value = "token-8f3a9c1d2e";
      await secrets.set({ companyId: company!.id, name: "API_TOKEN", value });
      const [stored] = await db.sql<{ ciphertext: Buffer }[]>`SELECT ciphertext FROM secrets WHERE company_id = ${company!.id}`;
      expect(Buffer.from(stored!.ciphertext).toString("utf8")).not.toContain(value);
      expect(await secrets.resolveFor({ companyId: company!.id, agentId: agent!.id, toolName: "terminal" })).toEqual({});
      await secrets.bind({ companyId: company!.id, secretName: "API_TOKEN", agentId: agent!.id });
      expect(await secrets.resolveFor({ companyId: company!.id, agentId: agent!.id, toolName: "terminal" })).toEqual({ API_TOKEN: value });
      expect(await secrets.resolveFor({ companyId: company!.id, agentId: other!.id, toolName: "terminal" })).toEqual({});
      expect(await secrets.accessLog(company!.id)).toMatchObject([{ secretName: "API_TOKEN", agentId: agent!.id, toolName: "terminal" }]);
      const [leaks] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE company_id = ${company!.id} AND (after::text LIKE ${"%" + value + "%"} OR before::text LIKE ${"%" + value + "%"})`;
      expect(Number(leaks!.n)).toBe(0);
    });

    it(invariantById("immutable-audit").title, async () => {
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Test') RETURNING id`;
      const [entry] = await db.sql<{ id: string }[]>`
        INSERT INTO audit_log (company_id, actor_kind, action, subject_kind)
        VALUES (${company!.id}, 'system', 'try', 'test') RETURNING id
      `;
      await expect(db.sql`UPDATE audit_log SET action = 'modified' WHERE id = ${entry!.id}`).rejects.toThrow(/immutable/);
      await expect(db.sql`DELETE FROM audit_log WHERE id = ${entry!.id}`).rejects.toThrow(/immutable/);
      const [still] = await db.sql<{ action: string }[]>`SELECT action FROM audit_log WHERE id = ${entry!.id}`;
      expect(still?.action).toBe("try");
    });

    it(invariantById("versioned-configuration").title, async () => {
      // Each change is a revision; restoring an old one is a new revision, nothing is rewritten.
      const { AgentConfigService } = await import("@opifer/gateway");
      const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Revisions') RETURNING id`;
      const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role, model) VALUES (${company!.id}, 'Agent', 'first role', 'fake/one') RETURNING id`;
      await db.sql`INSERT INTO agent_revisions (company_id, agent_id, revision, config, author_kind) VALUES (${company!.id}, ${agent!.id}, 1, ${{ name: "Agent", role: "first role", model: "fake/one" } as never}::jsonb, 'person')`;
      const agents = new AgentConfigService(db.sql);
      const second = await agents.update(company!.id, agent!.id, { role: "second role" });
      expect(second).toMatchObject({ revision: 2, config: { role: "second role", model: "fake/one" } });
      const restored = await agents.restore(company!.id, agent!.id, 1);
      expect(restored).toMatchObject({ revision: 3, config: { role: "first role" } });
      const revisions = await agents.revisions(company!.id, agent!.id);
      expect(revisions.map((r) => [r.revision, r.config.role])).toEqual([[3, "first role"], [2, "second role"], [1, "first role"]]);
      const [row] = await db.sql<{ role: string; current_revision: number }[]>`SELECT role, current_revision FROM agents WHERE id = ${agent!.id}`;
      expect(row).toEqual({ role: "first role", current_revision: 3 });
      const [audited] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE subject_id = ${agent!.id} AND action = 'agent.updated'`;
      expect(Number(audited!.n)).toBe(2);
    });
  });

  describe("learning", () => {
    it.todo(invariantById("learn-outside-the-turn").title);
    it.todo(invariantById("never-delete-what-was-learned").title);
    it.todo(invariantById("knowledge-rises-only-with-governance").title);
  });
});
