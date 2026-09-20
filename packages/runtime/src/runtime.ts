/**
 * The agent runtime: creates sessions with a stable prefix and runs one turn
 * at a time as a sequence of separate phases. Every message and event is
 * persisted as soon as it exists; an interrupted turn resumes from the
 * history without re-running tools.
 */

import type { Sql } from "postgres";
import { DEFAULT_TURN_LIMITS, type StopReason, type TurnLimits } from "./limits.js";
import { assembleSystemPrompt, hashPrompt, loadContextFiles, type PromptInput } from "./prompt.js";
import type { ProviderRegistry } from "./providers.js";
import { DEFAULT_RECOVERY, type RecoveryOptions } from "./recovery.js";
import { Turn, type TurnOutcome } from "./turn.js";
import type { GovernanceGates } from "./governance.js";
import { SessionStore } from "./store.js";
import type { ToolExecutor } from "./tools/types.js";
import type { RunRecord, RuntimeEventListener, SessionKind, SessionRecord } from "./types.js";

export interface RuntimeOptions {
  sql: Sql;
  providers: ProviderRegistry;
  tools: ToolExecutor;
  /** Root folder of the per-session working directories. */
  workRoot: string;
  defaultModel: string;
  defaultFallbackModel?: string | null;
  limits?: Partial<TurnLimits>;
  recovery?: Partial<RecoveryOptions>;
  maxOutputTokens?: number;
  /** Budget, approvals and the budget-stop hook; absent in the ungoverned local runtime. */
  governance?: GovernanceGates;
  /** Learning (M4): the snapshot that enters the prompt, and the hook that queues the background review. */
  learning?: LearningHooks;
}

export interface LearningHooks {
  /** Memory snapshot and skills index for a new session of this agent. */
  snapshot?(companyId: string, agentId: string): Promise<{ memory: string; skills: Array<{ name: string; description: string }> }>;
  /** A turn ended: the review may run later, on a copy, never on the live session. */
  onTurnDone?(session: SessionRecord, run: RunRecord, stopReason: string): Promise<void>;
  /** One paragraph on how to use memory and skills, appended to the governance rules. */
  guide?: string;
}

export interface StartSessionInput {
  companyId: string;
  agentId: string;
  kind?: SessionKind;
  title?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  workdir?: string | null;
  taskContext?: string;
  locale?: "it" | "en";
  /** The task this session works on: it becomes a "task" session and enters the budget context. */
  taskId?: string | null;
}

export interface TurnInput {
  sessionId: string;
  /** The person's message; absent when resuming an interrupted turn. */
  text?: string;
  onEvent?: RuntimeEventListener;
  signal?: AbortSignal;
}

export interface TurnResult {
  run: RunRecord;
  stopReason: StopReason | string;
  assistantText: string;
}

interface ActiveTurn {
  controller: AbortController;
  injections: string[];
}

export class AgentRuntime {
  readonly store: SessionStore;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly limits: TurnLimits;
  private readonly recovery: RecoveryOptions;

  constructor(private readonly options: RuntimeOptions) {
    this.store = new SessionStore(options.sql);
    this.limits = { ...DEFAULT_TURN_LIMITS, ...options.limits };
    this.recovery = { ...DEFAULT_RECOVERY, ...options.recovery };
  }

  /** Creates a session: assembles the system prompt once and for all. */
  async startSession(input: StartSessionInput): Promise<SessionRecord> {
    const sql = this.options.sql;
    const [agent] = await sql<{ id: string; name: string; role: string; model: string | null; reports_to_agent_id: string | null; reports_to_user_id: string | null }[]>`
      SELECT id, name, role, model, reports_to_agent_id, reports_to_user_id FROM agents WHERE id = ${input.agentId} AND company_id = ${input.companyId}
    `;
    if (!agent) throw new Error("agent not found in this company");
    const [company] = await sql<{ name: string; mission: string | null }[]>`SELECT name, mission FROM companies WHERE id = ${input.companyId}`;
    if (!company) throw new Error("company not found");

    let reportsTo: string | null = null;
    if (agent.reports_to_agent_id) {
      const [m] = await sql<{ name: string }[]>`SELECT name FROM agents WHERE id = ${agent.reports_to_agent_id}`;
      reportsTo = m ? `${m.name} (agent)` : null;
    } else if (agent.reports_to_user_id) {
      const [u] = await sql<{ display_name: string }[]>`SELECT display_name FROM users WHERE id = ${agent.reports_to_user_id}`;
      reportsTo = u ? `${u.display_name} (person)` : null;
    }
    const reports = (await sql<{ name: string }[]>`SELECT name FROM agents WHERE reports_to_agent_id = ${agent.id} ORDER BY name`).map((r) => r.name);

    const workdir = input.workdir ?? null;
    const learned = this.options.learning?.snapshot ? await this.options.learning.snapshot(input.companyId, input.agentId) : null;
    const promptInput: PromptInput = {
      agent: { name: agent.name, role: agent.role, reportsTo, reports },
      company: { name: company.name, mission: company.mission },
      contextFiles: await loadContextFiles(workdir),
      ...(learned ? { memorySnapshot: learned.memory, skillsIndex: learned.skills } : {}),
      ...(this.options.learning?.guide ? { governanceRules: [this.options.learning.guide] } : {}),
      ...(input.taskContext ? { taskContext: input.taskContext } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    };
    const systemPrompt = assembleSystemPrompt(promptInput);
    const model = input.model ?? agent.model ?? this.options.defaultModel;
    this.options.providers.resolve(model);
    const fallbackModel = input.fallbackModel ?? this.options.defaultFallbackModel ?? null;
    if (fallbackModel) this.options.providers.resolve(fallbackModel);

    return this.store.createSession({
      companyId: input.companyId,
      agentId: input.agentId,
      kind: input.kind ?? (input.taskId ? "task" : "chat"),
      title: input.title ?? null,
      systemPrompt,
      systemPromptHash: hashPrompt(systemPrompt),
      model,
      fallbackModel,
      workdir,
      taskId: input.taskId ?? null,
    });
  }

  /** After a restart: closes the runs left hanging. The history stays as it is. */
  async recoverSession(sessionId: string): Promise<RunRecord[]> {
    return this.store.markStaleRunsInterrupted(sessionId);
  }

  /** Stops the session's current turn; the stop is checked at every phase. */
  interrupt(sessionId: string): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.controller.abort();
    return true;
  }

  /** Operator message during a turn: it enters the next tool result, never the system prompt. */
  inject(sessionId: string, text: string): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.injections.push(text);
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const emit: RuntimeEventListener = input.onEvent ?? (() => {});
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new Error("session not found");
    if (session.status !== "active") throw new Error(`the session is ${session.status}`);
    if (this.active.has(session.id)) throw new Error("a turn is already running for this session");
    const activeRun = await this.store.activeRun(session.id);
    if (activeRun) throw new Error("a run appears to be in progress: use recoverSession after a restart");

    emit({ type: "phase", phase: "preflight" });
    const primary = this.options.providers.resolve(session.model);
    const fallback = session.fallbackModel ? this.options.providers.resolve(session.fallbackModel) : null;
    const [agent] = await this.options.sql<{ role: string; status: string }[]>`SELECT role, status FROM agents WHERE id = ${session.agentId}`;
    if (!agent) throw new Error("agent not found");
    if (agent.status !== "active") throw new Error(`the agent is ${agent.status}`);

    const run = await this.store.createRun(session);
    const controller = new AbortController();
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const turn: ActiveTurn = { controller, injections: [] };
    this.active.set(session.id, turn);
    await this.store.appendRunEvent(run, "phase", { phase: "preflight" });

    let outcome: TurnOutcome;
    try {
      outcome = await new Turn(
        {
          store: this.store,
          tools: this.options.tools,
          governance: this.options.governance ?? {},
          limits: this.limits,
          recovery: this.recovery,
          maxOutputTokens: this.options.maxOutputTokens ?? 8192,
          workRoot: this.options.workRoot,
        },
        { session, agentRole: agent.role, run, primary, fallback, emit, controller, injections: turn.injections, text: input.text },
      ).run();
    } finally {
      this.active.delete(session.id);
    }

    emit({ type: "phase", phase: "close" });
    await this.store.appendRunEvent(run, "phase", { phase: "close", stopReason: outcome.stopReason, iterations: outcome.iterations });
    const finished = await this.store.finishRun(run.id, { status: outcome.status, stopReason: outcome.stopReason, error: outcome.error });
    emit({ type: "done", run: finished });
    if (this.options.learning?.onTurnDone && outcome.status === "completed") {
      // Never let learning break the turn that just succeeded.
      try {
        await this.options.learning.onTurnDone(session, finished, outcome.stopReason);
      } catch {
        // the review is best effort
      }
    }
    return { run: finished, stopReason: outcome.stopReason, assistantText: outcome.assistantText };
  }
}
