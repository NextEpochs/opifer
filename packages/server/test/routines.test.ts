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
  const delivered: Array<{ routine: string; text: string }> = [];
  let hang = false;

  const runScheduler = async () => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < 4; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      if (hang) return { kind: "hang" };
      const text = request.messages
        .at(-1)!
        .content.map((p) => (p.type === "text" ? p.text : ""))
        .join("");
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
