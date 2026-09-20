/**
 * Work: goals, projects and tasks. The checkout to "in progress" is one
 * atomic statement, the lease is kept by heartbeats, an abandoned lease
 * frees the task, a task closes only with a verifiable result, and every
 * change leaves an audit row. Wake-ups tell agents why they should act.
 */

import type { Sql, TransactionSql } from "postgres";
import { audit } from "@opifer/db";
import type { Actor, CheckoutOutcome, Goal, Project, Task, TaskComment, TaskPriority, TaskResult, TaskStatus, Wakeup, WakeupReason, WhyChain, WorkProduct, WorkProductKind } from "./types.js";

export interface WorkServiceOptions {
  /** How long a checkout lasts without a heartbeat. */
  leaseMs?: number;
  /** Consecutive failed attempts after which a task blocks and asks for help. */
  failureThreshold?: number;
}

export interface WorkHooks {
  /** A task reached done (success) or was cancelled (failure). Runs after the transaction; errors are swallowed. */
  onTaskClosed?(task: Task, outcome: "success" | "failure"): Promise<void>;
}

type Db = Sql | TransactionSql;

interface GoalRow {
  id: string;
  company_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  measure: string;
  status: Goal["status"];
  due_at: Date | null;
  created_at: Date;
}

interface ProjectRow {
  id: string;
  company_id: string;
  goal_id: string | null;
  name: string;
  description: string;
  status: Project["status"];
  workdir: string | null;
  created_at: Date;
}

interface TaskRow {
  id: string;
  company_id: string;
  project_id: string | null;
  goal_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  acceptance: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  reviewer_agent_id: string | null;
  created_by_kind: Actor["kind"];
  created_by_id: string | null;
  due_at: Date | null;
  lease_run_id: string | null;
  lease_session_id: string | null;
  lease_expires_at: Date | null;
  checked_out_at: Date | null;
  failures: number;
  blocked_reason: string | null;
  result: TaskResult | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CommentRow {
  id: string;
  company_id: string;
  task_id: string;
  author_kind: Actor["kind"];
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: Date;
}

interface ProductRow {
  id: string;
  company_id: string;
  task_id: string;
  run_id: string | null;
  kind: WorkProductKind;
  title: string;
  ref: string;
  summary: string;
  created_by_kind: Actor["kind"];
  created_by_id: string | null;
  created_at: Date;
}

interface WakeupRow {
  id: string;
  company_id: string;
  agent_id: string;
  reason: WakeupReason;
  task_id: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: Wakeup["status"];
  scheduled_at: Date;
  claimed_at: Date | null;
  finished_at: Date | null;
  attempts: number;
  error: string | null;
}

const toGoal = (r: GoalRow): Goal => ({ id: r.id, companyId: r.company_id, parentId: r.parent_id, title: r.title, description: r.description, measure: r.measure, status: r.status, dueAt: r.due_at, createdAt: r.created_at });
const toProject = (r: ProjectRow): Project => ({ id: r.id, companyId: r.company_id, goalId: r.goal_id, name: r.name, description: r.description, status: r.status, workdir: r.workdir, createdAt: r.created_at });
const toTask = (r: TaskRow): Task => ({
  id: r.id,
  companyId: r.company_id,
  projectId: r.project_id,
  goalId: r.goal_id,
  parentId: r.parent_id,
  title: r.title,
  description: r.description,
  acceptance: r.acceptance,
  status: r.status,
  priority: r.priority,
  assigneeAgentId: r.assignee_agent_id,
  assigneeUserId: r.assignee_user_id,
  reviewerAgentId: r.reviewer_agent_id,
  createdByKind: r.created_by_kind,
  createdById: r.created_by_id,
  dueAt: r.due_at,
  leaseRunId: r.lease_run_id,
  leaseSessionId: r.lease_session_id,
  leaseExpiresAt: r.lease_expires_at,
  checkedOutAt: r.checked_out_at,
  failures: r.failures,
  blockedReason: r.blocked_reason,
  result: r.result,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toComment = (r: CommentRow): TaskComment => ({ id: r.id, companyId: r.company_id, taskId: r.task_id, authorKind: r.author_kind, authorId: r.author_id, body: r.body, mentions: r.mentions ?? [], createdAt: r.created_at });
const toProduct = (r: ProductRow): WorkProduct => ({ id: r.id, companyId: r.company_id, taskId: r.task_id, runId: r.run_id, kind: r.kind, title: r.title, ref: r.ref, summary: r.summary, createdByKind: r.created_by_kind, createdById: r.created_by_id, createdAt: r.created_at });
const toWakeup = (r: WakeupRow): Wakeup => ({ id: r.id, companyId: r.company_id, agentId: r.agent_id, reason: r.reason, taskId: r.task_id, payload: r.payload ?? {}, dedupeKey: r.dedupe_key, status: r.status, scheduledAt: r.scheduled_at, claimedAt: r.claimed_at, finishedAt: r.finished_at, attempts: r.attempts, error: r.error });

export class WorkError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "WorkError";
  }
}

export class WorkService {
  readonly leaseMs: number;
  readonly failureThreshold: number;

  hooks: WorkHooks = {};

  constructor(
    private readonly sql: Sql,
    options: WorkServiceOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.failureThreshold = options.failureThreshold ?? 2;
  }

  private async closed(task: Task, outcome: "success" | "failure"): Promise<void> {
    try {
      await this.hooks.onTaskClosed?.(task, outcome);
    } catch {
      // learning is best effort: a failed hook never undoes a closed task
    }
  }

  // --- Goals ---------------------------------------------------------------

  async createGoal(input: { companyId: string; title: string; description?: string; measure?: string; parentId?: string | null; dueAt?: Date | null }, actor: Actor): Promise<Goal> {
    const [row] = await this.sql<GoalRow[]>`
      INSERT INTO goals (company_id, parent_id, title, description, measure, due_at)
      VALUES (${input.companyId}, ${input.parentId ?? null}, ${input.title}, ${input.description ?? ""}, ${input.measure ?? ""}, ${input.dueAt ?? null}) RETURNING *
    `;
    const goal = toGoal(row!);
    await audit(this.sql, { companyId: input.companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "goal.created", subjectKind: "goal", subjectId: goal.id, after: { title: goal.title, parentId: goal.parentId } });
    return goal;
  }

  async updateGoal(companyId: string, id: string, patch: Partial<Pick<Goal, "title" | "description" | "measure" | "status" | "parentId" | "dueAt">>, actor: Actor): Promise<Goal> {
    const [before] = await this.sql<GoalRow[]>`SELECT * FROM goals WHERE id = ${id} AND company_id = ${companyId}`;
    if (!before) throw new WorkError("not_found", "goal not found");
    const next = { ...toGoal(before), ...stripUndefined(patch) };
    const [row] = await this.sql<GoalRow[]>`
      UPDATE goals SET title = ${next.title}, description = ${next.description}, measure = ${next.measure}, status = ${next.status}, parent_id = ${next.parentId}, due_at = ${next.dueAt}
      WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "goal.updated", subjectKind: "goal", subjectId: id, before: { status: before.status, title: before.title }, after: { status: next.status, title: next.title } });
    return toGoal(row!);
  }

  async listGoals(companyId: string): Promise<Goal[]> {
    const rows = await this.sql<GoalRow[]>`SELECT * FROM goals WHERE company_id = ${companyId} ORDER BY created_at`;
    return rows.map(toGoal);
  }

  /** Root first, the given goal last. */
  async goalChain(goalId: string, db: Db = this.sql): Promise<Goal[]> {
    const rows = await db<(GoalRow & { depth: number })[]>`
      WITH RECURSIVE chain AS (
        SELECT g.*, 0 AS depth FROM goals g WHERE g.id = ${goalId}
        UNION ALL
        SELECT g.*, c.depth + 1 FROM goals g JOIN chain c ON g.id = c.parent_id WHERE c.depth < 20
      )
      SELECT * FROM chain ORDER BY depth DESC
    `;
    return rows.map(toGoal);
  }

  // --- Projects ------------------------------------------------------------

  async createProject(input: { companyId: string; name: string; description?: string; goalId?: string | null; workdir?: string | null }, actor: Actor): Promise<Project> {
    const [row] = await this.sql<ProjectRow[]>`
      INSERT INTO projects (company_id, goal_id, name, description, workdir)
      VALUES (${input.companyId}, ${input.goalId ?? null}, ${input.name}, ${input.description ?? ""}, ${input.workdir ?? null}) RETURNING *
    `;
    const project = toProject(row!);
    await audit(this.sql, { companyId: input.companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "project.created", subjectKind: "project", subjectId: project.id, after: { name: project.name, goalId: project.goalId } });
    return project;
  }

  async updateProject(companyId: string, id: string, patch: Partial<Pick<Project, "name" | "description" | "status" | "goalId" | "workdir">>, actor: Actor): Promise<Project> {
    const [before] = await this.sql<ProjectRow[]>`SELECT * FROM projects WHERE id = ${id} AND company_id = ${companyId}`;
    if (!before) throw new WorkError("not_found", "project not found");
    const next = { ...toProject(before), ...stripUndefined(patch) };
    const [row] = await this.sql<ProjectRow[]>`
      UPDATE projects SET name = ${next.name}, description = ${next.description}, status = ${next.status}, goal_id = ${next.goalId}, workdir = ${next.workdir} WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "project.updated", subjectKind: "project", subjectId: id, before: { status: before.status, name: before.name }, after: { status: next.status, name: next.name } });
    return toProject(row!);
  }

  async listProjects(companyId: string): Promise<Project[]> {
    const rows = await this.sql<ProjectRow[]>`SELECT * FROM projects WHERE company_id = ${companyId} ORDER BY created_at`;
    return rows.map(toProject);
  }

  // --- Tasks ---------------------------------------------------------------

  async createTask(
    input: {
      companyId: string;
      title: string;
      description?: string;
      acceptance?: string;
      priority?: TaskPriority;
      projectId?: string | null;
      goalId?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      reviewerAgentId?: string | null;
      dueAt?: Date | null;
    },
    actor: Actor,
  ): Promise<Task> {
    if (!input.title.trim()) throw new WorkError("invalid_input", "a task needs a title");
    // A subtask inherits project and goal from its parent unless given.
    let projectId = input.projectId ?? null;
    let goalId = input.goalId ?? null;
    if (input.parentId) {
      const [parent] = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${input.parentId} AND company_id = ${input.companyId}`;
      if (!parent) throw new WorkError("not_found", "parent task not found");
      projectId = projectId ?? parent.project_id;
      goalId = goalId ?? parent.goal_id;
    }
    if (!goalId && projectId) {
      const [project] = await this.sql<ProjectRow[]>`SELECT * FROM projects WHERE id = ${projectId} AND company_id = ${input.companyId}`;
      goalId = project?.goal_id ?? null;
    }
    const task = await this.sql.begin(async (tx) => {
      const [row] = await tx<TaskRow[]>`
        INSERT INTO tasks (company_id, project_id, goal_id, parent_id, title, description, acceptance, priority, assignee_agent_id, assignee_user_id, reviewer_agent_id, created_by_kind, created_by_id, due_at)
        VALUES (
          ${input.companyId}, ${projectId}, ${goalId}, ${input.parentId ?? null}, ${input.title.trim()}, ${input.description ?? ""}, ${input.acceptance ?? ""}, ${input.priority ?? "normal"},
          ${input.assigneeAgentId ?? null}, ${input.assigneeUserId ?? null}, ${input.reviewerAgentId ?? null}, ${actor.kind}, ${actor.id ?? null}, ${input.dueAt ?? null}
        ) RETURNING *
      `;
      const task = toTask(row!);
      await audit(tx, { companyId: task.companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.created", subjectKind: "task", subjectId: task.id, taskId: task.id, after: { title: task.title, priority: task.priority, assigneeAgentId: task.assigneeAgentId, projectId: task.projectId, parentId: task.parentId } });
      if (task.assigneeAgentId) await this.wake(task.companyId, task.assigneeAgentId, "assignment", { taskId: task.id, dedupeKey: `assignment:${task.id}` }, tx);
      return task;
    });
    return task;
  }

  async getTask(companyId: string, id: string): Promise<Task | null> {
    const [row] = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toTask(row) : null;
  }

  async listTasks(companyId: string, filter: { status?: TaskStatus | TaskStatus[]; assigneeAgentId?: string; projectId?: string; parentId?: string | null; goalId?: string } = {}): Promise<Task[]> {
    const statuses = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
    const rows = await this.sql<TaskRow[]>`
      SELECT * FROM tasks WHERE company_id = ${companyId}
        ${statuses ? this.sql`AND status = ANY(${statuses})` : this.sql``}
        ${filter.assigneeAgentId ? this.sql`AND assignee_agent_id = ${filter.assigneeAgentId}` : this.sql``}
        ${filter.projectId ? this.sql`AND project_id = ${filter.projectId}` : this.sql``}
        ${filter.goalId ? this.sql`AND goal_id = ${filter.goalId}` : this.sql``}
        ${filter.parentId === undefined ? this.sql`` : filter.parentId === null ? this.sql`AND parent_id IS NULL` : this.sql`AND parent_id = ${filter.parentId}`}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at
    `;
    return rows.map(toTask);
  }

  async updateTask(companyId: string, id: string, patch: Partial<Pick<Task, "title" | "description" | "acceptance" | "priority" | "projectId" | "goalId" | "dueAt" | "reviewerAgentId">>, actor: Actor): Promise<Task> {
    const [before] = await this.sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId}`;
    if (!before) throw new WorkError("not_found", "task not found");
    const current = toTask(before);
    const next = { ...current, ...stripUndefined(patch) };
    const [row] = await this.sql<TaskRow[]>`
      UPDATE tasks SET title = ${next.title}, description = ${next.description}, acceptance = ${next.acceptance}, priority = ${next.priority}, project_id = ${next.projectId}, goal_id = ${next.goalId}, due_at = ${next.dueAt}, reviewer_agent_id = ${next.reviewerAgentId}
      WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.updated", subjectKind: "task", subjectId: id, taskId: id, before: { title: current.title, priority: current.priority }, after: { title: next.title, priority: next.priority } });
    return toTask(row!);
  }

  /** Assigns the task to an agent (wakes it) or a person; clears the other assignee. */
  async assign(companyId: string, id: string, assignee: { agentId?: string | null; userId?: string | null }, actor: Actor): Promise<Task> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (before.status === "in_progress") throw new WorkError("invalid_transition", "a task in progress cannot be reassigned: release it first");
      const agentId = assignee.agentId ?? null;
      const userId = agentId ? null : (assignee.userId ?? null);
      const [row] = await tx<TaskRow[]>`UPDATE tasks SET assignee_agent_id = ${agentId}, assignee_user_id = ${userId} WHERE id = ${id} RETURNING *`;
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.assigned", subjectKind: "task", subjectId: id, taskId: id, before: { agentId: before.assignee_agent_id, userId: before.assignee_user_id }, after: { agentId, userId } });
      if (agentId && (before.status === "todo" || before.status === "blocked")) await this.wake(companyId, agentId, "assignment", { taskId: id, dedupeKey: `assignment:${id}` }, tx);
      return toTask(row!);
    });
  }

  /**
   * Atomic checkout: one statement moves the task to in_progress and binds it
   * to the run. It succeeds only for the assignee, only when the task is
   * available (todo, or in_progress with an expired lease). A second caller
   * gets "taken".
   */
  async checkout(companyId: string, id: string, holder: { agentId: string; sessionId?: string | null; runId?: string | null }, now: Date = new Date()): Promise<CheckoutOutcome> {
    const expires = new Date(now.getTime() + this.leaseMs);
    const outcome = await this.sql.begin(async (tx): Promise<CheckoutOutcome> => {
      const [row] = await tx<TaskRow[]>`
        UPDATE tasks SET
          status = 'in_progress',
          lease_run_id = ${holder.runId ?? null},
          lease_session_id = ${holder.sessionId ?? null},
          lease_expires_at = ${expires},
          checked_out_at = ${now},
          started_at = coalesce(started_at, ${now})
        WHERE id = ${id} AND company_id = ${companyId}
          AND assignee_agent_id = ${holder.agentId}
          AND (status = 'todo' OR (status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ${now}))
        RETURNING *
      `;
      if (row) {
        await audit(tx, { companyId, actorKind: "agent", actorId: holder.agentId, action: "task.checked_out", subjectKind: "task", subjectId: id, taskId: id, after: { runId: holder.runId ?? null, sessionId: holder.sessionId ?? null, leaseExpiresAt: expires.toISOString() } });
        return { ok: true, task: toTask(row) };
      }
      const [existing] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId}`;
      if (!existing) return { ok: false, reason: "not_found" };
      if (existing.assignee_agent_id !== holder.agentId) return { ok: false, reason: "not_assignee" };
      if (existing.status === "in_progress") return { ok: false, reason: "taken" };
      return { ok: false, reason: "not_available" };
    });
    return outcome;
  }

  /** Renews the lease of a running checkout. False when the lease is not ours any more. */
  async heartbeat(id: string, holder: { runId?: string | null; sessionId?: string | null }, now: Date = new Date()): Promise<boolean> {
    const expires = new Date(now.getTime() + this.leaseMs);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks SET lease_expires_at = ${expires}
      WHERE id = ${id} AND status = 'in_progress'
        AND (${holder.runId ?? null}::uuid IS NOT NULL AND lease_run_id = ${holder.runId ?? null} OR ${holder.sessionId ?? null}::uuid IS NOT NULL AND lease_session_id = ${holder.sessionId ?? null})
      RETURNING id
    `;
    return rows.length > 0;
  }

  /** The holder waits for a decision (approval, budget): the lease stops expiring until the work resumes. */
  async suspendLease(id: string, holder: { sessionId: string }, reason: string): Promise<boolean> {
    const rows = await this.sql<{ id: string; company_id: string }[]>`
      UPDATE tasks SET lease_expires_at = NULL, lease_run_id = NULL WHERE id = ${id} AND status = 'in_progress' AND lease_session_id = ${holder.sessionId} RETURNING id, company_id
    `;
    if (rows.length === 0) return false;
    await audit(this.sql, { companyId: rows[0]!.company_id, actorKind: "system", action: "task.suspended", subjectKind: "task", subjectId: id, taskId: id, after: { reason, sessionId: holder.sessionId } });
    return true;
  }

  /** Takes a suspended lease up again, for the same session. */
  async resumeLease(id: string, holder: { sessionId: string; runId?: string | null }, now: Date = new Date()): Promise<boolean> {
    const expires = new Date(now.getTime() + this.leaseMs);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks SET lease_expires_at = ${expires}, lease_run_id = ${holder.runId ?? null}
      WHERE id = ${id} AND status = 'in_progress' AND lease_session_id = ${holder.sessionId} AND lease_expires_at IS NULL RETURNING id
    `;
    return rows.length > 0;
  }

  /** Gives the task back: paused or interrupted work keeps the count, a failure adds to it; past the threshold the task blocks. */
  async release(companyId: string, id: string, outcome: { kind: "paused" | "interrupted" | "failed"; reason?: string | null; runId?: string | null }, actor: Actor): Promise<Task> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (before.status !== "in_progress") throw new WorkError("invalid_transition", `task is ${before.status}, not in progress`);
      const failures = outcome.kind === "failed" ? before.failures + 1 : before.failures;
      const blocked = failures >= this.failureThreshold;
      const [row] = await tx<TaskRow[]>`
        UPDATE tasks SET status = ${blocked ? "blocked" : "todo"}, failures = ${failures}, blocked_reason = ${blocked ? `${failures} consecutive failed attempts${outcome.reason ? `: ${outcome.reason}` : ""}` : null},
          lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL
        WHERE id = ${id} RETURNING *
      `;
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: blocked ? "task.blocked" : "task.released", subjectKind: "task", subjectId: id, taskId: id, after: { outcome: outcome.kind, reason: outcome.reason ?? null, failures, runId: outcome.runId ?? null } });
      return toTask(row!);
    });
  }

  /** Abandoned leases go back to todo; each expiry counts as a failed attempt. Returns the freed tasks. */
  async releaseExpiredLeases(now: Date = new Date()): Promise<Task[]> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<TaskRow[]>`
        SELECT * FROM tasks WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ${now} FOR UPDATE SKIP LOCKED
      `;
      const freed: Task[] = [];
      for (const before of rows) {
        const failures = before.failures + 1;
        const blocked = failures >= this.failureThreshold;
        const [row] = await tx<TaskRow[]>`
          UPDATE tasks SET status = ${blocked ? "blocked" : "todo"}, failures = ${failures}, blocked_reason = ${blocked ? `${failures} abandoned or failed attempts` : null},
            lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL
          WHERE id = ${before.id} RETURNING *
        `;
        await audit(tx, { companyId: before.company_id, actorKind: "system", action: blocked ? "task.blocked" : "task.lease_expired", subjectKind: "task", subjectId: before.id, taskId: before.id, after: { failures, leaseRunId: before.lease_run_id, expiredAt: before.lease_expires_at?.toISOString() ?? null } });
        if (!blocked && before.assignee_agent_id) await this.wake(before.company_id, before.assignee_agent_id, "retry", { taskId: before.id, dedupeKey: `retry:${before.id}`, scheduledAt: new Date(now.getTime() + 30_000) }, tx);
        freed.push(toTask(row!));
      }
      return freed;
    });
  }

  /** The holder asks a person (or the reviewer agent) to verify the result. */
  async requestReview(companyId: string, id: string, result: TaskResult, actor: Actor, runId?: string | null): Promise<Task> {
    if (!result.summary?.trim()) throw new WorkError("invalid_input", "a review needs a summary of the result");
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (before.status !== "in_progress") throw new WorkError("invalid_transition", `task is ${before.status}, not in progress`);
      const [row] = await tx<TaskRow[]>`
        UPDATE tasks SET status = 'in_review', result = ${result as never}::jsonb, lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL WHERE id = ${id} RETURNING *
      `;
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.review_requested", subjectKind: "task", subjectId: id, taskId: id, after: { summary: result.summary, runId: runId ?? null } });
      if (before.reviewer_agent_id) await this.wake(companyId, before.reviewer_agent_id, "mention", { taskId: id, dedupeKey: `review:${id}`, payload: { review: true } }, tx);
      return toTask(row!);
    });
  }

  /** Closes the task with a verifiable result (the database refuses a done task without one). */
  async complete(companyId: string, id: string, result: TaskResult, actor: Actor, options: { runId?: string | null; from?: TaskStatus[] } = {}): Promise<Task> {
    if (!result.summary?.trim()) throw new WorkError("invalid_input", "done means verified: a result summary is required");
    const from = options.from ?? ["in_progress", "in_review"];
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (!from.includes(before.status)) throw new WorkError("invalid_transition", `task is ${before.status}`);
      const [open] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM tasks WHERE parent_id = ${id} AND status NOT IN ('done', 'cancelled')`;
      if (Number(open!.n) > 0) throw new WorkError("invalid_transition", `${open!.n} subtasks are still open: a parent closes when its children are verified`);
      const [row] = await tx<TaskRow[]>`
        UPDATE tasks SET status = 'done', result = ${result as never}::jsonb, finished_at = now(), failures = 0, blocked_reason = NULL,
          lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL WHERE id = ${id} RETURNING *
      `;
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.done", subjectKind: "task", subjectId: id, taskId: id, before: { status: before.status }, after: { summary: result.summary, verification: result.verification ?? null, runId: options.runId ?? null } });
      return toTask(row!);
    }).then(async (task) => {
      await this.closed(task, "success");
      return task;
    });
  }

  /** A reviewer sends the task back: it returns to todo with a comment, and the assignee wakes up. */
  async requestChanges(companyId: string, id: string, note: string, actor: Actor): Promise<Task> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (before.status !== "in_review") throw new WorkError("invalid_transition", `task is ${before.status}, not in review`);
      const [row] = await tx<TaskRow[]>`UPDATE tasks SET status = 'todo' WHERE id = ${id} RETURNING *`;
      await this.insertComment(tx, companyId, id, actor, `Changes requested: ${note}`, []);
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.changes_requested", subjectKind: "task", subjectId: id, taskId: id, after: { note } });
      if (before.assignee_agent_id) await this.wake(companyId, before.assignee_agent_id, "assignment", { taskId: id, dedupeKey: `assignment:${id}`, payload: { changesRequested: note } }, tx);
      return toTask(row!);
    });
  }

  async block(companyId: string, id: string, reason: string, actor: Actor): Promise<Task> {
    return this.transition(companyId, id, ["todo", "in_progress", "in_review"], "blocked", actor, "task.blocked", { reason }, (tx) => tx`UPDATE tasks SET status = 'blocked', blocked_reason = ${reason}, lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL WHERE id = ${id} RETURNING *`);
  }

  async unblock(companyId: string, id: string, actor: Actor): Promise<Task> {
    const task = await this.transition(companyId, id, ["blocked"], "todo", actor, "task.unblocked", {}, (tx) => tx`UPDATE tasks SET status = 'todo', blocked_reason = NULL, failures = 0 WHERE id = ${id} RETURNING *`);
    if (task.assigneeAgentId) await this.wake(companyId, task.assigneeAgentId, "assignment", { taskId: id, dedupeKey: `assignment:${id}` });
    return task;
  }

  async cancel(companyId: string, id: string, reason: string, actor: Actor): Promise<Task> {
    const task = await this.transition(companyId, id, ["todo", "in_progress", "in_review", "blocked"], "cancelled", actor, "task.cancelled", { reason }, (tx) => tx`UPDATE tasks SET status = 'cancelled', finished_at = now(), lease_run_id = NULL, lease_session_id = NULL, lease_expires_at = NULL WHERE id = ${id} RETURNING *`);
    await this.closed(task, "failure");
    return task;
  }

  private async transition(companyId: string, id: string, from: TaskStatus[], to: TaskStatus, actor: Actor, action: string, after: Record<string, unknown>, update: (tx: TransactionSql) => Promise<TaskRow[]>): Promise<Task> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new WorkError("not_found", "task not found");
      if (!from.includes(before.status)) throw new WorkError("invalid_transition", `task is ${before.status}, cannot become ${to}`);
      const [row] = await update(tx);
      await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action, subjectKind: "task", subjectId: id, taskId: id, before: { status: before.status }, after: { status: to, ...after } });
      return toTask(row!);
    });
  }

  /** Every task carries its why: mission → goals → project → parent tasks. */
  async whyChain(companyId: string, task: Task): Promise<WhyChain> {
    const [company] = await this.sql<{ name: string; mission: string | null }[]>`SELECT name, mission FROM companies WHERE id = ${companyId}`;
    const goals = task.goalId ? await this.goalChain(task.goalId) : [];
    const project = task.projectId ? ((await this.sql<ProjectRow[]>`SELECT * FROM projects WHERE id = ${task.projectId}`).map(toProject)[0] ?? null) : null;
    const parents = task.parentId
      ? await this.sql<{ id: string; title: string }[]>`
          WITH RECURSIVE up AS (
            SELECT t.id, t.title, t.parent_id, 0 AS depth FROM tasks t WHERE t.id = ${task.parentId}
            UNION ALL
            SELECT t.id, t.title, t.parent_id, u.depth + 1 FROM tasks t JOIN up u ON t.id = u.parent_id WHERE u.depth < 20
          )
          SELECT id, title FROM up ORDER BY depth DESC
        `
      : [];
    return { mission: company?.mission ?? null, companyName: company?.name ?? "", goals, project, parents: parents.map((p) => ({ id: p.id, title: p.title })) };
  }

  // --- Comments and results ------------------------------------------------

  /** A comment; "@Name" wakes the named agents, and a person's comment wakes the assignee. */
  async comment(companyId: string, taskId: string, actor: Actor, body: string): Promise<TaskComment> {
    if (!body.trim()) throw new WorkError("invalid_input", "an empty comment");
    return this.sql.begin(async (tx) => {
      const [task] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${taskId} AND company_id = ${companyId}`;
      if (!task) throw new WorkError("not_found", "task not found");
      const agents = await tx<{ id: string; name: string }[]>`SELECT id, name FROM agents WHERE company_id = ${companyId}`;
      const names = [...body.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!.toLowerCase());
      const mentioned = agents.filter((a) => names.includes(a.name.toLowerCase().replace(/\s+/g, "-")) || names.includes(a.name.toLowerCase())).map((a) => a.id);
      const comment = await this.insertComment(tx, companyId, taskId, actor, body, mentioned);
      const toWake = new Set(mentioned);
      if (actor.kind === "person" && task.assignee_agent_id && task.status !== "done" && task.status !== "cancelled") toWake.add(task.assignee_agent_id);
      for (const agentId of toWake) {
        if (actor.kind === "agent" && actor.id === agentId) continue;
        await this.wake(companyId, agentId, "mention", { taskId, dedupeKey: `mention:${taskId}:${agentId}`, payload: { commentId: comment.id } }, tx);
      }
      return comment;
    });
  }

  private async insertComment(tx: Db, companyId: string, taskId: string, actor: Actor, body: string, mentions: string[]): Promise<TaskComment> {
    const [row] = await tx<CommentRow[]>`
      INSERT INTO task_comments (company_id, task_id, author_kind, author_id, body, mentions)
      VALUES (${companyId}, ${taskId}, ${actor.kind}, ${actor.id ?? null}, ${body}, ${mentions as never}::jsonb) RETURNING *
    `;
    await audit(tx, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.commented", subjectKind: "task_comment", subjectId: row!.id, taskId, after: { taskId, mentions } });
    return toComment(row!);
  }

  async listComments(companyId: string, taskId: string): Promise<TaskComment[]> {
    const rows = await this.sql<CommentRow[]>`SELECT * FROM task_comments WHERE company_id = ${companyId} AND task_id = ${taskId} ORDER BY created_at`;
    return rows.map(toComment);
  }

  async addProduct(companyId: string, taskId: string, input: { kind: WorkProductKind; title: string; ref?: string; summary?: string; runId?: string | null }, actor: Actor): Promise<WorkProduct> {
    const [row] = await this.sql<ProductRow[]>`
      INSERT INTO work_products (company_id, task_id, run_id, kind, title, ref, summary, created_by_kind, created_by_id)
      VALUES (${companyId}, ${taskId}, ${input.runId ?? null}, ${input.kind}, ${input.title}, ${input.ref ?? ""}, ${input.summary ?? ""}, ${actor.kind}, ${actor.id ?? null}) RETURNING *
    `;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "task.product_added", subjectKind: "work_product", subjectId: row!.id, taskId, after: { kind: input.kind, title: input.title, ref: input.ref ?? "" } });
    return toProduct(row!);
  }

  async listProducts(companyId: string, taskId: string): Promise<WorkProduct[]> {
    const rows = await this.sql<ProductRow[]>`SELECT * FROM work_products WHERE company_id = ${companyId} AND task_id = ${taskId} ORDER BY created_at`;
    return rows.map(toProduct);
  }

  // --- Wake-ups ------------------------------------------------------------

  /** Queues a reason for an agent to act. A pending wake-up with the same dedupe key absorbs the new one. */
  async wake(companyId: string, agentId: string, reason: WakeupReason, options: { taskId?: string | null; payload?: Record<string, unknown>; dedupeKey?: string | null; scheduledAt?: Date } = {}, db: Db = this.sql): Promise<Wakeup | null> {
    const [row] = await db<WakeupRow[]>`
      INSERT INTO wakeups (company_id, agent_id, reason, task_id, payload, dedupe_key, scheduled_at)
      VALUES (${companyId}, ${agentId}, ${reason}, ${options.taskId ?? null}, ${(options.payload ?? {}) as never}::jsonb, ${options.dedupeKey ?? null}, ${options.scheduledAt ?? new Date()})
      ON CONFLICT (company_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING
      RETURNING *
    `;
    return row ? toWakeup(row) : null;
  }

  /** Claims the next due wake-up, at most once: concurrent claimers never get the same row. */
  async claimWakeup(now: Date = new Date()): Promise<Wakeup | null> {
    const [row] = await this.sql<WakeupRow[]>`
      UPDATE wakeups SET status = 'running', claimed_at = ${now}, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM wakeups WHERE status = 'pending' AND scheduled_at <= ${now}
        ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *
    `;
    return row ? toWakeup(row) : null;
  }

  /** Puts a claimed wake-up back in the queue for later (for example while its session waits for a decision). */
  async deferWakeup(id: string, delayMs: number, note?: string | null): Promise<void> {
    await this.sql`UPDATE wakeups SET status = 'pending', claimed_at = NULL, scheduled_at = ${new Date(Date.now() + delayMs)}, error = ${note ?? null} WHERE id = ${id} AND status = 'running'`;
  }

  async finishWakeup(id: string, status: "done" | "failed" | "skipped", error?: string | null): Promise<void> {
    await this.sql`UPDATE wakeups SET status = ${status}, finished_at = now(), error = ${error ?? null} WHERE id = ${id}`;
  }

  /** Wake-ups left "running" by a crashed process go back to pending after the given age. */
  async requeueStaleWakeups(olderThanMs: number, now: Date = new Date()): Promise<number> {
    const since = new Date(now.getTime() - olderThanMs);
    const rows = await this.sql<{ id: string }[]>`UPDATE wakeups SET status = 'pending', claimed_at = NULL WHERE status = 'running' AND claimed_at < ${since} RETURNING id`;
    return rows.length;
  }

  async listWakeups(companyId: string, options: { status?: Wakeup["status"]; limit?: number } = {}): Promise<Wakeup[]> {
    const rows = await this.sql<WakeupRow[]>`
      SELECT * FROM wakeups WHERE company_id = ${companyId} ${options.status ? this.sql`AND status = ${options.status}` : this.sql``}
      ORDER BY scheduled_at DESC LIMIT ${options.limit ?? 50}
    `;
    return rows.map(toWakeup);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
