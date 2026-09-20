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
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerWorkRoutes } from "./routes/work.js";
import { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, SessionStore, type GovernanceGates, type LearningHooks, type ProviderRegistry } from "@opifer/runtime";
import { WorkService, taskTools } from "@opifer/work";
import { LEARNING_GUIDE, LearningService, learningTools } from "@opifer/learning";
import type { ProviderSetup } from "./providers.js";
import { buildGovernance, type Governance } from "./governance.js";
import { Scheduler } from "./scheduler.js";
import { LearningWorker } from "./learning-worker.js";
import { registerLearningRoutes } from "./routes/learning.js";

export interface AppOptions {
  db: DatabaseHandle;
  mode: InstallMode;
  bus?: EventBus;
  /** Folder with the compiled UI; if it exists it is served at the root. */
  uiDir?: string;
  /** Fastify logger: `true`, `false`, or pino options (e.g. `{ level: "warn" }`). */
  logger?: boolean | { level: string };
  /** Model providers and default model; without them, sessions are not available. */
  providers?: ProviderSetup;
  /** Root folder of the sessions' working directories. */
  workRoot?: string;
  /** Tool executor underneath governance; defaults to the native tools. */
  tools?: ConstructorParameters<typeof AgentRuntime>[0]["tools"];
  /**
   * Governance (budget, permissions, approvals, secrets). It needs a place
   * for the master key; without one the runtime runs ungoverned, which is
   * only for tests.
   */
  governance?: { credentialsDir: string; usdToEur?: number } | false;
  /** Task leases and the scheduler; `scheduler: false` leaves wake-ups unprocessed (tests drive them by hand). */
  work?: { leaseMs?: number; failureThreshold?: number; scheduler?: boolean; tickMs?: number; concurrency?: number };
  /** Learning: the review worker (`worker: false` leaves reviews pending for tests), the review model, the embedding model. */
  learning?: { worker?: boolean; tickMs?: number; reviewModel?: string | null; embeddingModel?: string | null };
}

export interface AppContext {
  db: DatabaseHandle;
  bus: EventBus;
  mode: InstallMode;
  runtime: AgentRuntime | null;
  governance: Governance | null;
  work: WorkService;
  scheduler: Scheduler | null;
  learning: LearningService | null;
  learningWorker: LearningWorker | null;
}

export function buildRuntime(
  db: DatabaseHandle,
  providers: ProviderRegistry,
  options: { workRoot: string; defaultModel: string; fallbackModel?: string | null; tools?: AppOptions["tools"]; gates?: GovernanceGates; learning?: LearningHooks },
): AgentRuntime {
  return new AgentRuntime({
    sql: db.sql,
    providers,
    tools: options.tools ?? new NativeToolExecutor(NATIVE_TOOLS),
    workRoot: options.workRoot,
    defaultModel: options.defaultModel,
    defaultFallbackModel: options.fallbackModel ?? null,
    ...(options.gates ? { governance: options.gates } : {}),
    ...(options.learning ? { learning: options.learning } : {}),
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
  const work = new WorkService(options.db.sql, {
    ...(options.work?.leaseMs !== undefined ? { leaseMs: options.work.leaseMs } : {}),
    ...(options.work?.failureThreshold !== undefined ? { failureThreshold: options.work.failureThreshold } : {}),
  });
  // Learning needs the providers (for the review and, when one can embed, for semantic search).
  const learning = options.providers
    ? new LearningService(options.db.sql, new SessionStore(options.db.sql), options.providers.providers, {
        embedder: options.providers.providers.embedder(options.learning?.embeddingModel ?? null),
        reviewModel: options.learning?.reviewModel ?? null,
      })
    : null;
  // Native tools plus the task and learning tools, under governance when it is on.
  const inner =
    options.tools ?? new NativeToolExecutor([...NATIVE_TOOLS, ...taskTools(work, options.db.sql), ...(learning ? learningTools(learning.memories, learning.skills) : [])]);
  const governance =
    options.providers && options.governance
      ? await buildGovernance(options.db, options.providers.providers, bus, {
          credentialsDir: options.governance.credentialsDir,
          ...(options.governance.usdToEur !== undefined ? { usdToEur: options.governance.usdToEur } : {}),
          inner,
        })
      : null;
  if (learning && governance) learning.attachGovernance({ approvals: governance.approvals, budget: governance.budget });
  const learningHooks: LearningHooks | null = learning
    ? {
        snapshot: (companyId, agentId) => learning.snapshot(companyId, agentId),
        onTurnDone: async (session, run) => {
          // Routines (M5) will opt out; chats and task sessions are reviewed.
          await learning.reviewer.enqueue({ companyId: session.companyId, agentId: session.agentId, sessionId: session.id, runId: run.id, taskId: session.taskId });
        },
        guide: LEARNING_GUIDE,
      }
    : null;
  const runtime = options.providers
    ? buildRuntime(options.db, options.providers.providers, {
        workRoot,
        defaultModel: options.providers.defaultModel,
        fallbackModel: options.providers.fallbackModel,
        tools: governance ? governance.tools : inner,
        ...(governance ? { gates: governance.gates } : {}),
        ...(learningHooks ? { learning: learningHooks } : {}),
      })
    : null;
  if (learning) {
    work.hooks.onTaskClosed = async (task, outcome) => {
      await learning.onTaskClosed(task.companyId, task.id, outcome);
    };
  }
  const scheduler = runtime
    ? new Scheduler({
        sql: options.db.sql,
        work,
        runtime,
        bus,
        workRoot,
        log: app.log,
        ...(options.work?.tickMs !== undefined ? { tickMs: options.work.tickMs } : {}),
        ...(options.work?.concurrency !== undefined ? { concurrency: options.work.concurrency } : {}),
      })
    : null;
  const learningWorker = learning
    ? new LearningWorker({ sql: options.db.sql, learning, bus, log: app.log, ...(options.learning?.tickMs !== undefined ? { tickMs: options.learning.tickMs } : {}) })
    : null;
  app.decorate("opifer", { db: options.db, bus, mode: options.mode, runtime, governance, work, scheduler, learning, learningWorker });
  if (scheduler && options.work?.scheduler !== false) {
    app.addHook("onReady", async () => scheduler.start());
    app.addHook("onClose", async () => scheduler.stop());
  }
  if (learningWorker && options.learning?.worker !== false) {
    app.addHook("onReady", async () => learningWorker.start());
    app.addHook("onClose", async () => learningWorker.stop());
  }
  if (runtime) {
    // After a restart the runs left "running" are marked interrupted: the history stays, no replay.
    const stale = await runtime.store.markAllStaleRunsInterrupted();
    if (stale > 0) app.log.warn({ stale }, "runs interrupted by a restart");
  }

  await app.register(fastifyWebsocket);

  app.get("/v1/health", async () => {
    let database: "ok" | "error" = "ok";
    try {
      await options.db.sql`SELECT 1`;
    } catch {
      database = "error";
    }
    return {
      status: database === "ok" ? "ok" : "degraded",
      version: OPIFER_VERSION,
      mode: options.mode,
      database,
      runtime: runtime ? "ok" : "absent",
      governance: governance ? "ok" : "absent",
    };
  });

  app.get("/v1/events", { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.send(JSON.stringify({ type: "connected", companyId: null, occurredAt: new Date().toISOString(), payload: { version: OPIFER_VERSION } }));
    socket.on("close", unsubscribe);
  });

  await app.register(registerCompanyRoutes, { prefix: "/v1" });
  await app.register(registerAgentRoutes, { prefix: "/v1" });
  await app.register(registerAuditRoutes, { prefix: "/v1" });
  await app.register(async (scope) => registerWorkRoutes(scope, { work, runtime }), { prefix: "/v1" });
  if (runtime && options.providers) {
    const setup = options.providers;
    await app.register(async (scope) => registerSessionRoutes(scope, { runtime, workRoot }), { prefix: "/v1" });
    await app.register(async (scope) => registerModelRoutes(scope, { runtime, setup }), { prefix: "/v1" });
    if (governance) await app.register(async (scope) => registerGovernanceRoutes(scope, { runtime, governance }), { prefix: "/v1" });
    await app.register(async (scope) => registerOverviewRoutes(scope, { runtime, governance }), { prefix: "/v1" });
    if (learning) await app.register(async (scope) => registerLearningRoutes(scope, { learning, governance }), { prefix: "/v1" });
  }

  if (options.uiDir && (await dirExists(options.uiDir))) {
    await app.register(fastifyStatic, { root: options.uiDir, prefix: "/" });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/v1/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
