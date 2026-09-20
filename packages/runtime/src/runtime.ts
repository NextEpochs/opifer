/**
 * The agent runtime: creates sessions with a stable prefix and runs one turn
 * at a time as a sequence of separate phases. Every message and event is
 * persisted as soon as it exists; an interrupted turn resumes from the
 * history without re-running tools.
 */

import type { Sql } from "postgres";
import type { ContentPart, ContentToolCall, ContentToolResult, Message } from "@opifer/sdk";
import { DEFAULT_TURN_LIMITS, type StopReason, type TurnLimits } from "./limits.js";
import { assembleSystemPrompt, hashPrompt, loadContextFiles, type PromptInput } from "./prompt.js";
import type { ProviderRegistry } from "./providers.js";
import { completeWithRecovery, DEFAULT_RECOVERY, type RecoveryOptions } from "./recovery.js";
import { SessionStore } from "./store.js";
import type { ToolExecutor } from "./tools/types.js";
import type { RunRecord, RuntimeEventListener, SessionKind, SessionRecord, StoredMessage } from "./types.js";

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
    const promptInput: PromptInput = {
      agent: { name: agent.name, role: agent.role, reportsTo, reports },
      company: { name: company.name, mission: company.mission },
      contextFiles: await loadContextFiles(workdir),
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
      kind: input.kind ?? "chat",
      title: input.title ?? null,
      systemPrompt,
      systemPromptHash: hashPrompt(systemPrompt),
      model,
      fallbackModel,
      workdir,
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

    const run = await this.store.createRun(session);
    const controller = new AbortController();
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const turn: ActiveTurn = { controller, injections: [] };
    this.active.set(session.id, turn);
    const log = (type: string, payload: Record<string, unknown> = {}) => this.store.appendRunEvent(run, type, payload);
    await log("phase", { phase: "preflight" });

    const started = Date.now();
    let iterations = 0;
    let assistantText = "";
    let stopReason: string = "final_answer";
    let status: RunRecord["status"] = "completed";
    let error: string | null = null;

    try {
      const history = await this.store.listMessages(session.id);
      await this.settlePendingToolCalls(session, run, history, emit, log);
      await this.acceptUserInput(session, run, history, input.text, emit);
      if (history.length === 0) throw new Error("no message to answer");
      if (!session.title && input.text) await this.store.setSessionTitle(session.id, input.text.slice(0, 80));

      while (true) {
        iterations++;
        if (iterations > this.limits.maxIterations) {
          stopReason = "iteration_limit";
          break;
        }
        if (Date.now() - started > this.limits.maxDurationMs) {
          stopReason = "time_limit";
          break;
        }
        if (controller.signal.aborted) {
          stopReason = "interrupted";
          status = "interrupted";
          break;
        }

        emit({ type: "phase", phase: "assemble" });
        const request = {
          system: session.systemPrompt,
          messages: history.map((m): Message => ({ role: m.role, content: m.content })),
          tools: this.options.tools.definitions(),
          maxOutputTokens: this.options.maxOutputTokens ?? 8192,
          cachePrefix: true,
          signal: controller.signal,
        };

        emit({ type: "phase", phase: "call" });
        await log("phase", { phase: "call", iteration: iterations, model: primary.id });
        let outcome;
        try {
          outcome = await completeWithRecovery(primary, fallback, request, (t) => emit({ type: "text", text: t }), {
            ...this.recovery,
            onRetry: (attempt, delayMs, reason) => {
              emit({ type: "retry", attempt, delayMs, reason });
              void log("retry", { attempt, delayMs, reason });
            },
            onFallback: (from, to, reason) => {
              emit({ type: "fallback", from, to, reason });
              void log("fallback", { from, to, reason });
            },
          });
        } catch (callError) {
          if (controller.signal.aborted) {
            stopReason = "interrupted";
            status = "interrupted";
            break;
          }
          throw callError;
        }

        emit({ type: "phase", phase: "read" });
        if (outcome.stopReason === "aborted" || controller.signal.aborted) {
          if (outcome.text) {
            const partial = await this.store.appendMessage(session, "assistant", [{ type: "text", text: outcome.text }], { runId: run.id, usage: outcome.usage });
            history.push(partial);
            emit({ type: "message", message: partial });
          }
          stopReason = "interrupted";
          status = "interrupted";
          break;
        }

        const content: ContentPart[] = [];
        if (outcome.text) content.push({ type: "text", text: outcome.text });
        content.push(...outcome.toolCalls);
        if (content.length === 0) {
          stopReason = "empty_response";
          emit({ type: "notice", message: "the model answered empty twice" });
          break;
        }
        const assistant = await this.store.appendMessage(session, "assistant", content, { runId: run.id, usage: outcome.usage });
        history.push(assistant);
        emit({ type: "message", message: assistant });
        assistantText = outcome.text;
        await this.store.updateRunProgress(run.id, { iterations, usage: outcome.usage });
        await log("model", { model: outcome.modelId, usage: outcome.usage, stopReason: outcome.stopReason, toolCalls: outcome.toolCalls.length });

        if (outcome.toolCalls.length === 0) {
          stopReason = outcome.stopReason === "max_tokens" ? "output_limit" : "final_answer";
          break;
        }

        emit({ type: "phase", phase: "tools" });
        const { results, endTurn } = await this.executeToolCalls(session, outcome.toolCalls, controller.signal, emit, log);
        const toolContent: ContentPart[] = [...results];
        const injected = turn.injections.splice(0);
        if (injected.length > 0) {
          toolContent.push({ type: "text", text: injected.map((t) => `[operator message] ${t}`).join("\n") });
          await log("injection", { count: injected.length });
        }
        const toolMessage = await this.store.appendMessage(session, "tool", toolContent, { runId: run.id });
        history.push(toolMessage);
        emit({ type: "message", message: toolMessage });

        if (endTurn) {
          stopReason = endTurn;
          status = endTurn === "clarification_requested" ? "waiting" : "completed";
          break;
        }
        if (controller.signal.aborted) {
          stopReason = "interrupted";
          status = "interrupted";
          break;
        }
      }
    } catch (turnError) {
      status = "failed";
      stopReason = "error";
      error = turnError instanceof Error ? turnError.message : String(turnError);
      emit({ type: "notice", message: `error: ${error}` });
      await log("error", { message: error });
    } finally {
      this.active.delete(session.id);
    }

    emit({ type: "phase", phase: "close" });
    await log("phase", { phase: "close", stopReason, iterations });
    const finished = await this.store.finishRun(run.id, { status, stopReason, error });
    emit({ type: "done", run: finished });
    return { run: finished, stopReason, assistantText };
  }

  /** No replay: tool calls left without a result receive an interruption result. */
  private async settlePendingToolCalls(
    session: SessionRecord,
    run: RunRecord,
    history: StoredMessage[],
    emit: RuntimeEventListener,
    log: (type: string, payload?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const last = history.at(-1);
    if (!last || last.role !== "assistant") return;
    const calls = last.content.filter((p): p is ContentToolCall => p.type === "tool_call");
    if (calls.length === 0) return;
    const results: ContentToolResult[] = calls.map((call) => ({
      type: "tool_result",
      toolCallId: call.id,
      content: "Execution was interrupted by a restart before this tool completed: it was NOT re-run. Check the state and repeat only if needed.",
      isError: true,
    }));
    const message = await this.store.appendMessage(session, "tool", results, { runId: run.id });
    history.push(message);
    emit({ type: "notice", message: `${calls.length} tool calls interrupted by a restart, not re-run` });
    await log("no_replay", { toolCalls: calls.map((c) => c.name) });
  }

  /** The person's message enters as a user message; if the last one is already a user message, it is appended to it (alternation). */
  private async acceptUserInput(session: SessionRecord, run: RunRecord, history: StoredMessage[], text: string | undefined, emit: RuntimeEventListener): Promise<void> {
    const last = history.at(-1);
    if (text === undefined || text === "") {
      if (last && last.role === "assistant") throw new Error("no new message: the agent has already answered");
      return;
    }
    const part: ContentPart = { type: "text", text };
    if (last && last.role === "user") {
      const merged = await this.store.appendToMessage(last.id, [part]);
      history[history.length - 1] = merged;
      emit({ type: "message", message: merged });
      return;
    }
    const message = await this.store.appendMessage(session, "user", [part], { runId: run.id });
    history.push(message);
    emit({ type: "message", message });
  }

  private async executeToolCalls(
    session: SessionRecord,
    calls: ContentToolCall[],
    signal: AbortSignal,
    emit: RuntimeEventListener,
    log: (type: string, payload?: Record<string, unknown>) => Promise<void>,
  ): Promise<{ results: ContentToolResult[]; endTurn: string | null }> {
    const results: ContentToolResult[] = [];
    let endTurn: string | null = null;
    const workdir = session.workdir ?? `${this.options.workRoot}/${session.id}`;
    for (const call of calls) {
      if (signal.aborted || endTurn) {
        results.push({ type: "tool_result", toolCallId: call.id, content: "Not executed: turn interrupted.", isError: true });
        continue;
      }
      emit({ type: "tool_call", callId: call.id, name: call.name, arguments: call.arguments });
      await log("tool_call", { callId: call.id, name: call.name, arguments: call.arguments });
      const started = Date.now();
      const outcome = await this.options.tools.execute(call.name, call.arguments, {
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        workdir,
        signal,
      });
      const durationMs = Date.now() - started;
      const result: ContentToolResult = { type: "tool_result", toolCallId: call.id, content: outcome.content, isError: outcome.isError ?? false };
      results.push(result);
      emit({ type: "tool_result", callId: call.id, name: call.name, content: outcome.content, isError: result.isError ?? false, durationMs });
      await log("tool_result", { callId: call.id, name: call.name, isError: result.isError, durationMs, chars: outcome.content.length });
      if (outcome.endTurn) endTurn = outcome.endTurn.stopReason;
    }
    return { results, endTurn };
  }
}

