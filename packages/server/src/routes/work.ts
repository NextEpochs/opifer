/**
 * Work API: goals, projects, tasks (with their why chain, comments,
 * results and sessions), and the actions a person takes on them.
 */

import type { AgentRuntime } from "@opifer/runtime";
import { WorkError, type Task, type TaskPriority, type TaskStatus, type WorkService } from "@opifer/work";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { cloneRepository } from "../repos.js";

export interface WorkRoutesOptions {
  work: WorkService;
  runtime: AgentRuntime | null;
  /** Where project folders live when a project has no folder of its own. */
  workRoot: string;
  /** The company secrets, for the repository token at clone time. */
  secrets?: { readForSystem(companyId: string, name: string, purpose: string): Promise<string | null> } | null;
}

const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;

const goalBody = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", maxLength: 5000 },
    measure: { type: "string", maxLength: 1000 },
    parentId: nullableUuid,
    dueAt: { type: ["string", "null"] },
  },
} as const;

const goalPatch = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", maxLength: 5000 },
    measure: { type: "string", maxLength: 1000 },
    parentId: nullableUuid,
    status: { type: "string", enum: ["active", "reached", "dropped"] },
    dueAt: { type: ["string", "null"] },
  },
} as const;

const projectBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 5000 },
    goalId: nullableUuid,
    workdir: { type: ["string", "null"], maxLength: 1000 },
    repoUrl: { type: ["string", "null"], maxLength: 1000 },
    branch: { type: ["string", "null"], maxLength: 200 },
  },
} as const;

const projectPatch = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 5000 },
    goalId: nullableUuid,
    workdir: { type: ["string", "null"], maxLength: 1000 },
    status: { type: "string", enum: ["active", "paused", "done", "archived"] },
  },
} as const;

const taskBody = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", maxLength: 20_000 },
    acceptance: { type: "string", maxLength: 5000 },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    projectId: nullableUuid,
    goalId: nullableUuid,
    parentId: nullableUuid,
    assigneeAgentId: nullableUuid,
    reviewerAgentId: nullableUuid,
    dueAt: { type: ["string", "null"] },
  },
} as const;

const taskPatch = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: { type: "string", maxLength: 20_000 },
    acceptance: { type: "string", maxLength: 5000 },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    projectId: nullableUuid,
    goalId: nullableUuid,
    reviewerAgentId: nullableUuid,
    dueAt: { type: ["string", "null"] },
  },
} as const;

const resultBody = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string", minLength: 1, maxLength: 5000 }, verification: { type: "string", maxLength: 5000 } },
} as const;

function serialize(task: Task) {
  return {
    ...task,
    dueAt: task.dueAt?.toISOString() ?? null,
    leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null,
    checkedOutAt: task.checkedOutAt?.toISOString() ?? null,
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

const dateOrNull = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(v));

export async function registerWorkRoutes(app: FastifyInstance, options: WorkRoutesOptions): Promise<void> {
  const { work, runtime } = options;
  const { sql } = app.opifer.db;
  const bus = app.opifer.bus;
  const person = { kind: "person" as const };

  const handle = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WorkError) return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_transition" ? 409 : 400).send({ error: error.message });
      throw error;
    }
  };

  const companyOfTask = async (taskId: string) => {
    const [row] = await sql<{ company_id: string }[]>`SELECT company_id FROM tasks WHERE id = ${taskId}`;
    return row?.company_id ?? null;
  };

  // --- Goals and projects --------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/goals", async (request) => work.listGoals(request.params.id));
  app.post<{ Params: { id: string }; Body: { title: string; description?: string; measure?: string; parentId?: string | null; dueAt?: string | null } }>(
    "/companies/:id/goals",
    { schema: { body: goalBody } },
    async (request, reply) =>
      handle(reply, async () => {
        const goal = await work.createGoal(
          {
            companyId: request.params.id,
            title: request.body.title,
            description: request.body.description ?? "",
            measure: request.body.measure ?? "",
            parentId: request.body.parentId ?? null,
            dueAt: dateOrNull(request.body.dueAt) ?? null,
          },
          person,
        );
        bus.publish("goal.created", request.params.id, { goalId: goal.id });
        return reply.code(201).send(goal);
      }),
  );
  app.patch<{ Params: { id: string; goalId: string }; Body: Record<string, unknown> }>("/companies/:id/goals/:goalId", { schema: { body: goalPatch } }, async (request, reply) =>
    handle(reply, async () => {
      const b = request.body as {
        title?: string;
        description?: string;
        measure?: string;
        parentId?: string | null;
        status?: "active" | "reached" | "dropped";
        dueAt?: string | null;
      };
      const { dueAt, ...rest } = b;
      const goal = await work.updateGoal(request.params.id, request.params.goalId, { ...rest, ...(dueAt !== undefined ? { dueAt: dateOrNull(dueAt) ?? null } : {}) }, person);
      bus.publish("goal.updated", request.params.id, { goalId: goal.id });
      return goal;
    }),
  );

  app.get<{ Params: { id: string } }>("/companies/:id/projects", async (request) => work.listProjects(request.params.id));
  app.post<{
    Params: { id: string };
    Body: { name: string; description?: string; goalId?: string | null; workdir?: string | null; repoUrl?: string | null; branch?: string | null };
  }>("/companies/:id/projects", { schema: { body: projectBody } }, async (request, reply) =>
    handle(reply, async () => {
      let project = await work.createProject({ companyId: request.params.id, ...request.body }, person);
      // A repository: cloned now into the project's folder, with the company's GITHUB_TOKEN when there is one.
      if (project.repoUrl) {
        const workdir = project.workdir ?? path.join(options.workRoot, `project-${project.id}`);
        const token = (await options.secrets?.readForSystem(request.params.id, "GITHUB_TOKEN", "repository clone")) ?? null;
        const cloned = await cloneRepository({ repoUrl: project.repoUrl, branch: project.branch, workdir, token });
        project = await work.updateProject(request.params.id, project.id, { workdir, repoStatus: cloned.ok ? "cloned" : "failed", repoDetail: cloned.detail }, person);
      }
      bus.publish("project.created", request.params.id, { projectId: project.id });
      return reply.code(201).send(project);
    }),
  );
  app.patch<{ Params: { id: string; projectId: string }; Body: Record<string, unknown> }>(
    "/companies/:id/projects/:projectId",
    { schema: { body: projectPatch } },
    async (request, reply) =>
      handle(reply, async () => {
        const project = await work.updateProject(request.params.id, request.params.projectId, request.body as never, person);
        bus.publish("project.updated", request.params.id, { projectId: project.id });
        return project;
      }),
  );

  // --- Tasks ---------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: string; agentId?: string; projectId?: string; parentId?: string } }>("/companies/:id/tasks", async (request) => {
    const q = request.query;
    const status = q.status ? (q.status.split(",") as TaskStatus[]) : undefined;
    const tasks = await work.listTasks(request.params.id, {
      ...(status ? { status } : {}),
      ...(q.agentId ? { assigneeAgentId: q.agentId } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.parentId === "none" ? { parentId: null } : q.parentId ? { parentId: q.parentId } : {}),
    });
    return tasks.map(serialize);
  });

  app.post<{
    Params: { id: string };
    Body: {
      title: string;
      description?: string;
      acceptance?: string;
      priority?: TaskPriority;
      projectId?: string | null;
      goalId?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
      reviewerAgentId?: string | null;
      dueAt?: string | null;
    };
  }>("/companies/:id/tasks", { schema: { body: taskBody } }, async (request, reply) =>
    handle(reply, async () => {
      const task = await work.createTask({ companyId: request.params.id, ...request.body, dueAt: dateOrNull(request.body.dueAt) ?? null }, person);
      bus.publish("task.created", request.params.id, { taskId: task.id, status: task.status, agentId: task.assigneeAgentId });
      return reply.code(201).send(serialize(task));
    }),
  );

  /** The task with everything the drawer shows: why, comments, results, subtasks, sessions and cost. */
  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const companyId = await companyOfTask(request.params.id);
    if (!companyId) return reply.code(404).send({ error: "task not found" });
    const task = (await work.getTask(companyId, request.params.id))!;
    const [why, comments, products, children] = await Promise.all([
      work.whyChain(companyId, task),
      work.listComments(companyId, task.id),
      work.listProducts(companyId, task.id),
      work.listTasks(companyId, { parentId: task.id }),
    ]);
    const sessions = await sql<
      { id: string; agent_id: string; status: string; created_at: Date }[]
    >`SELECT id, agent_id, status, created_at FROM sessions WHERE task_id = ${task.id} ORDER BY created_at`;
    const [cost] = await sql<
      { eur: string; usd: string; calls: string }[]
    >`SELECT coalesce(sum(amount_eur), 0)::text AS eur, coalesce(sum(amount_usd), 0)::text AS usd, count(*)::text AS calls FROM cost_events WHERE task_id = ${task.id}`;
    return {
      ...serialize(task),
      why,
      comments,
      products,
      children: children.map(serialize),
      sessions: sessions.map((s) => ({ id: s.id, agentId: s.agent_id, status: s.status, running: runtime?.isRunning(s.id) ?? false, createdAt: s.created_at.toISOString() })),
      cost: { eur: Number(cost?.eur ?? 0), usd: Number(cost?.usd ?? 0), calls: Number(cost?.calls ?? 0) },
    };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/tasks/:id", { schema: { body: taskPatch } }, async (request, reply) =>
    handle(reply, async () => {
      const companyId = await companyOfTask(request.params.id);
      if (!companyId) return reply.code(404).send({ error: "task not found" });
      const { dueAt, ...rest } = request.body as { dueAt?: string | null } & Record<string, unknown>;
      const task = await work.updateTask(companyId, request.params.id, { ...(rest as object), ...(dueAt !== undefined ? { dueAt: dateOrNull(dueAt) ?? null } : {}) }, person);
      bus.publish("task.updated", companyId, { taskId: task.id, status: task.status });
      return serialize(task);
    }),
  );

  const action = <B>(name: string, run: (companyId: string, taskId: string, body: B) => Promise<Task>, schema?: object) =>
    app.post<{ Params: { id: string }; Body: B }>(`/tasks/:id/${name}`, schema ? { schema: { body: schema } } : {}, async (request, reply) =>
      handle(reply, async () => {
        const companyId = await companyOfTask(request.params.id);
        if (!companyId) return reply.code(404).send({ error: "task not found" });
        const task = await run(companyId, request.params.id, request.body as B);
        bus.publish("task.updated", companyId, { taskId: task.id, status: task.status, action: name });
        return serialize(task);
      }),
    );

  action<{ agentId?: string | null; userId?: string | null }>("assign", (c, id, b) => work.assign(c, id, { agentId: b?.agentId ?? null, userId: b?.userId ?? null }, person), {
    type: "object",
    additionalProperties: false,
    properties: { agentId: nullableUuid, userId: nullableUuid },
  });
  action<{ summary: string; verification?: string }>(
    "complete",
    (c, id, b) => work.complete(c, id, b, person, { from: ["in_progress", "in_review", "todo", "blocked"] }),
    resultBody,
  );
  action<{ note: string }>("request-changes", (c, id, b) => work.requestChanges(c, id, b.note, person), {
    type: "object",
    required: ["note"],
    additionalProperties: false,
    properties: { note: { type: "string", minLength: 1, maxLength: 5000 } },
  });
  action<{ reason: string }>("block", (c, id, b) => work.block(c, id, b.reason, person), {
    type: "object",
    required: ["reason"],
    additionalProperties: false,
    properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } },
  });
  action<Record<string, never>>("unblock", (c, id) => work.unblock(c, id, person));
  action<{ reason?: string }>("cancel", (c, id, b) => work.cancel(c, id, b?.reason ?? "", person), {
    type: "object",
    additionalProperties: false,
    properties: { reason: { type: "string", maxLength: 2000 } },
  });
  action<{ reason?: string }>("release", async (c, id, b) => work.release(c, id, { kind: "paused", reason: b?.reason ?? "released by a person" }, person), {
    type: "object",
    additionalProperties: false,
    properties: { reason: { type: "string", maxLength: 2000 } },
  });
  /** Wakes the assignee again (a nudge). */
  action<Record<string, never>>("wake", async (c, id) => {
    const task = await work.getTask(c, id);
    if (!task) throw new WorkError("not_found", "task not found");
    if (task.assigneeAgentId) await work.wake(c, task.assigneeAgentId, "assignment", { taskId: id, dedupeKey: `assignment:${id}` });
    return task;
  });

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/tasks/:id/comments",
    { schema: { body: { type: "object", required: ["body"], additionalProperties: false, properties: { body: { type: "string", minLength: 1, maxLength: 20_000 } } } } },
    async (request, reply) =>
      handle(reply, async () => {
        const companyId = await companyOfTask(request.params.id);
        if (!companyId) return reply.code(404).send({ error: "task not found" });
        const comment = await work.comment(companyId, request.params.id, person, request.body.body);
        bus.publish("task.commented", companyId, { taskId: request.params.id, commentId: comment.id });
        return reply.code(201).send(comment);
      }),
  );

  app.post<{ Params: { id: string }; Body: { kind: "file" | "link" | "diff" | "document" | "decision" | "note"; title: string; ref?: string; summary?: string } }>(
    "/tasks/:id/products",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind", "title"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["file", "link", "diff", "document", "decision", "note"] },
            title: { type: "string", minLength: 1, maxLength: 300 },
            ref: { type: "string", maxLength: 20_000 },
            summary: { type: "string", maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const companyId = await companyOfTask(request.params.id);
        if (!companyId) return reply.code(404).send({ error: "task not found" });
        const product = await work.addProduct(companyId, request.params.id, request.body, person);
        return reply.code(201).send(product);
      }),
  );

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/companies/:id/wakeups", async (request) =>
    work.listWakeups(request.params.id, { ...(request.query.status ? { status: request.query.status as never } : {}) }),
  );
}
