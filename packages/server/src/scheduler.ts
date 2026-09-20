/**
 * The scheduler turns wake-ups into work. Every tick it frees abandoned
 * leases, requeues wake-ups left behind by a crash, then claims due wake-ups
 * (at most once each) and runs them: open or reuse the task session, take
 * the task with an atomic checkout, run a turn while a heartbeat keeps the
 * lease, and give the task back according to how the turn ended.
 */

import path from "node:path";
import type { EventBus } from "@opifer/core";
import type { AgentRuntime, RuntimeEvent, SessionRecord } from "@opifer/runtime";
import { TASK_GUIDE, describeTask, type Routine, type RoutineRun, type RoutineService, type Task, type Wakeup, type WorkService } from "@opifer/work";
import type { Sql } from "postgres";

export interface SchedulerOptions {
  sql: Sql;
  work: WorkService;
  runtime: AgentRuntime;
  bus: EventBus;
  workRoot: string;
  /** Routines: claimed every tick, run in their own session. */
  routines?: RoutineService;
  /** The full text of a skill for a routine's context, by name (learning is optional). */
  skillText?: (companyId: string, agentId: string, name: string) => Promise<string | null>;
  /** Delivers a finished routine run to its channels. */
  deliver?: (routine: Routine, run: RoutineRun, text: string) => Promise<void>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  tickMs?: number;
  concurrency?: number;
  /** Wake-ups left "running" longer than this are requeued. */
  staleWakeupMs?: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Map<string, Promise<void>>();
  private ticking = false;
  private stopped = false;
  private readonly tickMs: number;
  private readonly concurrency: number;
  private readonly staleWakeupMs: number;

  constructor(private readonly o: SchedulerOptions) {
    this.tickMs = o.tickMs ?? 2000;
    this.concurrency = o.concurrency ?? 3;
    this.staleWakeupMs = o.staleWakeupMs ?? 10 * 60_000;
  }

  /** Where finished routine runs go (the channel hub). */
  deliverTo(deliver: NonNullable<SchedulerOptions["deliver"]>): void {
    this.o.deliver = deliver;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running.values()]);
  }

  /** One pass: housekeeping, then as many claims as the concurrency allows. */
  async tick(): Promise<number> {
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;
    let started = 0;
    try {
      await this.o.work.requeueStaleWakeups(this.staleWakeupMs);
      if (this.o.routines) {
        const due = await this.o.routines.claimDue();
        for (const run of due.claimed) this.o.bus.publish("routine.due", run.companyId, { routineId: run.routineId, runId: run.id, dueAt: run.dueAt.toISOString() });
      }
      const freed = await this.o.work.releaseExpiredLeases();
      for (const task of freed) this.o.bus.publish("task.updated", task.companyId, { taskId: task.id, status: task.status, reason: "lease_expired" });
      while (this.running.size < this.concurrency) {
        const wakeup = await this.o.work.claimWakeup();
        if (!wakeup) break;
        started++;
        const job = this.handle(wakeup)
          .catch((error) => {
            this.o.log?.error({ err: error, wakeup: wakeup.id }, "wake-up failed");
            return this.o.work.finishWakeup(wakeup.id, "failed", error instanceof Error ? error.message : String(error));
          })
          .finally(() => this.running.delete(wakeup.id));
        this.running.set(wakeup.id, job);
      }
    } catch (error) {
      this.o.log?.error({ err: error }, "scheduler tick failed");
    } finally {
      this.ticking = false;
    }
    return started;
  }

  /** Waits for the jobs in flight (tests). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  private async handle(wakeup: Wakeup): Promise<void> {
    const { work, runtime, sql } = this.o;
    if (wakeup.reason === "routine") return this.handleRoutine(wakeup);
    if (!wakeup.taskId) {
      await work.finishWakeup(wakeup.id, "skipped", "no task");
      return;
    }
    const task = await work.getTask(wakeup.companyId, wakeup.taskId);
    if (!task) return work.finishWakeup(wakeup.id, "skipped", "task not found");
    const [agent] = await sql<
      { id: string; name: string; status: string }[]
    >`SELECT id, name, status FROM agents WHERE id = ${wakeup.agentId} AND company_id = ${wakeup.companyId}`;
    if (!agent) return work.finishWakeup(wakeup.id, "skipped", "agent not found");
    if (agent.status !== "active") return work.finishWakeup(wakeup.id, "skipped", `agent is ${agent.status}`);

    const session = await this.sessionFor(task, agent.id);
    const text = await this.brief(wakeup, task, agent.name);

    // A turn already running on this session: the message reaches the agent in the next tool result.
    if (runtime.isRunning(session.id)) {
      if (text) runtime.inject(session.id, text);
      return work.finishWakeup(wakeup.id, "done", "injected into the running turn");
    }

    let holding = false;
    if (task.status === "todo" || (task.status === "in_progress" && task.leaseExpiresAt && task.leaseExpiresAt < new Date())) {
      if (task.assigneeAgentId !== agent.id) return work.finishWakeup(wakeup.id, "skipped", "not the assignee");
      const outcome = await work.checkout(wakeup.companyId, task.id, { agentId: agent.id, sessionId: session.id });
      if (!outcome.ok) return work.finishWakeup(wakeup.id, "skipped", `checkout: ${outcome.reason}`);
      holding = true;
      this.o.bus.publish("task.updated", task.companyId, { taskId: task.id, status: "in_progress", agentId: agent.id, sessionId: session.id });
    } else if (task.status === "in_progress" && task.leaseSessionId === session.id) {
      if (task.leaseExpiresAt === null && wakeup.reason !== "decision") {
        // Waiting for a person's decision: the message is delivered once the work resumes.
        if (wakeup.attempts > 500) return work.finishWakeup(wakeup.id, "skipped", "waited too long for a decision");
        return work.deferWakeup(wakeup.id, 30_000, "waiting for a decision");
      }
      // Suspended for a decision, or still ours: resume the lease.
      holding = (await work.resumeLease(task.id, { sessionId: session.id })) || (await work.heartbeat(task.id, { sessionId: session.id }));
      if (!holding) return work.finishWakeup(wakeup.id, "skipped", "lease belongs to another session");
    } else if (task.status === "in_progress") {
      return work.finishWakeup(wakeup.id, "skipped", "task is being worked on elsewhere");
    } else if (wakeup.reason !== "mention") {
      return work.finishWakeup(wakeup.id, "skipped", `task is ${task.status}`);
    }
    if (wakeup.reason === "decision" && !holding) return work.finishWakeup(wakeup.id, "skipped", "nothing to resume");

    const heartbeat = holding
      ? setInterval(
          () => {
            void work.heartbeat(task.id, { sessionId: session.id }).then((ok) => {
              if (!ok) this.o.log?.warn({ taskId: task.id }, "lost the task lease during the turn");
            });
          },
          Math.max(1000, Math.floor(work.leaseMs / 3)),
        )
      : null;
    heartbeat?.unref();

    let stopReason = "error";
    let failed: string | null = null;
    let lastText = "";
    try {
      const result = await runtime.runTurn({
        sessionId: session.id,
        ...(text && wakeup.reason !== "decision" ? { text } : {}),
        onEvent: (event: RuntimeEvent) => this.o.bus.publish("session.event", task.companyId, { sessionId: session.id, runId: event.type === "done" ? event.run.id : null, event }),
      });
      stopReason = result.stopReason;
      lastText = result.assistantText;
      if (result.run.status === "failed") failed = result.run.error ?? "run failed";
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    await this.settle(task, session, agent, stopReason, failed, lastText, holding);
    await work.finishWakeup(wakeup.id, failed ? "failed" : "done", failed);
  }

  /**
   * A routine run: its own session, the prompt as the message, the skills
   * in the context; stopped for inactivity, never for duration. The run row
   * was claimed at most once; a session that fails or is interrupted is
   * recorded, not retried.
   */
  private async handleRoutine(wakeup: Wakeup): Promise<void> {
    const { work, runtime, sql, routines } = this.o;
    const runId = typeof wakeup.payload["runId"] === "string" ? wakeup.payload["runId"] : null;
    if (!routines || !runId) return work.finishWakeup(wakeup.id, "skipped", "routines are not configured");
    const run = await routines.getRun(wakeup.companyId, runId);
    if (!run) return work.finishWakeup(wakeup.id, "skipped", "run not found");
    if (run.status !== "claimed") return work.finishWakeup(wakeup.id, "skipped", `run is ${run.status}`);
    const routine = await routines.get(wakeup.companyId, run.routineId);
    if (!routine || !routine.enabled) {
      await routines.finishRun(run.id, { status: "failed", error: "routine disabled or gone" });
      return work.finishWakeup(wakeup.id, "skipped", "routine disabled or gone");
    }
    const [agent] = await sql<
      { id: string; name: string; status: string }[]
    >`SELECT id, name, status FROM agents WHERE id = ${routine.agentId} AND company_id = ${wakeup.companyId}`;
    if (!agent || agent.status !== "active") {
      await routines.finishRun(run.id, { status: "failed", error: agent ? `agent is ${agent.status}` : "agent not found" });
      return work.finishWakeup(wakeup.id, "skipped", "agent unavailable");
    }
    const skills: string[] = [];
    for (const name of routine.skills) {
      const text = await this.o.skillText?.(wakeup.companyId, agent.id, name);
      if (text) skills.push(text);
    }
    const context = [
      `This is a run of the routine "${routine.name}" (${routine.scheduleKind === "interval" ? `every ${routine.schedule} seconds` : routine.scheduleKind === "cron" ? `cron ${routine.schedule}` : "once"}), due ${run.dueAt.toISOString()}. Do the job described in the message, then answer with the result: what you did, what you found, what needs a person. Your last answer is delivered as the outcome of this run.`,
      ...skills.map((text) => `Skill to follow:\n${text}`),
    ].join("\n\n");
    const session = await runtime.startSession({
      companyId: wakeup.companyId,
      agentId: agent.id,
      kind: "routine",
      title: `${routine.name} · ${run.dueAt.toISOString().slice(0, 16).replace("T", " ")}`,
      workdir: path.join(this.o.workRoot, `routine-${routine.id}`),
      taskContext: context,
      ...(routine.model ? { model: routine.model } : {}),
    });
    const started = await routines.startRun(run.id, session.id);
    if (!started) return work.finishWakeup(wakeup.id, "skipped", "run taken by another scheduler");
    this.o.bus.publish("routine.started", wakeup.companyId, { routineId: routine.id, runId: run.id, sessionId: session.id });

    // Idle stop: the run is interrupted after idleTimeoutSeconds without any event, never for its duration.
    const controller = new AbortController();
    let idle: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), routine.idleTimeoutSeconds * 1000);
      idle.unref();
    };
    touch();
    let text = "";
    let failed: string | null = null;
    let interrupted = false;
    try {
      const result = await runtime.runTurn({
        sessionId: session.id,
        text: routine.prompt,
        signal: controller.signal,
        onEvent: (event: RuntimeEvent) => {
          touch();
          this.o.bus.publish("session.event", wakeup.companyId, { sessionId: session.id, runId: event.type === "done" ? event.run.id : null, event });
        },
      });
      text = result.assistantText;
      if (result.run.status === "failed") failed = result.run.error ?? "run failed";
      if (result.stopReason === "interrupted") interrupted = true;
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      if (idle) clearTimeout(idle);
    }
    const status = failed ? "failed" : interrupted ? "interrupted" : "done";
    await routines.finishRun(run.id, { status, result: text || null, error: failed ?? (interrupted ? `stopped after ${routine.idleTimeoutSeconds} seconds of inactivity` : null) });
    this.o.bus.publish("routine.finished", wakeup.companyId, { routineId: routine.id, runId: run.id, status, preview: text.slice(0, 200) });
    if (status === "done" && this.o.deliver) {
      try {
        await this.o.deliver(routine, { ...run, sessionId: session.id, status, result: text }, text);
      } catch (error) {
        this.o.log?.warn({ err: error, routineId: routine.id }, "routine delivery failed");
      }
    }
    await work.finishWakeup(wakeup.id, failed ? "failed" : "done", failed);
  }

  /** What happens to the task after the turn, by how the turn ended. */
  private async settle(
    task: Task,
    session: SessionRecord,
    agent: { id: string; name: string },
    stopReason: string,
    failed: string | null,
    lastText: string,
    holding: boolean,
  ): Promise<void> {
    const { work } = this.o;
    const current = await work.getTask(task.companyId, task.id);
    if (!current) return;
    const publish = (status: string, reason: string) => this.o.bus.publish("task.updated", task.companyId, { taskId: task.id, status, agentId: agent.id, reason });
    if (current.status !== "in_progress" || current.leaseSessionId !== session.id) {
      // Delivered, blocked, or taken elsewhere: the tools already moved the task.
      publish(current.status, stopReason);
      return;
    }
    if (!holding) return;
    const system = { kind: "system" as const };
    if (failed) {
      const released = await work.release(task.companyId, task.id, { kind: "failed", reason: failed }, system);
      await work.comment(task.companyId, task.id, system, `${agent.name}'s attempt failed: ${failed}`);
      publish(released.status, "failed");
      return;
    }
    switch (stopReason) {
      case "approval_pending":
      case "budget_exhausted":
        await work.suspendLease(task.id, { sessionId: session.id }, stopReason);
        publish("in_progress", stopReason);
        return;
      case "interrupted":
        publish((await work.release(task.companyId, task.id, { kind: "interrupted" }, system)).status, "interrupted");
        return;
      case "clarification_requested": {
        const released = await work.release(task.companyId, task.id, { kind: "paused", reason: "question" }, system);
        await work.comment(task.companyId, task.id, system, `${agent.name} has a question: ${lastText.trim().slice(0, 1000) || "(see the conversation)"}`);
        publish(released.status, "question");
        return;
      }
      default: {
        // The agent stopped talking without delivering or blocking: the task waits for a person.
        const released = await work.release(task.companyId, task.id, { kind: "paused", reason: stopReason }, system);
        await work.comment(
          task.companyId,
          task.id,
          system,
          `${agent.name} stopped without delivering (${stopReason})${lastText.trim() ? `: ${lastText.trim().slice(0, 1000)}` : ""}. Comment to wake them up again.`,
        );
        publish(released.status, stopReason);
      }
    }
  }

  /** The task's session for this agent: reused across wake-ups, created with the why chain in the prompt. */
  private async sessionFor(task: Task, agentId: string): Promise<SessionRecord> {
    const { runtime, work, sql } = this.o;
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM sessions WHERE task_id = ${task.id} AND agent_id = ${agentId} AND status = 'active' ORDER BY created_at DESC LIMIT 1
    `;
    if (existing) {
      const session = await runtime.store.getSession(existing.id);
      if (session) return session;
    }
    const why = await work.whyChain(task.companyId, task);
    const workdir = why.project?.workdir ?? path.join(this.o.workRoot, `task-${task.id}`);
    return runtime.startSession({
      companyId: task.companyId,
      agentId,
      kind: "task",
      taskId: task.id,
      title: task.title,
      workdir,
      taskContext: `${describeTask(task, why)}\n\n${TASK_GUIDE}`,
    });
  }

  /** The message that opens the turn, by reason. */
  private async brief(wakeup: Wakeup, task: Task, agentName: string): Promise<string | null> {
    const { work, sql } = this.o;
    switch (wakeup.reason) {
      case "assignment": {
        const changes = typeof wakeup.payload["changesRequested"] === "string" ? (wakeup.payload["changesRequested"] as string) : null;
        return changes
          ? `The reviewer sent the task "${task.title}" back with changes requested: ${changes}\nRead the task with task_status, make the changes, and deliver again with task_deliver.`
          : `You have been assigned the task "${task.title}". Read it with task_status, do the work, and when the result is ready deliver it with task_deliver. If you cannot continue, use task_block.`;
      }
      case "mention": {
        const commentId = typeof wakeup.payload["commentId"] === "string" ? (wakeup.payload["commentId"] as string) : null;
        const [c] = commentId
          ? await sql<{ author_kind: string; author_id: string | null; body: string }[]>`SELECT author_kind, author_id, body FROM task_comments WHERE id = ${commentId}`
          : [];
        let author = "a person";
        if (c?.author_kind === "agent" && c.author_id) {
          const [a] = await sql<{ name: string }[]>`SELECT name FROM agents WHERE id = ${c.author_id}`;
          author = a?.name ?? "an agent";
        }
        if (wakeup.payload["review"])
          return `The task "${task.title}" was delivered for your review. Read it with task_status, check the result against the acceptance criterion, and comment your verdict.`;
        return c
          ? `New comment on the task "${task.title}" from ${author}: ${c.body}\nAnswer with task_comment, or continue the work.`
          : `Someone mentioned you on the task "${task.title}". Read it with task_status.`;
      }
      case "retry":
        return `Your previous attempt on "${task.title}" was interrupted. Check the state with task_status and the working folder, then continue; do not repeat what is already done.`;
      case "decision":
        return null;
      default:
        return `Wake-up (${wakeup.reason}) for ${agentName}: check the task "${task.title}" with task_status.`;
    }
  }
}
