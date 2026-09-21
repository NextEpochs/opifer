import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { EventBus, OPIFER_VERSION, type InstallMode } from "@opifer/core";
import type { DatabaseHandle } from "@opifer/db";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerPreferenceRoutes } from "./routes/preferences.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerOverviewRoutes } from "./routes/overview.js";
import { registerWorkRoutes } from "./routes/work.js";
import { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, SessionStore, type GovernanceGates, type LearningHooks, type RuntimeGuides, type ProviderRegistry } from "@opifer/runtime";
import { CHAT_GUIDE, RoutineService, WorkService, taskTools } from "@opifer/work";
import { LEARNING_GUIDE, LearningService, learningTools, renderSkillMarkdown } from "@opifer/learning";
import type { ProviderSetup } from "./providers.js";
import { buildGovernance, type Governance } from "./governance.js";
import { Scheduler } from "./scheduler.js";
import { LearningWorker } from "./learning-worker.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerRoutineRoutes } from "./routes/routines.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { ChannelHub } from "./channels.js";
import { ChannelService, ConnectionService, ConnectionToolExecutor, EventService, WebhookService } from "@opifer/connections";
import { DockerEnvironment, LocalEnvironment, dockerAvailable, useEnvironment } from "@opifer/runtime";
import { API_KEY_PREFIX, AuthService, atLeast, requiredRole, sessionTokenOf, type Actor } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { UpdateCheck, type Fetcher } from "./updates.js";

export interface AppOptions {
  db: DatabaseHandle;
  mode: InstallMode;
  bus?: EventBus;
  /** Folder with the compiled UI; if it exists it is served at the root. */
  uiDir?: string;
  /** Fastify logger: `true`, `false`, or pino options (e.g. `{ level: "warn" }`). */
  logger?: boolean | { level: string };
  /**
   * Authenticated mode (`mode: "authenticated"`): every `/v1` call needs a signed-in person (session cookie) or an
   * API key, with a role. `trustProxy` reads the client address and the protocol from the reverse proxy in front.
   */
  auth?: { sessionDays?: number; trustProxy?: boolean };
  /** The daily look at npm for a newer version (`check: false` turns it off); `current` is the CLI's version when it is ahead of the core. */
  updates?: { check?: boolean; intervalMs?: number; current?: string; fetcher?: Fetcher };
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
  /** Connections: the channel hub and the event deliverer (`start: false` in tests), the sandbox for commands. */
  connections?: {
    start?: boolean;
    eventTickMs?: number;
    sandbox?: "local" | "docker" | "auto";
    dockerImage?: string;
    dockerNetwork?: string;
    transport?: ConstructorParameters<typeof ChannelHub>[0]["transport"];
  };
}

export interface AppContext {
  db: DatabaseHandle;
  bus: EventBus;
  mode: InstallMode;
  /** People, sessions and API keys; null in local mode. */
  auth: AuthService | null;
  /** Whether a newer Opifer is on npm. */
  updates: UpdateCheck;
  runtime: AgentRuntime | null;
  governance: Governance | null;
  work: WorkService;
  routines: RoutineService;
  scheduler: Scheduler | null;
  learning: LearningService | null;
  learningWorker: LearningWorker | null;
  connections: ConnectionService;
  webhooks: WebhookService;
  events: EventService;
  channels: ChannelService;
  hub: ChannelHub | null;
  /** How commands run: "local" or "docker", with the reason. */
  sandbox: { kind: "local" | "docker"; detail: string };
}

export function buildRuntime(
  db: DatabaseHandle,
  providers: ProviderRegistry,
  options: {
    workRoot: string;
    defaultModel: string | null;
    fallbackModel?: string | null;
    tools?: AppOptions["tools"];
    gates?: GovernanceGates;
    learning?: LearningHooks;
    guides?: RuntimeGuides;
  },
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
    ...(options.guides ? { guides: options.guides } : {}),
  });
}

declare module "fastify" {
  interface FastifyInstance {
    opifer: AppContext;
  }
  interface FastifyRequest {
    /** Who is calling, in authenticated mode. */
    actor?: Actor;
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
  const authenticated = options.mode === "authenticated";
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.auth?.trustProxy ?? authenticated });
  const auth = authenticated ? new AuthService(options.db.sql, { ...(options.auth?.sessionDays !== undefined ? { sessionDays: options.auth.sessionDays } : {}) }) : null;
  app.decorateRequest("actor", undefined);
  const updates = new UpdateCheck(options.updates?.current ?? OPIFER_VERSION, {
    enabled: options.updates?.check ?? false,
    ...(options.updates?.intervalMs !== undefined ? { intervalMs: options.updates.intervalMs } : {}),
    ...(options.updates?.fetcher ? { fetcher: options.updates.fetcher } : {}),
  });
  app.addHook("onReady", async () => updates.start());
  app.addHook("onClose", async () => updates.stop());
  // Security headers on every answer (see docs/security.md): no sniffing, no framing, no referrer, a strict policy for the interface.
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    if (!request.url.startsWith("/v1/"))
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
  });
  // Public webhook endpoint: a small per-address limiter keeps a token guess slow (60 calls a minute).
  const hookCalls = new Map<string, { count: number; since: number }>();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/hooks/")) return;
    const now = Date.now();
    const entry = hookCalls.get(request.ip) ?? { count: 0, since: now };
    if (now - entry.since > 60_000) Object.assign(entry, { count: 0, since: now });
    entry.count++;
    hookCalls.set(request.ip, entry);
    if (hookCalls.size > 10_000) hookCalls.clear();
    if (entry.count > 60) return reply.code(429).send({ error: "too many calls: at most 60 a minute per address" });
  });
  const loginFailures = new Map<string, { count: number; since: number }>();
  if (auth) {
    // Authenticated mode: who is calling, and may they do this. Public: the health check, signing in, the webhooks, the interface files.
    const loginCalls = loginFailures;
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0]!;
      if (!path.startsWith("/v1/")) return;
      if (path === "/v1/health" || path.startsWith("/v1/hooks/")) return;
      if (path === "/v1/auth/login") {
        // Ten failed attempts a minute per address; the route counts the failures.
        const entry = loginCalls.get(request.ip);
        if (entry && Date.now() - entry.since <= 60_000 && entry.count >= 10) return reply.code(429).send({ error: "too many sign-in attempts: wait a minute" });
        return;
      }
      const bearer = request.headers.authorization;
      let actor: Actor | null = null;
      if (bearer?.startsWith("Bearer " + API_KEY_PREFIX)) actor = await auth.resolveApiKey(bearer.slice(7));
      else {
        const token = sessionTokenOf(request.headers.cookie);
        if (token) actor = await auth.resolveSession(token);
      }
      if (path === "/v1/auth/me" || path === "/v1/auth/logout") {
        if (actor) request.actor = actor;
        return;
      }
      if (!actor) return reply.code(401).send({ error: "sign in first", mode: "authenticated" });
      const needed = requiredRole(request.method, path);
      if (!atLeast(actor.role, needed)) return reply.code(403).send({ error: `this needs the ${needed} role; you are ${actor.role}` });
      request.actor = actor;
    });
  }
  const bus = options.bus ?? new EventBus();
  const workRoot = options.workRoot ?? path.join(tmpdir(), "opifer-work");
  const work = new WorkService(options.db.sql, {
    ...(options.work?.leaseMs !== undefined ? { leaseMs: options.work.leaseMs } : {}),
    ...(options.work?.failureThreshold !== undefined ? { failureThreshold: options.work.failureThreshold } : {}),
  });
  const routines = new RoutineService(options.db.sql, work);
  // Learning needs the providers (for the review and, when one can embed, for semantic search).
  const learning = options.providers
    ? new LearningService(options.db.sql, new SessionStore(options.db.sql), options.providers.providers, {
        embedder: options.providers.providers.embedder(options.learning?.embeddingModel ?? null),
        reviewModel: options.learning?.reviewModel ?? null,
      })
    : null;
  // The sandbox: Docker when asked for (or available, with "auto"), the local process otherwise.
  const wanted = options.connections?.sandbox ?? "auto";
  let sandbox: AppContext["sandbox"] = { kind: "local", detail: "commands run on this machine" };
  if (wanted !== "local") {
    const docker = await dockerAvailable();
    if (docker.ok) {
      sandbox = {
        kind: "docker",
        detail: `${docker.detail}, image ${options.connections?.dockerImage ?? "node:22-bookworm-slim"}, network ${options.connections?.dockerNetwork ?? "none"}`,
      };
      useEnvironment(
        () =>
          new DockerEnvironment({
            ...(options.connections?.dockerImage ? { image: options.connections.dockerImage } : {}),
            ...(options.connections?.dockerNetwork ? { network: options.connections.dockerNetwork } : {}),
          }),
      );
    } else {
      sandbox = {
        kind: "local",
        detail:
          wanted === "docker"
            ? `Docker asked for but not available (${docker.detail}); commands run on this machine`
            : `Docker not available (${docker.detail}); commands run on this machine`,
      };
      useEnvironment(() => new LocalEnvironment());
    }
  } else useEnvironment(() => new LocalEnvironment());

  // Connections: MCP servers and workflow tools become tools of their company.
  const readSecret = async (companyId: string, name: string, purpose: string) =>
    governanceRef.current ? governanceRef.current.secrets.readForSystem(companyId, name, purpose) : null;
  const governanceRef: { current: Governance | null } = { current: null };
  const connections = new ConnectionService(options.db.sql, readSecret);
  const webhooks = new WebhookService(options.db.sql);
  const events = new EventService(options.db.sql);
  const channels = new ChannelService(options.db.sql);
  // Native tools plus the task and learning tools, then the connection tools, under governance when it is on.
  const nativeExecutor = new NativeToolExecutor([...NATIVE_TOOLS, ...taskTools(work, options.db.sql), ...(learning ? learningTools(learning.memories, learning.skills) : [])]);
  const connectionExecutor = new ConnectionToolExecutor(options.tools ?? nativeExecutor, connections);
  const inner = connectionExecutor;
  const governance =
    options.providers && options.governance
      ? await buildGovernance(options.db, options.providers.providers, bus, {
          credentialsDir: options.governance.credentialsDir,
          ...(options.governance.usdToEur !== undefined ? { usdToEur: options.governance.usdToEur } : {}),
          inner,
        })
      : null;
  governanceRef.current = governance;
  if (learning && governance) learning.attachGovernance({ approvals: governance.approvals, budget: governance.budget });
  const learningHooks: LearningHooks | null = learning
    ? {
        snapshot: (companyId, agentId) => learning.snapshot(companyId, agentId),
        onTurnDone: async (session, run) => {
          // Routines do not write memory unless they say so; chats and task sessions are reviewed.
          if (session.kind === "routine") {
            const owner = await routines.routineOfSession(session.id);
            if (!owner?.routine.learn) return;
          }
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
        guides: { conversation: CHAT_GUIDE },
      })
    : null;
  const scheduler = runtime
    ? new Scheduler({
        sql: options.db.sql,
        work,
        runtime,
        bus,
        workRoot,
        log: app.log,
        routines,
        ...(learning
          ? {
              skillText: async (companyId: string, agentId: string, name: string) => {
                const skill = await learning.skills.resolve(companyId, agentId, name);
                const version = skill ? await learning.skills.version(companyId, skill.id) : null;
                if (skill && version) await learning.skills.recordUse(companyId, skill.id, { agentId });
                return skill && version ? renderSkillMarkdown(skill, version) : null;
              },
            }
          : {}),
        ...(options.work?.tickMs !== undefined ? { tickMs: options.work.tickMs } : {}),
        ...(options.work?.concurrency !== undefined ? { concurrency: options.work.concurrency } : {}),
      })
    : null;
  // A closed task: a routine run in task mode closes with it; then learning looks at it.
  work.hooks.onTaskClosed = async (task, outcome) => {
    await scheduler?.closeTaskRun(task, outcome);
    if (learning) await learning.onTaskClosed(task.companyId, task.id, outcome);
  };
  const learningWorker = learning
    ? new LearningWorker({ sql: options.db.sql, learning, bus, log: app.log, ...(options.learning?.tickMs !== undefined ? { tickMs: options.learning.tickMs } : {}) })
    : null;
  const hub =
    runtime && governance ? new ChannelHub({ app, bus, channels, log: app.log, ...(options.connections?.transport ? { transport: options.connections.transport } : {}) }) : null;
  if (scheduler && hub) scheduler.deliverTo((routine, run, text) => hub.deliverRoutine(routine, run, text));
  app.decorate("opifer", {
    auth,
    updates,
    db: options.db,
    bus,
    mode: options.mode,
    runtime,
    governance,
    work,
    routines,
    scheduler,
    learning,
    learningWorker,
    connections,
    webhooks,
    events,
    channels,
    hub,
    sandbox,
  });
  // Every company event is queued for its subscribers and sent by the deliverer.
  bus.subscribe((event) => void events.enqueue(event).catch((error) => app.log.warn({ err: error }, "event enqueue failed")));
  if (options.connections?.start !== false) {
    let eventTimer: NodeJS.Timeout | null = null;
    app.addHook("onReady", async () => {
      await hub?.start();
      eventTimer = setInterval(() => void events.flush().catch((error) => app.log.warn({ err: error }, "event delivery failed")), options.connections?.eventTickMs ?? 5000);
      eventTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (eventTimer) clearInterval(eventTimer);
      await hub?.stop();
    });
  }
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
    // Routine runs cut by the restart are recorded as interrupted and never re-run: at most once.
    const staleRoutines = await routines.markStaleRunsInterrupted();
    if (staleRoutines > 0) app.log.warn({ staleRoutines }, "routine runs interrupted by a restart");
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
      sandbox,
      mode: options.mode,
      database,
      runtime: runtime ? "ok" : "absent",
      governance: governance ? "ok" : "absent",
      update: updates.status(),
    };
  });

  app.get("/v1/events", { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.send(JSON.stringify({ type: "connected", companyId: null, occurredAt: new Date().toISOString(), payload: { version: OPIFER_VERSION } }));
    socket.on("close", unsubscribe);
  });

  await app.register(async (scope) => registerAuthRoutes(scope, { auth, mode: options.mode, sessionDays: options.auth?.sessionDays ?? 30, loginFailures }), { prefix: "/v1" });
  await app.register(registerCompanyRoutes, { prefix: "/v1" });
  await app.register(registerPreferenceRoutes, { prefix: "/v1" });
  await app.register(registerAgentRoutes, { prefix: "/v1" });
  await app.register(registerAuditRoutes, { prefix: "/v1" });
  await app.register(async (scope) => registerWorkRoutes(scope, { work, runtime }), { prefix: "/v1" });
  await app.register(async (scope) => registerRoutineRoutes(scope, { routines }), { prefix: "/v1" });
  await app.register(
    async (scope) => registerConnectionRoutes(scope, { connections, webhooks, events, channels, hub, invalidateTools: (companyId) => connectionExecutor.invalidate(companyId) }),
    { prefix: "/v1" },
  );
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
