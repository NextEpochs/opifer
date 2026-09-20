import { access } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { EventBus, OPIFER_VERSION, type InstallMode } from "@opifer/core";
import type { DatabaseHandle } from "@opifer/db";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audit.js";

export interface AppOptions {
  db: DatabaseHandle;
  mode: InstallMode;
  bus?: EventBus;
  /** Cartella con la UI compilata; se esiste viene servita alla radice. */
  uiDir?: string;
  logger?: boolean;
}

export interface AppContext {
  db: DatabaseHandle;
  bus: EventBus;
  mode: InstallMode;
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
  app.decorate("opifer", { db: options.db, bus, mode: options.mode });

  await app.register(fastifyWebsocket);

  app.get("/v1/health", async () => {
    let database: "ok" | "errore" = "ok";
    try {
      await options.db.sql`SELECT 1`;
    } catch {
      database = "errore";
    }
    return { status: database === "ok" ? "ok" : "degradato", version: OPIFER_VERSION, mode: options.mode, database };
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

  if (options.uiDir && (await dirExists(options.uiDir))) {
    await app.register(fastifyStatic, { root: options.uiDir, prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/v1/")) return reply.code(404).send({ error: "non trovato" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
