/**
 * Routines: recurring work with an at-most-once guarantee. Every due time
 * becomes one row of `routine_runs` (unique per routine and due time) and
 * one wake-up; a second scheduler, or the same one after a crash, cannot
 * claim the same due time again. Missed due times inside the catch-up
 * window run late; older ones are recorded as skipped.
 */

import { Cron } from "croner";
import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import type { WorkService } from "./service.js";
import { WorkError } from "./service.js";
import type { Actor } from "./types.js";

export type ScheduleKind = "interval" | "cron" | "once";
export type RoutineRunStatus = "claimed" | "running" | "done" | "failed" | "skipped" | "interrupted";
/** session: the agent answers in a session of its own; task: every run is a task the agent works on, delegates and gets reviewed like any other work. */
export type RoutineMode = "session" | "task";

export interface Routine {
  id: string;
  companyId: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone: string;
  skills: string[];
  model: string | null;
  deliverTo: string[];
  catchUpSeconds: number;
  idleTimeoutSeconds: number;
  learn: boolean;
  mode: RoutineMode;
  enabled: boolean;
  nextDueAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineRun {
  id: string;
  companyId: string;
  routineId: string;
  dueAt: Date;
  sessionId: string | null;
  taskId: string | null;
  status: RoutineRunStatus;
  result: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

interface RoutineRow {
  id: string;
  company_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule: string;
  timezone: string;
  skills: string[];
  model: string | null;
  deliver_to: string[];
  catch_up_seconds: number;
  idle_timeout_seconds: number;
  learn: boolean;
  mode: RoutineMode;
  enabled: boolean;
  next_due_at: Date | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  company_id: string;
  routine_id: string;
  due_at: Date;
  session_id: string | null;
  task_id: string | null;
  status: RoutineRunStatus;
  result: string | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

const toRoutine = (r: RoutineRow): Routine => ({
  id: r.id,
  companyId: r.company_id,
  agentId: r.agent_id,
  name: r.name,
  prompt: r.prompt,
  scheduleKind: r.schedule_kind,
  schedule: r.schedule,
  timezone: r.timezone,
  skills: r.skills,
  model: r.model,
  deliverTo: r.deliver_to,
  catchUpSeconds: r.catch_up_seconds,
  idleTimeoutSeconds: r.idle_timeout_seconds,
  learn: r.learn,
  mode: r.mode,
  enabled: r.enabled,
  nextDueAt: r.next_due_at,
  lastRunAt: r.last_run_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): RoutineRun => ({
  id: r.id,
  companyId: r.company_id,
  routineId: r.routine_id,
  dueAt: r.due_at,
  sessionId: r.session_id,
  taskId: r.task_id,
  status: r.status,
  result: r.result,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
});

/** "every 2 hours", "every 30 minutes", "every day" → seconds; null when it is not a phrase. */
export function parseEveryPhrase(text: string): number | null {
  const m = /^every\s+(?:(\d+)\s*)?(second|minute|hour|day|week)s?$/i.exec(text.trim());
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const unit: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800 };
  return n * unit[m[2]!.toLowerCase()]!;
}

/** Validates a schedule and returns its normalised form. */
export function normaliseSchedule(kind: ScheduleKind, schedule: string, timezone = "UTC"): { kind: ScheduleKind; schedule: string } {
  const text = schedule.trim();
  if (kind === "interval") {
    const seconds = /^\d+$/.test(text) ? Number(text) : parseEveryPhrase(text);
    if (!seconds || seconds < 10) throw new WorkError("invalid_input", `an interval is a number of seconds (at least 10) or a phrase like "every 2 hours": "${schedule}"`);
    return { kind, schedule: String(seconds) };
  }
  if (kind === "cron") {
    try {
      new Cron(text, { timezone, maxRuns: 1 });
    } catch (error) {
      throw new WorkError("invalid_input", `not a cron expression: "${schedule}" (${error instanceof Error ? error.message : String(error)})`);
    }
    return { kind, schedule: text };
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new WorkError("invalid_input", `not a date: "${schedule}"`);
  return { kind, schedule: date.toISOString() };
}

/** The next due time strictly after `after`, or null when there is none. */
export function nextDue(routine: Pick<Routine, "scheduleKind" | "schedule" | "timezone">, after: Date): Date | null {
  if (routine.scheduleKind === "interval") return new Date(after.getTime() + Number(routine.schedule) * 1000);
  if (routine.scheduleKind === "cron") {
    const next = new Cron(routine.schedule, { timezone: routine.timezone, maxRuns: 1 }).nextRun(after);
    return next ?? null;
  }
  const once = new Date(routine.schedule);
  return once.getTime() > after.getTime() ? once : null;
}

export interface CreateRoutineInput {
  companyId: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  schedule: string;
  timezone?: string;
  skills?: string[];
  model?: string | null;
  deliverTo?: string[];
  catchUpSeconds?: number;
  idleTimeoutSeconds?: number;
  learn?: boolean;
  mode?: RoutineMode;
  enabled?: boolean;
}

export class RoutineService {
  constructor(
    private readonly sql: Sql,
    private readonly work: WorkService,
  ) {}

  async create(input: CreateRoutineInput, actor: Actor, now: Date = new Date()): Promise<Routine> {
    if (!input.name.trim()) throw new WorkError("invalid_input", "a routine needs a name");
    if (!input.prompt.trim()) throw new WorkError("invalid_input", "a routine needs a prompt: what the agent should do each time");
    const timezone = input.timezone ?? "UTC";
    const schedule = normaliseSchedule(input.scheduleKind, input.schedule, timezone);
    const first = nextDue({ scheduleKind: schedule.kind, schedule: schedule.schedule, timezone }, now);
    const [row] = await this.sql<RoutineRow[]>`
      INSERT INTO routines (company_id, agent_id, name, prompt, schedule_kind, schedule, timezone, skills, model, deliver_to, catch_up_seconds, idle_timeout_seconds, learn, mode, enabled, next_due_at, created_by_kind, created_by_id)
      VALUES (${input.companyId}, ${input.agentId}, ${input.name.trim()}, ${input.prompt.trim()}, ${schedule.kind}, ${schedule.schedule}, ${timezone}, ${input.skills ?? []}, ${input.model ?? null},
              ${(input.deliverTo ?? []) as never}::jsonb, ${input.catchUpSeconds ?? 3600}, ${input.idleTimeoutSeconds ?? 600}, ${input.learn ?? false}, ${input.mode ?? "session"}, ${input.enabled ?? true}, ${first}, ${actor.kind}, ${actor.id ?? null})
      RETURNING *
    `;
    const routine = toRoutine(row!);
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "routine.created",
      subjectKind: "routine",
      subjectId: routine.id,
      after: { name: routine.name, agentId: routine.agentId, scheduleKind: routine.scheduleKind, schedule: routine.schedule, nextDueAt: routine.nextDueAt?.toISOString() ?? null },
    });
    return routine;
  }

  async get(companyId: string, id: string): Promise<Routine | null> {
    const [row] = await this.sql<RoutineRow[]>`SELECT * FROM routines WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toRoutine(row) : null;
  }

  async list(companyId: string, filter: { agentId?: string } = {}): Promise<Routine[]> {
    const rows = filter.agentId
      ? await this.sql<RoutineRow[]>`SELECT * FROM routines WHERE company_id = ${companyId} AND agent_id = ${filter.agentId} ORDER BY name`
      : await this.sql<RoutineRow[]>`SELECT * FROM routines WHERE company_id = ${companyId} ORDER BY name`;
    return rows.map(toRoutine);
  }

  async update(companyId: string, id: string, patch: Partial<Omit<CreateRoutineInput, "companyId">>, actor: Actor, now: Date = new Date()): Promise<Routine> {
    const current = await this.get(companyId, id);
    if (!current) throw new WorkError("not_found", "routine not found");
    const timezone = patch.timezone ?? current.timezone;
    const kind = patch.scheduleKind ?? current.scheduleKind;
    const scheduleChanged = patch.schedule !== undefined || patch.scheduleKind !== undefined || patch.timezone !== undefined;
    const schedule = scheduleChanged ? normaliseSchedule(kind, patch.schedule ?? current.schedule, timezone) : { kind, schedule: current.schedule };
    const enabled = patch.enabled ?? current.enabled;
    const next = scheduleChanged || (enabled && !current.enabled) ? nextDue({ scheduleKind: schedule.kind, schedule: schedule.schedule, timezone }, now) : current.nextDueAt;
    const [row] = await this.sql<RoutineRow[]>`
      UPDATE routines SET agent_id = ${patch.agentId ?? current.agentId}, name = ${(patch.name ?? current.name).trim()}, prompt = ${(patch.prompt ?? current.prompt).trim()},
        schedule_kind = ${schedule.kind}, schedule = ${schedule.schedule}, timezone = ${timezone}, skills = ${patch.skills ?? current.skills}, model = ${patch.model === undefined ? current.model : patch.model},
        deliver_to = ${(patch.deliverTo ?? current.deliverTo) as never}::jsonb, catch_up_seconds = ${patch.catchUpSeconds ?? current.catchUpSeconds}, idle_timeout_seconds = ${patch.idleTimeoutSeconds ?? current.idleTimeoutSeconds},
        learn = ${patch.learn ?? current.learn}, mode = ${patch.mode ?? current.mode}, enabled = ${enabled}, next_due_at = ${enabled ? next : null}
      WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "routine.updated",
      subjectKind: "routine",
      subjectId: id,
      before: { enabled: current.enabled, schedule: current.schedule },
      after: { ...patch, nextDueAt: row!.next_due_at?.toISOString() ?? null },
    });
    return toRoutine(row!);
  }

  async remove(companyId: string, id: string, actor: Actor): Promise<void> {
    const current = await this.get(companyId, id);
    if (!current) throw new WorkError("not_found", "routine not found");
    await this.sql`DELETE FROM routines WHERE id = ${id}`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "routine.removed",
      subjectKind: "routine",
      subjectId: id,
      before: { name: current.name },
    });
  }

  /** Runs the routine now, outside its schedule: a run for "now" as due time. */
  async trigger(companyId: string, id: string, actor: Actor, now: Date = new Date()): Promise<RoutineRun | null> {
    const routine = await this.get(companyId, id);
    if (!routine) throw new WorkError("not_found", "routine not found");
    const run = await this.claimOne(routine, now);
    if (run)
      await audit(this.sql, {
        companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "routine.triggered",
        subjectKind: "routine",
        subjectId: id,
        after: { runId: run.id },
      });
    return run;
  }

  /**
   * Claims every due routine: one run per due time, at most once, and a
   * wake-up for the agent. Returns the runs claimed and the due times skipped.
   */
  async claimDue(now: Date = new Date()): Promise<{ claimed: RoutineRun[]; skipped: number }> {
    const claimed: RoutineRun[] = [];
    let skipped = 0;
    const due = await this.sql<
      RoutineRow[]
    >`SELECT r.* FROM routines r JOIN companies c ON c.id = r.company_id WHERE r.enabled AND c.status = 'active' AND r.next_due_at IS NOT NULL AND r.next_due_at <= ${now} ORDER BY r.next_due_at FOR UPDATE OF r SKIP LOCKED`;
    for (const row of due) {
      const routine = toRoutine(row);
      // Walk the due times up to now: late ones inside the window run, older ones are skipped.
      let cursor: Date | null = routine.nextDueAt;
      let guard = 0;
      while (cursor && cursor.getTime() <= now.getTime() && guard++ < 1000) {
        const late = (now.getTime() - cursor.getTime()) / 1000;
        if (late > routine.catchUpSeconds) {
          await this
            .sql`INSERT INTO routine_runs (company_id, routine_id, due_at, status, error, finished_at) VALUES (${routine.companyId}, ${routine.id}, ${cursor}, 'skipped', ${`missed by ${Math.round(late)} seconds, beyond the catch-up window`}, ${now}) ON CONFLICT (routine_id, due_at) DO NOTHING`;
          skipped++;
        } else {
          const run = await this.claimOne(routine, cursor);
          if (run) claimed.push(run);
        }
        cursor = nextDue(routine, cursor);
      }
      await this.sql`UPDATE routines SET next_due_at = ${cursor} WHERE id = ${routine.id}`;
    }
    return { claimed, skipped };
  }

  /** One run for one due time; null when it was already claimed (by anyone, ever). */
  private async claimOne(routine: Routine, dueAt: Date): Promise<RoutineRun | null> {
    const [row] = await this.sql<RunRow[]>`
      INSERT INTO routine_runs (company_id, routine_id, due_at) VALUES (${routine.companyId}, ${routine.id}, ${dueAt})
      ON CONFLICT (routine_id, due_at) DO NOTHING RETURNING *
    `;
    if (!row) return null;
    await this.work.wake(routine.companyId, routine.agentId, "routine", {
      dedupeKey: `routine:${routine.id}:${dueAt.toISOString()}`,
      payload: { routineId: routine.id, runId: row.id, dueAt: dueAt.toISOString() },
    });
    return toRun(row);
  }

  async getRun(companyId: string, id: string): Promise<RoutineRun | null> {
    const [row] = await this.sql<RunRow[]>`SELECT * FROM routine_runs WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toRun(row) : null;
  }

  async listRuns(companyId: string, routineId?: string, limit = 50): Promise<RoutineRun[]> {
    const rows = routineId
      ? await this.sql<RunRow[]>`SELECT * FROM routine_runs WHERE company_id = ${companyId} AND routine_id = ${routineId} ORDER BY due_at DESC LIMIT ${limit}`
      : await this.sql<RunRow[]>`SELECT * FROM routine_runs WHERE company_id = ${companyId} ORDER BY due_at DESC LIMIT ${limit}`;
    return rows.map(toRun);
  }

  /** The scheduler took the run: it is running in this session. Only a claimed run can start. */
  async startRun(id: string, sessionId: string): Promise<RoutineRun | null> {
    const [row] = await this.sql<
      RunRow[]
    >`UPDATE routine_runs SET status = 'running', session_id = ${sessionId}, started_at = now() WHERE id = ${id} AND status = 'claimed' RETURNING *`;
    if (row) await this.sql`UPDATE routines SET last_run_at = now() WHERE id = ${row.routine_id}`;
    return row ? toRun(row) : null;
  }

  /** The scheduler turned the run into a task: it is running as that task until the task closes. */
  async startRunAsTask(id: string, taskId: string): Promise<RoutineRun | null> {
    const [row] = await this.sql<RunRow[]>`UPDATE routine_runs SET status = 'running', task_id = ${taskId}, started_at = now() WHERE id = ${id} AND status = 'claimed' RETURNING *`;
    if (row) await this.sql`UPDATE routines SET last_run_at = now() WHERE id = ${row.routine_id}`;
    return row ? toRun(row) : null;
  }

  /** The run of a task-mode routine, if the task is one. */
  async runOfTask(taskId: string): Promise<{ routine: Routine; run: RoutineRun } | null> {
    const [run] = await this.sql<RunRow[]>`SELECT * FROM routine_runs WHERE task_id = ${taskId}`;
    if (!run) return null;
    const routine = await this.get(run.company_id, run.routine_id);
    return routine ? { routine, run: toRun(run) } : null;
  }

  async finishRun(id: string, outcome: { status: "done" | "failed" | "interrupted"; result?: string | null; error?: string | null }): Promise<RoutineRun | null> {
    const [row] = await this.sql<
      RunRow[]
    >`UPDATE routine_runs SET status = ${outcome.status}, result = ${outcome.result ?? null}, error = ${outcome.error ?? null}, finished_at = now() WHERE id = ${id} RETURNING *`;
    return row ? toRun(row) : null;
  }

  /** After a restart: session runs left running are interrupted, never re-run (at most once). Task runs survive: the task itself is resumed by the scheduler. */
  async markStaleRunsInterrupted(): Promise<number> {
    const rows = await this.sql<
      { id: string }[]
    >`UPDATE routine_runs SET status = 'interrupted', error = 'the server restarted during the run', finished_at = now() WHERE status = 'running' AND task_id IS NULL RETURNING id`;
    return rows.length;
  }

  /** The routine a session belongs to, if it is a routine session. */
  async routineOfSession(sessionId: string): Promise<{ routine: Routine; run: RoutineRun } | null> {
    const [run] = await this.sql<RunRow[]>`SELECT * FROM routine_runs WHERE session_id = ${sessionId}`;
    if (!run) return null;
    const routine = await this.get(run.company_id, run.routine_id);
    return routine ? { routine, run: toRun(run) } : null;
  }
}
