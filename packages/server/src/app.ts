import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { EventBus, OPIFER_VERSION, type InstallMode } from "@opifer/core";
import type { DatabaseHandle } from "@opifer/db";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerModelRoutes } from "./routes/models.js";
import { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, type ProviderRegistry } from "@opifer/runtime";
import type { ProviderSetup } from "./providers.js";

export interface AppOptions {
  db: DatabaseHandle;
  mode: InstallMode;
  bus?: EventBus;
  /** Cartella con la UI compilata; se esiste viene servita alla radice. */
  uiDir?: string;
  logger?: boolean;
  /** Provider di modelli e modello di default; senza, le sessioni non sono disponibili. */
  providers?: ProviderSetup;
  /** Cartella radice delle cartelle di lavoro delle sessioni. */
  workRoot?: string;
  /** Esecutore dei tool; default i tool nativi. */
  tools?: ConstructorParameters<typeof AgentRuntime>[0]["tools"];
}

export interface AppContext {
  db: DatabaseHandle;
  bus: EventBus;
  mode: InstallMode;
  runtime: AgentRuntime | null;
}

export function buildRuntime(db: DatabaseHandle, providers: ProviderRegistry, options: { workRoot: string; defaultModel: string; fallbackModel?: string | null; tools?: AppOptions["tools"] }): AgentRuntime {
  return new AgentRuntime({
    sql: db.sql,
    providers,
    tools: options.tools ?? new NativeToolExecutor(NATIVE_TOOLS),
    workRoot: options.workRoot,
    defaultModel: options.defaultModel,
    defaultFallbackModel: options.fallbackModel ?? null,
  });
}

declare module "fastify" {
  interface FastifyInstance {
    opifer: AppContext;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const bus = options.bus ?? new EventBus();
  const workRoot = options.workRoot ?? path.join(tmpdir(), "opifer-work");
  const runtime = options.providers
    ? buildRuntime(options.db, options.providers.providers, {
        workRoot,
        defaultModel: options.providers.defaultModel,
        fallbackModel: options.providers.fallbackModel,
        ...(options.tools ? { tools: options.tools } : {}),
      })
    : null;
  app.decorate("opifer", { db: options.db, bus, mode: options.mode, runtime });
  if (runtime) {
    // Dopo un riavvio le esecuzioni rimaste "in corso" sono interrotte: la cronologia resta, niente replay.
    const stale = await runtime.store.markAllStaleRunsInterrupted();
    if (stale > 0) app.log.warn({ stale }, "esecuzioni interrotte da un riavvio");
  }

  await app.register(fastifyWebsocket);

  app.get("/v1/health", async () => {
    let database: "ok" | "errore" = "ok";
    try {
      await options.db.sql`SELECT 1`;
    } catch {
      database = "errore";
    }
    return { status: database === "ok" ? "ok" : "degradato", version: OPIFER_VERSION, mode: options.mode, database, runtime: runtime ? "ok" : "assente" };
  });

  app.get("/v1/events", { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.send(JSON.stringify({ type: "connesso", companyId: null, occurredAt: new Date().toISOString(), payload: { version: OPIFER_VERSION } }));
    socket.on("close", unsubscribe);
  });

  await app.register(registerCompanyRoutes, { prefix: "/v1" });
  await app.register(registerAgentRoutes, { prefix: "/v1" });
  await app.register(registerAuditRoutes, { prefix: "/v1" });
  if (runtime && options.providers) {
    const setup = options.providers;
    await app.register(async (scope) => registerSessionRoutes(scope, { runtime, workRoot }), { prefix: "/v1" });
    await app.register(async (scope) => registerModelRoutes(scope, { runtime, setup }), { prefix: "/v1" });
  }

  if (options.uiDir && (await dirExists(options.uiDir))) {
    await app.register(fastifyStatic, { root: options.uiDir, prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/v1/")) return reply.code(404).send({ error: "non trovato" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
