import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

/**
 * A scripted worker: on assignment it reads the task, writes the file,
 * runs a (high-risk) command, and delivers; on a comment it answers.
 */
describe("Work: tasks, wake-ups and the scheduler", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let philip: string;
  let nora: string;
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

  const runScheduler = async () => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < 5; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1)!;
      const toolResult = last.content.find((p) => p.type === "tool_result");
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      const tools = request.tools?.map((t) => t.name) ?? [];
      if (toolResult && toolResult.type === "tool_result") {
        const r = toolResult.content;
        if (r.startsWith("Task:")) return { kind: "tools", calls: [{ name: "write_file", arguments: { path: "pricing.md", content: "# Pricing\nThree tiers." } }] };
        if (/^\s*\d+ pricing.md/.test(r) || r.includes("exit code 0")) {
          return { kind: "tools", calls: [{ name: "task_deliver", arguments: { summary: "Pricing page drafted with three tiers", verification: "open pricing.md", products: [{ kind: "file", title: "pricing.md", ref: "pricing.md" }] } }] };
        }
        if (r.startsWith("Wrote")) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "wc -l pricing.md" } }] };
        return { kind: "text", text: `ok: ${r.slice(0, 40)}` };
      }
      if (text.startsWith("You have been assigned") || text.startsWith("The reviewer sent")) return { kind: "tools", calls: [{ name: "task_status", arguments: {} }] };
      if (text.startsWith("New comment") && tools.includes("task_comment")) return { kind: "tools", text: "Replying.", calls: [{ name: "task_comment", arguments: { body: "Thanks, noted." } }] };
      return { kind: "text", text: `echo: ${text.slice(0, 40)}` };
    });
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-work-"));
    app = await buildApp({
      db,
      mode: "local",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
      work: { scheduler: false, leaseMs: 60_000 },
    });
    app.opifer.bus.subscribe((e) => events.push(e as { type: string; payload: Record<string, unknown> }));
    await app.ready();
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Work Co", mission: "Ship useful software" } })).json() as { id: string }).id;
    philip = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Philip", role: "CEO" } })).json() as { id: string }).id;
    nora = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Nora", role: "Researcher", reportsToAgentId: philip } })).json() as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("assigning a task wakes the agent, who checks it out, works with a heartbeat, asks approval, and delivers for review", async () => {
    const goal = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/goals`, payload: { title: "Launch the pricing page", measure: "page live" } })).json() as { id: string };
    const project = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/projects`, payload: { name: "Website", goalId: goal.id } })).json() as { id: string };
    const created = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "Draft the pricing page", acceptance: "a pricing.md with three tiers", projectId: project.id, assigneeAgentId: nora, priority: "high" } });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; status: string; goalId: string };
    expect(task.status).toBe("todo");
    expect(task.goalId).toBe(goal.id);
    const wakeups = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=pending` })).json() as Array<{ reason: string; taskId: string }>;
    expect(wakeups).toContainEqual(expect.objectContaining({ reason: "assignment", taskId: task.id }));

    // The scheduler runs the wake-up: the turn stops at the terminal approval, the lease is suspended.
    await runScheduler();
    let detail = (await app.inject({ method: "GET", url: `/v1/tasks/${task.id}` })).json() as { status: string; leaseExpiresAt: string | null; leaseSessionId: string | null; sessions: Array<{ id: string }>; why: { goals: Array<{ title: string }>; project: { name: string } } };
    expect(detail.status).toBe("in_progress");
    expect(detail.leaseExpiresAt).toBeNull();
    expect(detail.sessions).toHaveLength(1);
    expect(detail.why.goals[0]?.title).toBe("Launch the pricing page");
    expect(detail.why.project.name).toBe("Website");
    const session = (await app.inject({ method: "GET", url: `/v1/sessions/${detail.sessions[0]!.id}` })).json() as { kind: string; taskId: string; systemPrompt: string };
    expect(session.kind).toBe("task");
    expect(session.taskId).toBe(task.id);
    expect(session.systemPrompt).toContain("Why this matters");
    expect(session.systemPrompt).toContain("Ship useful software");

    const [pending] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string; kind: string; subject: { tool: string } }>;
    expect(pending).toMatchObject({ kind: "tool_use", subject: { tool: "terminal" } });
    const decided = (await app.inject({ method: "POST", url: `/v1/approvals/${pending!.id}/decide`, payload: { status: "approved" } })).json() as { followUp: string };
    expect(decided.followUp).toBe("task_resumed");

    // The decision wake-up resumes the lease and the turn; the agent delivers.
    await runScheduler();
    detail = (await app.inject({ method: "GET", url: `/v1/tasks/${task.id}` })).json() as typeof detail & { result: { summary: string }; products: Array<{ kind: string; title: string }> };
    expect(detail.status).toBe("in_review");
    expect((detail as { result: { summary: string } }).result.summary).toMatch(/three tiers/);
    expect((detail as { products: Array<{ title: string }> }).products.map((p) => p.title)).toEqual(["pricing.md"]);
    await waitFor((e) => e.type === "task.updated" && e.payload["taskId"] === task.id && e.payload["status"] === "in_review");

    // A person verifies and closes it.
    const done = await app.inject({ method: "POST", url: `/v1/tasks/${task.id}/complete`, payload: { summary: "Verified: pricing.md has three tiers", verification: "read the file" } });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { status: string }).status).toBe("done");
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${task.id}/complete`, payload: { summary: "again" } })).statusCode).toBe(409);
  });

  it("a person's comment wakes the assignee, who answers with a comment; changes requested send the task back", async () => {
    const created = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "Compare competitors", assigneeAgentId: nora } })).json() as { id: string };
    // Consume the assignment: Nora starts, asks approval for the terminal, and waits.
    await runScheduler();
    const [pending] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string }>;
    // While she waits for the decision, a comment arrives: the wake-up is deferred, not lost.
    const commented = await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/comments`, payload: { body: "Focus on the three biggest, @Nora" } });
    expect(commented.statusCode).toBe(201);
    await runScheduler();
    let detail = (await app.inject({ method: "GET", url: `/v1/tasks/${created.id}` })).json() as { status: string; comments: Array<{ authorKind: string; body: string }> };
    expect(detail.comments.map((c) => c.body)).not.toContain("Thanks, noted.");
    const deferred = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=pending` })).json() as Array<{ reason: string; taskId: string; error: string | null }>;
    expect(deferred.find((w) => w.taskId === created.id && w.reason === "mention")?.error).toMatch(/waiting for a decision/);
    // Approve: she delivers. Then the deferred comment reaches her on the same session and she answers.
    await app.inject({ method: "POST", url: `/v1/approvals/${pending!.id}/decide`, payload: { status: "approved" } });
    await runScheduler();
    detail = (await app.inject({ method: "GET", url: `/v1/tasks/${created.id}` })).json() as typeof detail;
    expect(detail.status).toBe("in_review");
    await db.sql`UPDATE wakeups SET scheduled_at = now() WHERE status = 'pending' AND task_id = ${created.id}`;
    await runScheduler();
    detail = (await app.inject({ method: "GET", url: `/v1/tasks/${created.id}` })).json() as typeof detail;
    expect(detail.comments.map((c) => c.body)).toContain("Thanks, noted.");
    const back = await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/request-changes`, payload: { note: "add the enterprise tier" } });
    expect((back.json() as { status: string }).status).toBe("todo");
    const wakeups = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=pending` })).json() as Array<{ reason: string; taskId: string; payload: { changesRequested?: string } }>;
    expect(wakeups.find((w) => w.taskId === created.id)?.payload.changesRequested).toBe("add the enterprise tier");
  });

  it("a paused agent is skipped; blocking, unblocking and cancelling are audited; the overview shows the task work", async () => {
    await app.inject({ method: "POST", url: `/v1/agents/${nora}/status`, payload: { status: "paused" } });
    const created = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "While paused", assigneeAgentId: nora } })).json() as { id: string };
    await runScheduler();
    const skipped = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=skipped` })).json() as Array<{ taskId: string; error: string }>;
    expect(skipped.find((w) => w.taskId === created.id)?.error).toMatch(/paused/);
    await app.inject({ method: "POST", url: `/v1/agents/${nora}/status`, payload: { status: "active" } });

    expect((await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/block`, payload: { reason: "waiting for the brand kit" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/unblock` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/cancel`, payload: { reason: "not needed" } })).statusCode).toBe(200);
    const audit = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/audit?limit=500` })).json() as Array<{ action: string }>;
    const actions = new Set(audit.map((a) => a.action));
    for (const expected of ["task.created", "task.checked_out", "task.suspended", "task.review_requested", "task.done", "task.commented", "task.changes_requested", "task.blocked", "task.unblocked", "task.cancelled", "task.product_added", "goal.created", "project.created"]) {
      expect(actions, expected).toContain(expected);
    }
    const overview = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/overview` })).json() as { recentRuns: Array<{ sessionTitle: string | null }> };
    expect(overview.recentRuns.some((r) => r.sessionTitle === "Draft the pricing page")).toBe(true);
  });
});
