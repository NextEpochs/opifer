import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoutineService, WorkError, WorkService, nextDue, normaliseSchedule, parseEveryPhrase } from "../src/index.js";

describe("routines: schedules and at-most-once claims", () => {
  let db: TestDatabase;
  let work: WorkService;
  let routines: RoutineService;
  let companyId: string;
  let agentId: string;
  const person = { kind: "person" as const };

  beforeAll(async () => {
    db = await createTestDatabase();
    const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Routine Co') RETURNING id`;
    const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Sam', 'Operations') RETURNING id`;
    companyId = company!.id;
    agentId = agent!.id;
    work = new WorkService(db.sql);
    routines = new RoutineService(db.sql, work);
  }, 120_000);

  afterAll(async () => db?.destroy());

  it("understands intervals, phrases, cron expressions and single dates", () => {
    expect(parseEveryPhrase("every 2 hours")).toBe(7200);
    expect(parseEveryPhrase("every day")).toBe(86_400);
    expect(parseEveryPhrase("weekly")).toBeNull();
    expect(normaliseSchedule("interval", "every 30 minutes")).toEqual({ kind: "interval", schedule: "1800" });
    expect(() => normaliseSchedule("interval", "every 2 seconds")).toThrow(WorkError);
    expect(normaliseSchedule("cron", "0 9 * * 1", "Europe/Rome").schedule).toBe("0 9 * * 1");
    expect(() => normaliseSchedule("cron", "not a cron")).toThrow(WorkError);
    const monday = nextDue({ scheduleKind: "cron", schedule: "0 9 * * 1", timezone: "Europe/Rome" }, new Date("2026-09-20T12:00:00Z"));
    expect(monday?.toISOString()).toBe("2026-09-21T07:00:00.000Z");
    expect(nextDue({ scheduleKind: "interval", schedule: "600", timezone: "UTC" }, new Date("2026-09-20T12:00:00Z"))?.toISOString()).toBe("2026-09-20T12:10:00.000Z");
    expect(nextDue({ scheduleKind: "once", schedule: "2026-01-01T00:00:00.000Z", timezone: "UTC" }, new Date("2026-09-20T12:00:00Z"))).toBeNull();
  });

  it("one run per due time, whoever claims and however many times", async () => {
    const t0 = new Date("2026-09-20T12:00:00Z");
    const routine = await routines.create(
      { companyId, agentId, name: "Health report", prompt: "Produce the report.", scheduleKind: "interval", schedule: "every 10 minutes" },
      person,
      t0,
    );
    expect(routine.nextDueAt?.toISOString()).toBe("2026-09-20T12:10:00.000Z");
    // Nothing due yet.
    expect((await routines.claimDue(new Date("2026-09-20T12:05:00Z"))).claimed).toHaveLength(0);
    // Two schedulers claim the same tick: one run, one wake-up.
    const at = new Date("2026-09-20T12:10:30Z");
    const [a, b] = await Promise.all([routines.claimDue(at), routines.claimDue(at)]);
    expect(a.claimed.length + b.claimed.length).toBe(1);
    const runs = await routines.listRuns(companyId, routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dueAt.toISOString()).toBe("2026-09-20T12:10:00.000Z");
    const wakeups = (await work.listWakeups(companyId)).filter((w) => w.reason === "routine");
    expect(wakeups.filter((w) => w.status === "pending")).toHaveLength(1);
    expect(wakeups[0]!.dedupeKey).toBe(`routine:${routine.id}:2026-09-20T12:10:00.000Z`);
    // Claiming again for the same moment finds nothing: the due time is spent.
    expect((await routines.claimDue(at)).claimed).toHaveLength(0);
    expect((await routines.get(companyId, routine.id))?.nextDueAt?.toISOString()).toBe("2026-09-20T12:20:00.000Z");
  });

  it("missed due times inside the catch-up window run late; older ones are skipped and recorded", async () => {
    const t0 = new Date("2026-09-20T12:00:00Z");
    const routine = await routines.create(
      { companyId, agentId, name: "Hourly check", prompt: "Check.", scheduleKind: "interval", schedule: "3600", catchUpSeconds: 5400 },
      person,
      t0,
    );
    // The server was down for four hours: 13:00, 14:00, 15:00, 16:00 are due at 16:30.
    const result = await routines.claimDue(new Date("2026-09-20T16:30:00Z"));
    const mine = result.claimed.filter((r) => r.routineId === routine.id);
    expect(mine.map((r) => r.dueAt.toISOString())).toEqual(["2026-09-20T15:00:00.000Z", "2026-09-20T16:00:00.000Z"]);
    const all = await routines.listRuns(companyId, routine.id);
    expect(
      all
        .filter((r) => r.status === "skipped")
        .map((r) => r.dueAt.toISOString())
        .sort(),
    ).toEqual(["2026-09-20T13:00:00.000Z", "2026-09-20T14:00:00.000Z"]);
    expect((await routines.get(companyId, routine.id))?.nextDueAt?.toISOString()).toBe("2026-09-20T17:00:00.000Z");
  });

  it("a run cut by a restart is interrupted and never re-run; the next due time still runs", async () => {
    const t0 = new Date("2026-09-20T12:00:00Z");
    const routine = await routines.create({ companyId, agentId, name: "Nightly", prompt: "Do it.", scheduleKind: "interval", schedule: "600" }, person, t0);
    const { claimed } = await routines.claimDue(new Date("2026-09-20T12:10:00Z"));
    const run = claimed.find((r) => r.routineId === routine.id)!;
    const [session] = await db.sql<
      { id: string }[]
    >`INSERT INTO sessions (company_id, agent_id, kind, system_prompt, system_prompt_hash, model) VALUES (${companyId}, ${agentId}, 'routine', 'p', 'h', 'fake/echo') RETURNING id`;
    expect((await routines.startRun(run.id, session!.id))?.status).toBe("running");
    // Only a claimed run can start: the same run cannot be started twice.
    expect(await routines.startRun(run.id, session!.id)).toBeNull();
    // Crash and restart.
    expect(await routines.markStaleRunsInterrupted()).toBe(1);
    expect((await routines.getRun(companyId, run.id))?.status).toBe("interrupted");
    expect((await routines.claimDue(new Date("2026-09-20T12:10:00Z"))).claimed.filter((r) => r.routineId === routine.id)).toHaveLength(0);
    const next = (await routines.claimDue(new Date("2026-09-20T12:20:00Z"))).claimed.filter((r) => r.routineId === routine.id);
    expect(next).toHaveLength(1);
    expect(next[0]!.dueAt.toISOString()).toBe("2026-09-20T12:20:00.000Z");
  });

  it("disabling stops the clock, enabling restarts it, trigger runs now", async () => {
    const t0 = new Date("2026-09-20T12:00:00Z");
    const routine = await routines.create(
      { companyId, agentId, name: "Weekly digest", prompt: "Digest.", scheduleKind: "cron", schedule: "0 9 * * 1", timezone: "Europe/Rome" },
      person,
      t0,
    );
    const off = await routines.update(companyId, routine.id, { enabled: false }, person);
    expect(off.nextDueAt).toBeNull();
    const on = await routines.update(companyId, routine.id, { enabled: true }, person, new Date("2026-09-22T12:00:00Z"));
    expect(on.nextDueAt?.toISOString()).toBe("2026-09-28T07:00:00.000Z");
    const run = await routines.trigger(companyId, routine.id, person, new Date("2026-09-22T12:30:00Z"));
    expect(run?.status).toBe("claimed");
    expect(await routines.listRuns(companyId, routine.id)).toHaveLength(1);
  });
});
