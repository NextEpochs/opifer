import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, ProviderRegistry } from "@opifer/runtime";
import { FakeProvider, type Script } from "@opifer/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalService, BudgetService, GovernedToolExecutor, PermissionService, PriceBook, SecretCipher, SecretService, loadMasterKey, redactSecrets } from "../src/index.js";

/**
 * Script driven by the conversation, not by call counts, so several sessions
 * can share one provider: "run: <command>" asks for the terminal, a tool
 * result closes the turn with "done: <result>", anything else is echoed.
 */
const script: Script = (request) => {
  const last = request.messages.at(-1);
  const parts = last?.content ?? [];
  const toolResult = parts.find((p) => p.type === "tool_result");
  if (toolResult && toolResult.type === "tool_result") return { kind: "text", text: `done: ${toolResult.content}` };
  const text = parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
  if (text.startsWith("run:")) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: text.slice(4).trim() } }] };
  if (text.startsWith("write:")) return { kind: "tools", calls: [{ name: "write_file", arguments: { path: "note.txt", content: text.slice(6).trim() } }] };
  return { kind: "text", text: `echo: ${text}` };
};

interface Fixture {
  db: TestDatabase;
  companyId: string;
  agentId: string;
  provider: FakeProvider;
  prices: PriceBook;
  budget: BudgetService;
  approvals: ApprovalService;
  permissions: PermissionService;
  secrets: SecretService;
  runtime: AgentRuntime;
  budgetStops: string[];
  auditCount(action?: string): Promise<number>;
  agentStatus(): Promise<string>;
}

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase();
  const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name, mission) VALUES ('Governed company', 'Exercise the gateway') RETURNING id`;
  const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role, model) VALUES (${company!.id}, 'Worker', 'engineer', 'fake/echo') RETURNING id`;
  const workRoot = await mkdtemp(path.join(tmpdir(), "opifer-gateway-"));
  const provider = new FakeProvider(script);
  const providers = new ProviderRegistry().register(provider);
  const prices = new PriceBook(providers);
  const budget = new BudgetService(db.sql, prices);
  const approvals = new ApprovalService(db.sql);
  const permissions = new PermissionService(db.sql);
  const masterKey = await loadMasterKey(path.join(workRoot, "credentials", "master.key"));
  const secrets = new SecretService(db.sql, new SecretCipher(masterKey));
  const tools = new GovernedToolExecutor({ sql: db.sql, inner: new NativeToolExecutor(NATIVE_TOOLS), permissions, secrets });
  const budgetStops: string[] = [];
  const runtime = new AgentRuntime({
    sql: db.sql,
    providers,
    tools,
    workRoot,
    defaultModel: "fake/echo",
    maxOutputTokens: 100,
    recovery: { maxAttempts: 2, baseDelayMs: 1 },
    governance: {
      budget,
      approvals,
      onBudgetStop: async (context, decision) => {
        budgetStops.push(decision.scope);
        await db.sql`UPDATE agents SET status = 'budget_stopped' WHERE id = ${context.agentId}`;
      },
    },
  });
  return {
    db,
    companyId: company!.id,
    agentId: agent!.id,
    provider,
    prices,
    budget,
    approvals,
    permissions,
    secrets,
    runtime,
    budgetStops,
    auditCount: async (action) => {
      const filter = action ? db.sql`AND action = ${action}` : db.sql``;
      const [row] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE company_id = ${company!.id} ${filter}`;
      return Number(row!.n);
    },
    agentStatus: async () => {
      const [row] = await db.sql<{ status: string }[]>`SELECT status FROM agents WHERE id = ${agent!.id}`;
      return row!.status;
    },
  };
}

describe("gateway: budget before the call", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.db.destroy();
  });

  it("a 1 EUR cap is overrun by at most one call and stops the agent with an audit trail", async () => {
    // Every token costs one euro: the very first call already exceeds the cap.
    f.prices.set("fake/echo", { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000, currency: "EUR" });
    await f.budget.setPolicy({ companyId: f.companyId, scopeKind: "company", cap: 1, currency: "EUR" });
    expect(await f.auditCount("budget.policy_set")).toBe(1);

    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const first = await f.runtime.runTurn({ sessionId: session.id, text: "hello" });
    expect(first.stopReason).toBe("final_answer");
    const callsAfterFirst = f.provider.requests.length;

    const [events] = await f.db.sql<{ n: string; eur: string }[]>`SELECT count(*)::text AS n, sum(amount_eur)::text AS eur FROM cost_events WHERE company_id = ${f.companyId}`;
    expect(Number(events!.n)).toBe(1);
    expect(Number(events!.eur)).toBeGreaterThan(1);
    const [open] = await f.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM budget_reservations WHERE company_id = ${f.companyId} AND status = 'open'`;
    expect(Number(open!.n)).toBe(0);

    const second = await f.runtime.runTurn({ sessionId: session.id, text: "again" });
    expect(second.stopReason).toBe("budget_exhausted");
    expect(second.run.status).toBe("waiting");
    expect(f.provider.requests.length).toBe(callsAfterFirst); // no model call happened
    expect(f.budgetStops).toEqual(["company"]);
    expect(await f.agentStatus()).toBe("budget_stopped");
    expect(await f.auditCount("budget.blocked")).toBe(1);

    const report = await f.budget.report(f.companyId);
    expect(report.total.eur).toBeGreaterThan(1);
    expect(report.byAgent[0]?.agentId).toBe(f.agentId);
    expect(report.byModel[0]?.model).toBe("echo");
  });

  it("a stopped agent does not run until reactivated; removing the policy frees it", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    await expect(f.runtime.runTurn({ sessionId: session.id, text: "hello" })).rejects.toThrow(/budget_stopped/);
    await f.db.sql`UPDATE agents SET status = 'active' WHERE id = ${f.agentId}`;
    const [policy] = await f.budget.listPolicies(f.companyId);
    expect(await f.budget.removePolicy(f.companyId, policy!.id)).toBe(true);
    expect(await f.auditCount("budget.policy_removed")).toBe(1);
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "hello" });
    expect(result.stopReason).toBe("final_answer");
  });
});

describe("gateway: permissions, approvals and secrets", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.db.destroy();
  });

  it("resolves agent over role over company over risk", async () => {
    const ctx = { companyId: f.companyId, agentId: f.agentId, agentRole: "engineer", toolName: "terminal", risk: "high" as const };
    expect(await f.permissions.resolve(ctx)).toMatchObject({ permission: "approval", source: "risk" });
    expect(await f.permissions.resolve({ ...ctx, toolName: "read_file", risk: "low" })).toMatchObject({ permission: "automatic", source: "risk" });

    await f.permissions.setPolicy({ companyId: f.companyId, targetKind: "company", toolName: "*", permission: "blocked" });
    expect(await f.permissions.resolve(ctx)).toMatchObject({ permission: "blocked", source: "company" });
    await f.permissions.setPolicy({ companyId: f.companyId, targetKind: "role", targetId: "engineer", toolName: "terminal", permission: "approval" });
    expect(await f.permissions.resolve(ctx)).toMatchObject({ permission: "approval", source: "role" });
    await f.permissions.setPolicy({ companyId: f.companyId, targetKind: "agent", targetId: f.agentId, toolName: "terminal", permission: "automatic" });
    expect(await f.permissions.resolve(ctx)).toMatchObject({ permission: "automatic", source: "agent" });
    expect(await f.auditCount("tool.policy_set")).toBe(3);

    // Clean slate for the next tests: only the risk defaults.
    for (const p of await f.permissions.listPolicies(f.companyId)) await f.permissions.removePolicy(f.companyId, p.id);
    expect(await f.auditCount("tool.policy_removed")).toBe(3);
  });

  it("a high-risk tool suspends the turn until a person approves, then resumes without re-asking", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const executedBefore = await f.auditCount("tool.executed");
    const suspended = await f.runtime.runTurn({ sessionId: session.id, text: "run: echo approved-work" });
    expect(suspended.stopReason).toBe("approval_pending");
    expect(suspended.run.status).toBe("waiting");
    expect(await f.auditCount("tool.executed")).toBe(executedBefore);

    const pending = await f.approvals.list(f.companyId, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "tool_use", sessionId: session.id, risk: "high" });
    expect(pending[0]!.subject).toMatchObject({ tool: "terminal", arguments: { command: "echo approved-work" } });
    expect(await f.auditCount("approval.requested")).toBe(1);

    // Resuming while pending: still waiting, nothing executed.
    const stillWaiting = await f.runtime.runTurn({ sessionId: session.id });
    expect(stillWaiting.stopReason).toBe("approval_pending");

    const decided = await f.approvals.decide(f.companyId, pending[0]!.id, { status: "approved", note: "fine" });
    expect(decided.status).toBe("approved");
    expect(await f.auditCount("approval.decided")).toBe(1);
    await expect(f.approvals.decide(f.companyId, pending[0]!.id, { status: "denied" })).rejects.toThrow(/is approved/);

    const resumed = await f.runtime.runTurn({ sessionId: session.id });
    expect(resumed.stopReason).toBe("final_answer");
    expect(resumed.assistantText).toMatch(/^done: approved-work/);
    expect(await f.auditCount("tool.executed")).toBe(executedBefore + 1);
    const messages = await f.runtime.store.listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("a denied approval reaches the model as a refusal, nothing runs", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    await f.runtime.runTurn({ sessionId: session.id, text: "run: echo denied-work" });
    const [pending] = await f.approvals.list(f.companyId, { status: "pending" });
    const executedBefore = await f.auditCount("tool.executed");
    await f.approvals.decide(f.companyId, pending!.id, { status: "denied", note: "not now" });
    const resumed = await f.runtime.runTurn({ sessionId: session.id });
    expect(resumed.assistantText).toMatch(/Denied by the operator: not now/);
    expect(await f.auditCount("tool.executed")).toBe(executedBefore);
  });

  it("a dangerous command needs approval even when the tool is automatic; a blocked tool never runs", async () => {
    await f.permissions.setPolicy({ companyId: f.companyId, targetKind: "company", toolName: "terminal", permission: "automatic" });
    const automatic = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const ran = await f.runtime.runTurn({ sessionId: automatic.id, text: "run: echo plain" });
    expect(ran.assistantText).toMatch(/^done: plain/);

    const dangerous = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const suspended = await f.runtime.runTurn({ sessionId: dangerous.id, text: "run: rm -r build" });
    expect(suspended.stopReason).toBe("approval_pending");
    const [pending] = await f.approvals.list(f.companyId, { status: "pending" });
    expect(pending).toMatchObject({ kind: "dangerous_command", sessionId: dangerous.id });
    await f.approvals.decide(f.companyId, pending!.id, { status: "denied" });

    await f.permissions.setPolicy({ companyId: f.companyId, targetKind: "agent", targetId: f.agentId, toolName: "write_file", permission: "blocked" });
    const blocked = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const refused = await f.runtime.runTurn({ sessionId: blocked.id, text: "write: hello" });
    expect(refused.stopReason).toBe("final_answer");
    expect(refused.assistantText).toMatch(/blocked for this agent by policy/);
    expect(await f.auditCount("tool.blocked")).toBe(1);
    expect(await f.approvals.list(f.companyId, { status: "pending" })).toHaveLength(0);
  });

  it("secrets reach the tool as environment, never the model context, the messages or the logs", async () => {
    const value = "sk-live-4f9a1c7e2b";
    await f.secrets.set({ companyId: f.companyId, name: "SERVICE_TOKEN", value });
    await f.secrets.set({ companyId: f.companyId, name: "SERVICE_TOKEN", value: `${value}-v2` });
    expect(await f.secrets.list(f.companyId)).toMatchObject([{ name: "SERVICE_TOKEN", version: 2 }]);
    await f.secrets.bind({ companyId: f.companyId, secretName: "SERVICE_TOKEN", agentId: f.agentId, toolName: "terminal" });
    expect(await f.auditCount("secret.set")).toBe(2);
    expect(await f.auditCount("secret.bound")).toBe(1);

    const [auditRows] = await f.db.sql<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM audit_log WHERE after::text LIKE ${"%" + value + "%"} OR before::text LIKE ${"%" + value + "%"}`;
    expect(Number(auditRows!.n)).toBe(0);

    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const requestsBefore = f.provider.requests.length;
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "run: echo token=$SERVICE_TOKEN" });
    expect(result.assistantText).toMatch(/^done: token=\[redacted:SERVICE_TOKEN\]/);

    const secretText = `${value}-v2`;
    for (const request of f.provider.requests.slice(requestsBefore)) expect(JSON.stringify(request)).not.toContain(secretText);
    const messages = await f.runtime.store.listMessages(session.id);
    expect(JSON.stringify(messages)).not.toContain(secretText);
    const runEvents = await f.runtime.store.listRunEvents(result.run.id);
    expect(JSON.stringify(runEvents)).not.toContain(secretText);

    const log = await f.secrets.accessLog(f.companyId);
    expect(log).toMatchObject([{ secretName: "SERVICE_TOKEN", agentId: f.agentId, sessionId: session.id, toolName: "terminal" }]);

    // The binding is per tool: another tool gets nothing.
    expect(await f.secrets.resolveFor({ companyId: f.companyId, agentId: f.agentId, toolName: "read_file" })).toEqual({});
    expect(await f.secrets.remove(f.companyId, "SERVICE_TOKEN")).toBe(true);
    expect(await f.secrets.list(f.companyId)).toEqual([]);
  });

  it("redaction replaces the longest values first and leaves short values alone", () => {
    expect(redactSecrets("a=abcd1234 b=abcd", { A: "abcd1234", B: "abcd" })).toBe("a=[redacted:A] b=[redacted:B]");
    expect(redactSecrets("pin 123", { PIN: "123" })).toBe("pin 123");
  });

  it("pending approvals expire", async () => {
    const short = new ApprovalService(f.db.sql, { ttlMs: 1 });
    await short.request({
      companyId: f.companyId,
      agentId: f.agentId,
      sessionId: null,
      runId: null,
      kind: "budget_increase",
      subject: { cap: 10 },
      reason: "cap reached",
      risk: "medium",
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(await short.expire()).toBe(1);
    expect(await f.auditCount("approval.expired")).toBe(1);
  });
});
