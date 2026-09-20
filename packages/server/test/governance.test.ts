import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("Governance API", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let agentId: string;

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const waitFor = (predicate: (e: { type: string; payload: Record<string, unknown> }) => boolean, timeoutMs = 10_000) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (events.some(predicate)) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error("event did not arrive"));
        setTimeout(tick, 20);
      };
      tick();
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1)!;
      const toolResult = last.content.find((p) => p.type === "tool_result");
      if (toolResult && toolResult.type === "tool_result") return { kind: "text", text: `done: ${toolResult.content}` };
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text.startsWith("run:")) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: text.slice(4).trim() } }] };
      return { kind: "text", text: `echo: ${text}` };
    });
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-gov-"));
    app = await buildApp({
      db,
      connections: { start: false, sandbox: "local" },
      mode: "local",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
    });
    app.opifer.bus.subscribe((e) => events.push(e as { type: string; payload: Record<string, unknown> }));
    await app.ready();
    const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Governed" } })).json() as { id: string };
    companyId = company.id;
    const agent = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Ops", role: "operations" } })).json() as { id: string };
    agentId = agent.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("reports governance in the health check and the effective permissions of an agent", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/health" })).json()).toMatchObject({ governance: "ok" });
    const perms = (await app.inject({ method: "GET", url: `/v1/agents/${agentId}/permissions` })).json() as Array<{ name: string; permission: string; source: string }>;
    expect(perms.find((p) => p.name === "terminal")).toMatchObject({ permission: "approval", source: "risk" });
    expect(perms.find((p) => p.name === "read_file")).toMatchObject({ permission: "automatic", source: "risk" });
  });

  it("suspends a session on a high-risk tool, lists the approval, and resumes on approve", async () => {
    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "run: echo hi" } });
    await waitFor((e) => e.type === "session.event" && (e.payload["event"] as { type: string }).type === "approval_requested");
    await waitFor((e) => e.type === "session.event" && (e.payload["event"] as { type: string; run?: { stopReason: string } }).run?.stopReason === "approval_pending");

    const pending = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{
      id: string;
      kind: string;
      sessionId: string;
    }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "tool_use", sessionId: session.id });

    const decided = await app.inject({ method: "POST", url: `/v1/approvals/${pending[0]!.id}/decide`, payload: { status: "approved", note: "ok" } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "approved", followUp: "session_resumed" });
    await waitFor(
      (e) =>
        e.type === "session.event" &&
        (e.payload["sessionId"] as string) === session.id &&
        (e.payload["event"] as { type: string; run?: { stopReason: string } }).run?.stopReason === "final_answer",
    );
    const messages = (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/messages` })).json() as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(messages.at(-1)!.content[0]!.text).toMatch(/^done: hi/);

    const again = await app.inject({ method: "POST", url: `/v1/approvals/${pending[0]!.id}/decide`, payload: { status: "denied" } });
    expect(again.statusCode).toBe(409);
  });

  it("stops the agent on a reached budget and reactivates it when the increase is approved", async () => {
    app.opifer.governance!.prices.set("fake/echo", { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000, currency: "EUR" });
    const set = await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/budgets`, payload: { scopeKind: "agent", scopeId: agentId, cap: 1 } });
    expect(set.statusCode).toBe(200);

    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "first" } });
    await waitFor((e) => e.type === "session.event" && (e.payload["sessionId"] as string) === session.id && (e.payload["event"] as { type: string }).type === "done");
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "second" } });
    await waitFor((e) => e.type === "agent.budget_stopped");

    const agent = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/agents` })).json() as Array<{ id: string; status: string }>;
    expect(agent.find((a) => a.id === agentId)?.status).toBe("budget_stopped");
    const costs = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/costs` })).json() as { total: { eur: number }; policies: unknown[] };
    expect(costs.total.eur).toBeGreaterThan(1);
    expect(costs.policies).toHaveLength(1);

    const [increase] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string; kind: string }>;
    expect(increase).toMatchObject({ kind: "budget_increase" });
    const decided = (await app.inject({ method: "POST", url: `/v1/approvals/${increase!.id}/decide`, payload: { status: "approved", newCap: 1000 } })).json() as {
      followUp: string;
    };
    expect(decided.followUp).toMatch(/cap raised to 1000 EUR/);
    const after = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/agents` })).json() as Array<{ id: string; status: string }>;
    expect(after.find((a) => a.id === agentId)?.status).toBe("active");
    // The pending turn ("second") resumed once the cap was raised.
    await waitFor(
      (e) =>
        e.type === "session.event" &&
        (e.payload["sessionId"] as string) === session.id &&
        (e.payload["event"] as { type: string; run?: { stopReason: string } }).run?.stopReason === "final_answer" &&
        (e.payload["runId"] as string | null) !== null,
      15_000,
    );
  });

  it("summarises the company for the Home board", async () => {
    type Overview = {
      agents: Array<{ id: string; activity: string; spend: { eur: number; cap: number | null } }>;
      pending: number;
      spend: { eur: number; cap: number | null };
      recentRuns: Array<{ status: string; preview: string | null }>;
      activity: Array<{ action: string }>;
      working: number;
    };
    // The previous turn finishes a moment after its "done" event: wait until nothing runs.
    let overview: Overview;
    for (let i = 0; ; i++) {
      overview = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/overview` })).json() as Overview;
      if (overview.working === 0 || i > 50) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ops = overview.agents.find((a) => a.id === agentId)!;
    expect(ops.activity).toBe("idle");
    expect(ops.spend.eur).toBeGreaterThan(1);
    expect(ops.spend.cap).toBe(1000);
    expect(overview.pending).toBe(0);
    expect(overview.spend.cap).toBeNull();
    expect(overview.recentRuns.some((r) => r.preview?.startsWith("done: hi"))).toBe(true);
    expect(overview.activity.length).toBeGreaterThan(5);
    expect((await app.inject({ method: "GET", url: "/v1/companies/00000000-0000-0000-0000-000000000000/overview" })).statusCode).toBe(404);
  });

  it("emergency stop: one command stops the company — no new turn, no budget reservation, routines suspended — until a person resumes", async () => {
    const routine = await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/routines`,
      payload: { agentId, name: "Tick", prompt: "say hi", scheduleKind: "interval", schedule: "60" },
    });
    expect(routine.statusCode).toBe(201);
    const stopped = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/stop`, payload: { reason: "drill" } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: "suspended", routinesSuspended: 1 });
    // A new turn is refused before any model call.
    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    const refused = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "hello?" } });
    expect([409, 500]).toContain(refused.statusCode);
    expect(JSON.stringify(refused.json())).toContain("suspended");
    // No budget reservation either.
    const decision = await app.opifer.governance!.gates.budget!.reserve(
      { companyId, agentId, sessionId: session.id, runId: session.id, projectId: null, taskId: null },
      { modelId: "fake/echo", inputTokens: 10, maxOutputTokens: 10 },
    );
    expect(decision.allowed).toBe(false);
    // Due routines of a stopped company are not claimed.
    await db.sql`UPDATE routines SET next_due_at = now() - interval '1 second' WHERE company_id = ${companyId}`;
    expect((await app.opifer.routines.claimDue()).claimed).toHaveLength(0);
    expect(events.some((e) => e.type === "company.stopped")).toBe(true);
    // Resume: the routine is claimed, open tasks are woken again, and the agent answers again.
    const task = (
      await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "Interrupted by the drill", assigneeAgentId: agentId } })
    ).json() as { id: string };
    await db.sql`UPDATE wakeups SET status = 'done' WHERE task_id = ${task.id}`;
    const resumed = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as { rewoken: number }).rewoken).toBe(1);
    expect(
      ((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=pending` })).json() as Array<{ taskId: string }>).some((w) => w.taskId === task.id),
    ).toBe(true);
    await app.inject({ method: "POST", url: `/v1/tasks/${task.id}/cancel`, payload: { note: "drill over" } });
    expect((await app.opifer.routines.claimDue()).claimed).toHaveLength(1);
    const ok = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "hello again" } });
    expect(ok.statusCode).toBe(202);
    await app.inject({ method: "DELETE", url: `/v1/companies/${companyId}/routines/${(routine.json() as { id: string }).id}` });
  });

  it("stores secrets without ever returning their values, and versions agent changes", async () => {
    const put = await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/secrets`, payload: { name: "API_KEY", value: "very-secret-value" } });
    expect(put.statusCode).toBe(201);
    expect(JSON.stringify(put.json())).not.toContain("very-secret-value");
    const list = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/secrets` })).json() as Array<{ name: string; version: number }>;
    expect(list).toMatchObject([{ name: "API_KEY", version: 1 }]);
    const bind = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/secret-bindings`, payload: { secretName: "API_KEY", agentId, toolName: "terminal" } });
    expect(bind.statusCode).toBe(201);
    expect((await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/secrets`, payload: { name: "bad name", value: "x" } })).statusCode).toBe(400);

    const patchResponse = await app.inject({ method: "PATCH", url: `/v1/agents/${agentId}`, payload: { role: "operations lead", note: "promotion" } });
    expect(patchResponse.statusCode, patchResponse.body).toBe(200);
    const patched = patchResponse.json() as { revision: number };
    expect(patched.revision).toBe(2);
    const restored = (await app.inject({ method: "POST", url: `/v1/agents/${agentId}/revisions/1/restore` })).json() as { revision: number; config: { role: string } };
    expect(restored).toMatchObject({ revision: 3, config: { role: "operations" } });
    const revisions = (await app.inject({ method: "GET", url: `/v1/agents/${agentId}/revisions` })).json() as Array<{ revision: number }>;
    expect(revisions.map((r) => r.revision)).toEqual([3, 2, 1]);

    const audit = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/audit?limit=500` })).json() as Array<{ action: string }>;
    const actions = new Set(audit.map((a) => a.action));
    for (const expected of [
      "approval.requested",
      "approval.decided",
      "budget.policy_set",
      "budget.blocked",
      "tool.executed",
      "secret.set",
      "secret.bound",
      "agent.updated",
      "agent.status_changed",
    ]) {
      expect(actions, expected).toContain(expected);
    }
    expect(JSON.stringify(audit)).not.toContain("very-secret-value");
  });
});
