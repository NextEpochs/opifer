/**
 * Routines API: recurring work with an at-most-once guarantee.
 */

import { WorkError, type Routine, type RoutineService, type ScheduleKind } from "@opifer/work";
import type { FastifyInstance, FastifyReply } from "fastify";

const person = { kind: "person" as const };

const routineBody = {
  type: "object",
  required: ["agentId", "name", "prompt", "scheduleKind", "schedule"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 120 },
    prompt: { type: "string", minLength: 1, maxLength: 20_000 },
    scheduleKind: { type: "string", enum: ["interval", "cron", "once"] },
    schedule: { type: "string", minLength: 1, maxLength: 200 },
    timezone: { type: "string", maxLength: 64 },
    skills: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 10 },
    model: { type: ["string", "null"], maxLength: 200 },
    deliverTo: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 10 },
    catchUpSeconds: { type: "integer", minimum: 0, maximum: 604_800 },
    idleTimeoutSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
    learn: { type: "boolean" },
    mode: { type: "string", enum: ["session", "task"] },
    enabled: { type: "boolean" },
  },
} as const;

const routinePatch = { ...routineBody, required: [] } as const;

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkError) return reply.code(error.code === "not_found" ? 404 : 400).send({ error: error.message });
    throw error;
  }
}

type RoutineInput = {
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
  enabled?: boolean;
};

const serialize = (r: Routine) => ({
  ...r,
  nextDueAt: r.nextDueAt?.toISOString() ?? null,
  lastRunAt: r.lastRunAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export function registerRoutineRoutes(app: FastifyInstance, options: { routines: RoutineService }): void {
  const { routines } = options;
  const bus = app.opifer.bus;

  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>("/companies/:id/routines", async (request) =>
    (await routines.list(request.params.id, request.query.agentId ? { agentId: request.query.agentId } : {})).map(serialize),
  );

  app.post<{ Params: { id: string }; Body: RoutineInput }>("/companies/:id/routines", { schema: { body: routineBody } }, async (request, reply) =>
    handle(reply, async () => {
      const routine = await routines.create({ companyId: request.params.id, ...request.body }, person);
      bus.publish("routine.created", request.params.id, { routineId: routine.id, name: routine.name });
      return reply.code(201).send(serialize(routine));
    }),
  );

  app.get<{ Params: { id: string; routineId: string } }>("/companies/:id/routines/:routineId", async (request, reply) => {
    const routine = await routines.get(request.params.id, request.params.routineId);
    if (!routine) return reply.code(404).send({ error: "routine not found" });
    const runs = await routines.listRuns(request.params.id, routine.id, 20);
    return { ...serialize(routine), runs };
  });

  app.patch<{ Params: { id: string; routineId: string }; Body: Partial<RoutineInput> }>(
    "/companies/:id/routines/:routineId",
    { schema: { body: routinePatch } },
    async (request, reply) =>
      handle(reply, async () => {
        const routine = await routines.update(request.params.id, request.params.routineId, request.body, person);
        bus.publish("routine.updated", request.params.id, { routineId: routine.id, enabled: routine.enabled });
        return serialize(routine);
      }),
  );

  app.delete<{ Params: { id: string; routineId: string } }>("/companies/:id/routines/:routineId", async (request, reply) =>
    handle(reply, async () => {
      await routines.remove(request.params.id, request.params.routineId, person);
      bus.publish("routine.removed", request.params.id, { routineId: request.params.routineId });
      return reply.code(204).send();
    }),
  );

  /** Runs the routine now, outside its schedule. */
  app.post<{ Params: { id: string; routineId: string } }>("/companies/:id/routines/:routineId/run", async (request, reply) =>
    handle(reply, async () => {
      const run = await routines.trigger(request.params.id, request.params.routineId, person);
      return run ?? reply.code(409).send({ error: "a run for this moment was already claimed" });
    }),
  );

  app.get<{ Params: { id: string; routineId: string }; Querystring: { limit?: string } }>("/companies/:id/routines/:routineId/runs", async (request) =>
    routines.listRuns(request.params.id, request.params.routineId, request.query.limit ? Number(request.query.limit) : 50),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/companies/:id/routine-runs", async (request) =>
    routines.listRuns(request.params.id, undefined, request.query.limit ? Number(request.query.limit) : 50),
  );
}
