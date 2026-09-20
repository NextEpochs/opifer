/**
 * Il runtime dell'agente: crea sessioni con prefisso stabile ed esegue un
 * turno alla volta come sequenza di fasi separate. Ogni messaggio ed evento
 * è persistito appena esiste; un turno interrotto riprende dalla cronologia
 * senza rieseguire i tool.
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
  /** Cartella radice delle cartelle di lavoro per sessione. */
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
  /** Messaggio della persona; assente quando si riprende un turno interrotto. */
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

  /** Crea una sessione: assembla il prompt di sistema una volta per tutte. */
  async startSession(input: StartSessionInput): Promise<SessionRecord> {
    const sql = this.options.sql;
    const [agent] = await sql<{ id: string; name: string; role: string; model: string | null; reports_to_agent_id: string | null; reports_to_user_id: string | null }[]>`
      SELECT id, name, role, model, reports_to_agent_id, reports_to_user_id FROM agents WHERE id = ${input.agentId} AND company_id = ${input.companyId}
    `;
    if (!agent) throw new Error("agente non trovato in questa azienda");
    const [company] = await sql<{ name: string; mission: string | null }[]>`SELECT name, mission FROM companies WHERE id = ${input.companyId}`;
    if (!company) throw new Error("azienda non trovata");

    let reportsTo: string | null = null;
    if (agent.reports_to_agent_id) {
      const [m] = await sql<{ name: string }[]>`SELECT name FROM agents WHERE id = ${agent.reports_to_agent_id}`;
      reportsTo = m ? `${m.name} (agente)` : null;
    } else if (agent.reports_to_user_id) {
      const [u] = await sql<{ display_name: string }[]>`SELECT display_name FROM users WHERE id = ${agent.reports_to_user_id}`;
      reportsTo = u ? `${u.display_name} (persona)` : null;
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

  /** Dopo un riavvio: chiude le esecuzioni rimaste appese. La cronologia resta com'è. */
  async recoverSession(sessionId: string): Promise<RunRecord[]> {
    return this.store.markStaleRunsInterrupted(sessionId);
  }

  /** Ferma il turno in corso di una sessione; lo stop è verificato a ogni fase. */
  interrupt(sessionId: string): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.controller.abort();
    return true;
  }

  /** Messaggio dell'operatore durante un turno: entra nel prossimo risultato di tool, mai nel prompt di sistema. */
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
    if (!session) throw new Error("sessione non trovata");
    if (session.status !== "attiva") throw new Error(`la sessione è ${session.status}`);
    if (this.active.has(session.id)) throw new Error("un turno è già in corso per questa sessione");
    const activeRun = await this.store.activeRun(session.id);
    if (activeRun) throw new Error("un'esecuzione risulta in corso: usa recoverSession dopo un riavvio");

    emit({ type: "fase", phase: "preflight" });
    const primary = this.options.providers.resolve(session.model);
    const fallback = session.fallbackModel ? this.options.providers.resolve(session.fallbackModel) : null;

    const run = await this.store.createRun(session);
    const controller = new AbortController();
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const turn: ActiveTurn = { controller, injections: [] };
    this.active.set(session.id, turn);
    const log = (type: string, payload: Record<string, unknown> = {}) => this.store.appendRunEvent(run, type, payload);
    await log("fase", { phase: "preflight" });

    const started = Date.now();
    let iterations = 0;
    let assistantText = "";
    let stopReason: string = "risposta_finale";
    let status: RunRecord["status"] = "conclusa";
    let error: string | null = null;

    try {
      const history = await this.store.listMessages(session.id);
      await this.settlePendingToolCalls(session, run, history, emit, log);
      await this.acceptUserInput(session, run, history, input.text, emit);
      if (history.length === 0) throw new Error("nessun messaggio a cui rispondere");
      if (!session.title && input.text) await this.store.setSessionTitle(session.id, input.text.slice(0, 80));

      while (true) {
        iterations++;
        if (iterations > this.limits.maxIterations) {
          stopReason = "limite_iterazioni";
          break;
        }
        if (Date.now() - started > this.limits.maxDurationMs) {
          stopReason = "limite_tempo";
          break;
        }
        if (controller.signal.aborted) {
          stopReason = "interruzione";
          status = "interrotta";
          break;
        }

        emit({ type: "fase", phase: "assemblaggio" });
        const request = {
          system: session.systemPrompt,
          messages: history.map((m): Message => ({ role: m.role, content: m.content })),
          tools: this.options.tools.definitions(),
          maxOutputTokens: this.options.maxOutputTokens ?? 8192,
          cachePrefix: true,
          signal: controller.signal,
        };

        emit({ type: "fase", phase: "chiamata" });
        await log("fase", { phase: "chiamata", iteration: iterations, model: primary.id });
        let outcome;
        try {
          outcome = await completeWithRecovery(primary, fallback, request, (t) => emit({ type: "testo", text: t }), {
            ...this.recovery,
            onRetry: (attempt, delayMs, reason) => {
              emit({ type: "ritentativo", attempt, delayMs, reason });
              void log("ritentativo", { attempt, delayMs, reason });
            },
            onFallback: (from, to, reason) => {
              emit({ type: "riserva", from, to, reason });
              void log("riserva", { from, to, reason });
            },
          });
        } catch (callError) {
          if (controller.signal.aborted) {
            stopReason = "interruzione";
            status = "interrotta";
            break;
          }
          throw callError;
        }

        emit({ type: "fase", phase: "lettura" });
        if (outcome.stopReason === "aborted" || controller.signal.aborted) {
          if (outcome.text) {
            const partial = await this.store.appendMessage(session, "assistant", [{ type: "text", text: outcome.text }], { runId: run.id, usage: outcome.usage });
            history.push(partial);
            emit({ type: "messaggio", message: partial });
          }
          stopReason = "interruzione";
          status = "interrotta";
          break;
        }

        const content: ContentPart[] = [];
        if (outcome.text) content.push({ type: "text", text: outcome.text });
        content.push(...outcome.toolCalls);
        if (content.length === 0) {
          stopReason = "risposta_vuota";
          emit({ type: "avviso", message: "il modello ha risposto vuoto due volte" });
          break;
        }
        const assistant = await this.store.appendMessage(session, "assistant", content, { runId: run.id, usage: outcome.usage });
        history.push(assistant);
        emit({ type: "messaggio", message: assistant });
        assistantText = outcome.text;
        await this.store.updateRunProgress(run.id, { iterations, usage: outcome.usage });
        await log("modello", { model: outcome.modelId, usage: outcome.usage, stopReason: outcome.stopReason, toolCalls: outcome.toolCalls.length });

        if (outcome.toolCalls.length === 0) {
          stopReason = outcome.stopReason === "max_tokens" ? "limite_uscita" : "risposta_finale";
          break;
        }

        emit({ type: "fase", phase: "tool" });
        const { results, endTurn } = await this.executeToolCalls(session, outcome.toolCalls, controller.signal, emit, log);
        const toolContent: ContentPart[] = [...results];
        const injected = turn.injections.splice(0);
        if (injected.length > 0) {
          toolContent.push({ type: "text", text: injected.map((t) => `[messaggio dell'operatore] ${t}`).join("\n") });
          await log("iniezione", { count: injected.length });
        }
        const toolMessage = await this.store.appendMessage(session, "tool", toolContent, { runId: run.id });
        history.push(toolMessage);
        emit({ type: "messaggio", message: toolMessage });

        if (endTurn) {
          stopReason = endTurn;
          status = endTurn === "chiarimento_richiesto" ? "in_attesa" : "conclusa";
          break;
        }
        if (controller.signal.aborted) {
          stopReason = "interruzione";
          status = "interrotta";
          break;
        }
      }
    } catch (turnError) {
      status = "fallita";
      stopReason = "errore";
      error = turnError instanceof Error ? turnError.message : String(turnError);
      emit({ type: "avviso", message: `errore: ${error}` });
      await log("errore", { message: error });
    } finally {
      this.active.delete(session.id);
    }

    emit({ type: "fase", phase: "chiusura" });
    await log("fase", { phase: "chiusura", stopReason, iterations });
    const finished = await this.store.finishRun(run.id, { status, stopReason, error });
    emit({ type: "fine", run: finished });
    return { run: finished, stopReason, assistantText };
  }

  /** Niente replay: le chiamate a tool rimaste senza risultato ricevono un risultato di interruzione. */
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
      content: "Esecuzione interrotta da un riavvio prima di completare questo tool: non è stato rieseguito. Verifica lo stato e ripeti solo se serve.",
      isError: true,
    }));
    const message = await this.store.appendMessage(session, "tool", results, { runId: run.id });
    history.push(message);
    emit({ type: "avviso", message: `${calls.length} chiamate a tool interrotte da un riavvio, non rieseguite` });
    await log("niente_replay", { toolCalls: calls.map((c) => c.name) });
  }

  /** Il messaggio della persona entra come messaggio utente; se l'ultimo è già utente, vi si accoda (alternanza). */
  private async acceptUserInput(session: SessionRecord, run: RunRecord, history: StoredMessage[], text: string | undefined, emit: RuntimeEventListener): Promise<void> {
    const last = history.at(-1);
    if (text === undefined || text === "") {
      if (last && last.role === "assistant") throw new Error("nessun nuovo messaggio: l'agente ha già risposto");
      return;
    }
    const part: ContentPart = { type: "text", text };
    if (last && last.role === "user") {
      const merged = await this.store.appendToMessage(last.id, [part]);
      history[history.length - 1] = merged;
      emit({ type: "messaggio", message: merged });
      return;
    }
    const message = await this.store.appendMessage(session, "user", [part], { runId: run.id });
    history.push(message);
    emit({ type: "messaggio", message });
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
        results.push({ type: "tool_result", toolCallId: call.id, content: "Non eseguito: turno interrotto.", isError: true });
        continue;
      }
      emit({ type: "tool_chiamata", callId: call.id, name: call.name, arguments: call.arguments });
      await log("tool_chiamata", { callId: call.id, name: call.name, arguments: call.arguments });
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
      emit({ type: "tool_risultato", callId: call.id, name: call.name, content: outcome.content, isError: result.isError ?? false, durationMs });
      await log("tool_risultato", { callId: call.id, name: call.name, isError: result.isError, durationMs, chars: outcome.content.length });
      if (outcome.endTurn) endTurn = outcome.endTurn.stopReason;
    }
    return { results, endTurn };
  }
}

