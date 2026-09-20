import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

/** Routines through the scheduler: a due time becomes one session, one run, one delivery. */
describe("Routines: scheduled runs in their own session", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let sam: string;
  let dev: string;
  const delivered: Array<{ routine: string; text: string }> = [];
  let hang = false;

  const runScheduler = async () => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      if (hang) return { kind: "hang" };
      const last = request.messages.at(-1)!;
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      // Task mode: the manager delegates the numbers to Dev and waits; Dev delivers; the manager approves Dev's work, is woken up, and delivers the digest.
      const toolResult = last.content.find((p) => p.type === "tool_result");
      if (toolResult && toolResult.type === "tool_result") {
        const r = toolResult.content;
        if (r.startsWith("Task:") && r.includes("[done]"))
          return { kind: "tools", calls: [{ name: "task_deliver", arguments: { summary: "Weekly digest: 16 packages, 134 tests green", verification: "read the subtask" } }] };
        if (r.startsWith("Task:") && r.includes("run of the routine"))
          return { kind: "tools", calls: [{ name: "task_create", arguments: { title: "Collect the week's numbers", assignee: "Dev" } }] };
        if (r.startsWith("Task:") && r.includes("Numbers:")) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "echo check-ok" } }] };
        if (r.includes("healthy")) return { kind: "text", text: `Health: all good (${r.trim().slice(0, 20)})` };
        if (r.includes("check-ok")) return { kind: "tools", calls: [{ name: "task_approve", arguments: { verification: "the numbers match pnpm test" } }] };
        if (r.startsWith("Task:"))
          return { kind: "tools", calls: [{ name: "task_deliver", arguments: { summary: "Numbers: 16 packages, 134 tests green", verification: "pnpm test" } }] };
        if (r.startsWith("Subtask created")) return { kind: "tools", calls: [{ name: "task_deliver", arguments: { summary: "too early", verification: "none" } }] };
        if (r.includes("still open")) return { kind: "text", text: "Waiting for Dev." };
        return { kind: "text", text: `ok: ${r.slice(0, 40)}` };
      }
      if (text.startsWith("Check health")) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "echo healthy" } }] };
      if (text.startsWith("You have been assigned") || text.includes("for your review") || text.startsWith("The subtask"))
        return { kind: "tools", calls: [{ name: "task_status", arguments: {} }] };
      if (request.system.includes("Skill to follow:")) return { kind: "text", text: `Report done by the skill: 3 packages, 0 failures. (${text.slice(0, 20)})` };
      return { kind: "text", text: `Report done: all green. (${text.slice(0, 20)})` };
    });
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-routines-"));
    app = await buildApp({
      db,
      mode: "local",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
      work: { scheduler: false },
      learning: { worker: false },
      connections: { start: false, sandbox: "local" },
    });
    app.opifer.scheduler!.deliverTo(async (routine, _run, text) => {
      delivered.push({ routine: routine.name, text });
    });
    await app.ready();
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Routine Co", mission: "Keep things running" } })).json() as { id: string }).id;
    sam = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Sam", role: "Operations" } })).json() as { id: string }).id;
    dev = (
      (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Dev", role: "Developer", reportsToAgentId: sam } })).json() as { id: string }
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("a due routine runs once in its own session, the result is delivered, and no memory is written", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/routines`,
      payload: {
        agentId: sam,
        name: "Health report",
        prompt: "Produce the repository health report.",
        scheduleKind: "interval",
        schedule: "every 10 minutes",
        deliverTo: ["inbox"],
      },
    });
    expect(created.statusCode).toBe(201);
    const routine = created.json() as { id: string; nextDueAt: string };
    // Make it due now.
    await db.sql`UPDATE routines SET next_due_at = now() - interval '1 second' WHERE id = ${routine.id}`;
    await runScheduler();
    const runs = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{
      status: string;
      result: string | null;
      sessionId: string | null;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.result).toContain("Report done: all green");
    expect(delivered).toEqual([{ routine: "Health report", text: expect.stringContaining("Report done") }]);
    const session = (await app.inject({ method: "GET", url: `/v1/sessions/${runs[0]!.sessionId}` })).json() as { kind: string; systemPrompt: string; title: string };
    expect(session.kind).toBe("routine");
    expect(session.systemPrompt).toContain('routine "Health report"');
    expect(session.title.startsWith("Health report")).toBe(true);
    // Routines do not learn unless told to: no review queued.
    const reviews = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/learning/reviews` })).json() as unknown[];
    expect(reviews).toHaveLength(0);
    // Running the scheduler again does not run the same due time twice.
    await runScheduler();
    expect((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json()).toHaveLength(1);
  });

  it("a routine with a skill gets its text in the context; trigger runs it now", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/skills`,
      payload: {
        scope: "agent",
        scopeAgentId: sam,
        name: "health-report",
        description: "How to produce the health report",
        content: "1. Count packages.\n2. Run the tests.\n3. Report.",
      },
    });
    const routine = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/routines`,
        payload: {
          agentId: sam,
          name: "Skilled report",
          prompt: "Produce the report.",
          scheduleKind: "cron",
          schedule: "0 9 * * 1",
          timezone: "Europe/Rome",
          skills: ["health-report"],
        },
      })
    ).json() as { id: string; nextDueAt: string };
    expect(new Date(routine.nextDueAt).getUTCDay()).toBe(1);
    const triggered = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/routines/${routine.id}/run` });
    expect(triggered.statusCode).toBe(200);
    await runScheduler();
    const runs = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{ status: string; result: string | null }>;
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.result).toContain("done by the skill");
    const skill = ((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/skills?agent=${sam}` })).json() as Array<{ name: string; uses: number }>).find(
      (s) => s.name === "health-report",
    );
    expect(skill?.uses).toBe(1);
  });

  it("in task mode a run is a task: the agent delegates to a report, delivers, and the run closes with the task", async () => {
    const routine = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/routines`,
        payload: {
          agentId: sam,
          name: "Weekly digest",
          prompt: "Write the weekly digest with the numbers from Dev.",
          scheduleKind: "cron",
          schedule: "0 9 * * 1",
          mode: "task",
          deliverTo: ["channels"],
        },
      })
    ).json() as { id: string; mode: string };
    expect(routine.mode).toBe("task");
    await app.inject({ method: "POST", url: `/v1/companies/${companyId}/routines/${routine.id}/run` });
    await runScheduler();
    const [run] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{
      id: string;
      status: string;
      taskId: string | null;
      sessionId: string | null;
    }>;
    expect(run!.status).toBe("running");
    expect(run!.taskId).toBeTruthy();
    expect(run!.sessionId).toBeNull();
    // The task went to Sam, who delegated the numbers to Dev, was refused an early delivery and waited; Dev delivered for Sam's
    // review; Sam approved; the closed subtask woke Sam up, who delivered the digest.
    const taskUrl = `/v1/tasks/${run!.taskId}`;
    let task = (await app.inject({ method: "GET", url: taskUrl })).json() as {
      title: string;
      status: string;
      assigneeAgentId: string;
      description: string;
      comments: Array<{ body: string }>;
    };
    expect(task.title.startsWith("Weekly digest · ")).toBe(true);
    expect(task.assigneeAgentId).toBe(sam);
    expect(task.description).toContain("Write the weekly digest");
    expect(task.comments.some((c) => c.body.startsWith("Sam is waiting for 1 subtask"))).toBe(true);
    expect(task.status).toBe("todo");
    let [sub] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/tasks?parentId=${run!.taskId}` })).json() as Array<{
      id: string;
      title: string;
      assigneeAgentId: string;
      reviewerAgentId: string;
      status: string;
      result: { summary: string; verification: string };
    }>;
    // Sam, reviewing, checked the numbers with a command that needs approval: the decision resumes a reviewer's turn too.
    expect(sub).toMatchObject({ title: "Collect the week's numbers", assigneeAgentId: dev, reviewerAgentId: sam, status: "in_review" });
    const [pending] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string; agentId: string }>;
    expect(pending?.agentId).toBe(sam);
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${pending!.id}/decide`, payload: { status: "approved" } })).statusCode).toBe(200);
    await runScheduler();
    sub = ((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/tasks?parentId=${run!.taskId}` })).json() as (typeof sub)[])[0];
    expect(sub!.status).toBe("done");
    expect(sub!.result).toEqual({ summary: "Numbers: 16 packages, 134 tests green", verification: "the numbers match pnpm test" });
    task = (await app.inject({ method: "GET", url: taskUrl })).json() as typeof task;
    expect(task.status).toBe("in_review");
    expect(delivered.some((d) => d.routine === "Weekly digest")).toBe(false);
    // A person verifies the digest: the run closes with the task and is delivered.
    const done = await app.inject({ method: "POST", url: `${taskUrl}/complete`, payload: { summary: "Digest verified and sent", verification: "read it" } });
    expect(done.statusCode).toBe(200);
    const [closed] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{
      status: string;
      result: string | null;
    }>;
    expect(closed!.status).toBe("done");
    expect(closed!.result).toBe("Digest verified and sent");
    expect(delivered).toContainEqual({ routine: "Weekly digest", text: "Digest verified and sent" });
    await runScheduler();
    expect((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/wakeups?status=pending` })).json()).toEqual([]);
  });

  it("a run that needs an approval waits for the decision and finishes with the real result", async () => {
    const routine = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/routines`,
        payload: { agentId: sam, name: "Health probe", prompt: "Check health with a command.", scheduleKind: "interval", schedule: "600", idleTimeoutSeconds: 2 },
      })
    ).json() as { id: string };
    await app.inject({ method: "POST", url: `/v1/companies/${companyId}/routines/${routine.id}/run` });
    const scheduler = app.opifer.scheduler!;
    await scheduler.tick();
    let pending: Array<{ id: string; sessionId: string }> = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pending = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as typeof pending;
    }
    expect(pending).toHaveLength(1);
    // Waiting for the person is not inactivity: well past the idle timeout the run is still running.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let [run] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{ status: string; result: string | null }>;
    expect(run!.status).toBe("running");
    const decided = (await app.inject({ method: "POST", url: `/v1/approvals/${pending[0]!.id}/decide`, payload: { status: "approved" } })).json() as { followUp: string };
    expect(decided.followUp).toBe("routine_resumed");
    await scheduler.drain();
    [run] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as (typeof run)[];
    expect(run!.status).toBe("done");
    expect(run!.result).toContain("Health: all good (healthy");
  });

  it("a run that goes quiet is stopped for inactivity, not for duration", async () => {
    const routine = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/routines`,
        payload: { agentId: sam, name: "Slow one", prompt: "Take your time.", scheduleKind: "interval", schedule: "600", idleTimeoutSeconds: 1 },
      })
    ).json() as { id: string };
    hang = true;
    try {
      await app.inject({ method: "POST", url: `/v1/companies/${companyId}/routines/${routine.id}/run` });
      await runScheduler();
    } finally {
      hang = false;
    }
    const runs = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{ status: string; error: string | null }>;
    expect(runs[0]!.status).toBe("interrupted");
    expect(runs[0]!.error).toContain("inactivity");
  });
});
