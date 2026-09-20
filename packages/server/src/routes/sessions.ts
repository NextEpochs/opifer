import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRuntime, RuntimeEvent } from "@opifer/runtime";
import type { FastifyInstance } from "fastify";

const createSessionBody = {
  type: "object",
  required: ["agentId"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string", format: "uuid" },
    title: { type: "string", maxLength: 200 },
    model: { type: "string", maxLength: 200 },
    locale: { type: "string", enum: ["it", "en"] },
  },
} as const;

const messageBody = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 100_000 } },
} as const;

export interface SessionRoutesOptions {
  runtime: AgentRuntime;
  workRoot: string;
}

/** Eventi di streaming del runtime, pubblicati sul bus e quindi sul WebSocket. */
export function publishRuntimeEvent(app: FastifyInstance, companyId: string, sessionId: string, runId: string | null, event: RuntimeEvent): void {
  app.opifer.bus.publish("sessione.evento", companyId, { sessionId, runId, event });
}

export async function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): Promise<void> {
  const { runtime } = options;
  const { store } = runtime;
  const { sql } = app.opifer.db;

  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>("/companies/:id/sessions", async (request) => {
    return store.listSessions(request.params.id, request.query.agentId);
  });

  app.post<{ Params: { id: string }; Body: { agentId: string; title?: string; model?: string; locale?: "it" | "en" } }>(
    "/companies/:id/sessions",
    { schema: { body: createSessionBody } },
    async (request, reply) => {
      const companyId = request.params.id;
      const [company] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyId}`;
      if (!company) return reply.code(404).send({ error: "azienda non trovata" });
      try {
        const session = await runtime.startSession({
          companyId,
          agentId: request.body.agentId,
          title: request.body.title ?? null,
          model: request.body.model ?? null,
          workdir: path.join(options.workRoot, randomUUID()),
          ...(request.body.locale ? { locale: request.body.locale } : {}),
        });
        app.opifer.bus.publish("sessione.creata", companyId, { sessionId: session.id, agentId: session.agentId });
        return reply.code(201).send(session);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = await store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "sessione non trovata" });
    const messages = await store.listMessages(session.id);
    const runs = await store.listRuns(session.id);
    return { ...session, running: runtime.isRunning(session.id), messages, runs };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/messages", async (request, reply) => {
    const session = await store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "sessione non trovata" });
    return store.listMessages(session.id);
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/runs", async (request, reply) => {
    const session = await store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "sessione non trovata" });
    const runs = await store.listRuns(session.id);
    return Promise.all(runs.map(async (run) => ({ ...run, events: await store.listRunEvents(run.id) })));
  });

  /** Invia un messaggio: avvia un turno in background, oppure lo inietta nel turno in corso. */
  app.post<{ Params: { id: string }; Body: { text: string } }>("/sessions/:id/messages", { schema: { body: messageBody } }, async (request, reply) => {
    const session = await store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "sessione non trovata" });
    if (session.status !== "attiva") return reply.code(409).send({ error: `la sessione è ${session.status}` });

    if (runtime.isRunning(session.id)) {
      runtime.inject(session.id, request.body.text);
      return reply.code(202).send({ accepted: "iniettato", sessionId: session.id });
    }

    let runId: string | null = null;
    const turn = runtime.runTurn({
      sessionId: session.id,
      text: request.body.text,
      onEvent: (event) => {
        if (event.type === "fine") runId = event.run.id;
        publishRuntimeEvent(app, session.companyId, session.id, runId, event);
      },
    });
    turn.catch((error) => {
      app.log.error({ err: error, sessionId: session.id }, "turno fallito");
      publishRuntimeEvent(app, session.companyId, session.id, runId, { type: "avviso", message: `turno fallito: ${error instanceof Error ? error.message : String(error)}` });
    });
    return reply.code(202).send({ accepted: "turno_avviato", sessionId: session.id });
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/interrupt", async (request, reply) => {
    const stopped = runtime.interrupt(request.params.id);
    return reply.code(stopped ? 202 : 409).send({ interrupted: stopped });
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/close", async (request, reply) => {
    const session = await store.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "sessione non trovata" });
    runtime.interrupt(session.id);
    await store.setSessionStatus(session.id, "chiusa");
    return { id: session.id, status: "chiusa" };
  });
}
