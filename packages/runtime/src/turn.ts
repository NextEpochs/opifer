/**
 * One turn of an agent, as a sequence of separate phases: preflight, assemble,
 * budget reservation, call, read, tools (with permission and approval),
 * close. Every message and event is persisted as soon as it exists.
 */

import type { ContentPart, ContentToolCall, ContentToolResult, Message } from "@opifer/sdk";
import type { GovernanceGates, BudgetDecision } from "./governance.js";
import type { TurnLimits } from "./limits.js";
import type { ResolvedModel } from "./providers.js";
import { completeWithRecovery, type CompletionOutcome, type RecoveryOptions } from "./recovery.js";
import type { SessionStore } from "./store.js";
import type { ToolExecutor, ToolContext } from "./tools/types.js";
import type { RunRecord, RuntimeEventListener, SessionRecord, StoredMessage } from "./types.js";

export interface TurnDeps {
  store: SessionStore;
  tools: ToolExecutor;
  governance: GovernanceGates;
  limits: TurnLimits;
  recovery: RecoveryOptions;
  maxOutputTokens: number;
  workRoot: string;
}

export interface TurnContext {
  session: SessionRecord;
  agentRole: string;
  run: RunRecord;
  primary: ResolvedModel;
  fallback: ResolvedModel | null;
  emit: RuntimeEventListener;
  controller: AbortController;
  injections: string[];
  text: string | undefined;
}

export interface TurnOutcome {
  stopReason: string;
  status: RunRecord["status"];
  assistantText: string;
  iterations: number;
  error: string | null;
}

type ToolBatch = { kind: "results"; results: ContentToolResult[]; endTurn: string | null } | { kind: "suspended"; stopReason: string };

/** Rough input token estimate for the budget reservation: four characters per token. */
export function estimateInputTokens(system: string, messages: Message[]): number {
  const chars = system.length + messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
  return Math.ceil(chars / 4);
}

export class Turn {
  private history: StoredMessage[] = [];
  private iterations = 0;
  private assistantText = "";
  private readonly started = Date.now();

  constructor(
    private readonly deps: TurnDeps,
    private readonly ctx: TurnContext,
  ) {}

  private log(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.deps.store.appendRunEvent(this.ctx.run, type, payload);
  }

  private get aborted(): boolean {
    return this.ctx.controller.signal.aborted;
  }

  async run(): Promise<TurnOutcome> {
    const { emit } = this.ctx;
    try {
      this.history = await this.deps.store.listMessages(this.ctx.session.id);
      const settled = await this.settlePendingToolCalls();
      if (settled === "approval_pending") return this.outcome("approval_pending", "waiting");
      await this.acceptUserInput();
      if (this.history.length === 0) throw new Error("no message to answer");
      if (!this.ctx.session.title && this.ctx.text) await this.deps.store.setSessionTitle(this.ctx.session.id, this.ctx.text.slice(0, 80));
      return await this.loop();
    } catch (turnError) {
      const error = turnError instanceof Error ? turnError.message : String(turnError);
      emit({ type: "notice", message: `error: ${error}` });
      await this.log("error", { message: error });
      return this.outcome("error", "failed", error);
    }
  }

  private outcome(stopReason: string, status: RunRecord["status"], error: string | null = null): TurnOutcome {
    return { stopReason, status, assistantText: this.assistantText, iterations: this.iterations, error };
  }

  private async loop(): Promise<TurnOutcome> {
    const { emit } = this.ctx;
    while (true) {
      this.iterations++;
      if (this.iterations > this.deps.limits.maxIterations) return this.outcome("iteration_limit", "completed");
      if (Date.now() - this.started > this.deps.limits.maxDurationMs) return this.outcome("time_limit", "completed");
      if (this.aborted) return this.outcome("interrupted", "interrupted");

      emit({ type: "phase", phase: "assemble" });
      const request = await this.assembleRequest();

      const reservation = await this.reserveBudget(request);
      if (reservation && !reservation.allowed) return this.outcome("budget_exhausted", "waiting");

      emit({ type: "phase", phase: "call" });
      await this.log("phase", { phase: "call", iteration: this.iterations, model: this.ctx.primary.id });
      let result: CompletionOutcome;
      try {
        result = await this.callModel(request);
      } catch (callError) {
        if (reservation?.allowed) await this.deps.governance.budget?.release(reservation.reservationId);
        if (this.aborted) return this.outcome("interrupted", "interrupted");
        throw callError;
      }
      if (reservation?.allowed) await this.deps.governance.budget?.settle(reservation.reservationId, result.modelId, result.usage);

      emit({ type: "phase", phase: "read" });
      if (result.stopReason === "aborted" || this.aborted) {
        if (result.text) await this.append("assistant", [{ type: "text", text: result.text }], result.usage);
        return this.outcome("interrupted", "interrupted");
      }
      const content: ContentPart[] = [];
      if (result.text) content.push({ type: "text", text: result.text });
      content.push(...result.toolCalls);
      if (content.length === 0) {
        emit({ type: "notice", message: "the model answered empty twice" });
        return this.outcome("empty_response", "completed");
      }
      await this.append("assistant", content, result.usage);
      this.assistantText = result.text;
      await this.deps.store.updateRunProgress(this.ctx.run.id, { iterations: this.iterations, usage: result.usage });
      await this.log("model", { model: result.modelId, usage: result.usage, stopReason: result.stopReason, toolCalls: result.toolCalls.length });

      if (result.toolCalls.length === 0) return this.outcome(result.stopReason === "max_tokens" ? "output_limit" : "final_answer", "completed");

      emit({ type: "phase", phase: "tools" });
      const batch = await this.executeToolCalls(result.toolCalls, false);
      if (batch.kind === "suspended") return this.outcome(batch.stopReason, "waiting");
      await this.appendToolResults(batch.results);
      if (batch.endTurn) return this.outcome(batch.endTurn, batch.endTurn === "clarification_requested" ? "waiting" : "completed");
      if (this.aborted) return this.outcome("interrupted", "interrupted");
    }
  }

  private async assembleRequest() {
    const tools = this.deps.tools.definitionsFor
      ? await this.deps.tools.definitionsFor({ companyId: this.ctx.session.companyId, agentId: this.ctx.session.agentId })
      : this.deps.tools.definitions();
    return {
      system: this.ctx.session.systemPrompt,
      messages: this.history.map((m): Message => ({ role: m.role, content: m.content })),
      tools,
      maxOutputTokens: this.deps.maxOutputTokens,
      cachePrefix: true,
      signal: this.ctx.controller.signal,
    };
  }

  /** Budget before the call: the reservation is refused when a cap is reached, and the call never starts. */
  private async reserveBudget(request: Awaited<ReturnType<Turn["assembleRequest"]>>): Promise<BudgetDecision | null> {
    const budget = this.deps.governance.budget;
    if (!budget) return null;
    const { session, run, emit } = this.ctx;
    const context = { companyId: session.companyId, agentId: session.agentId, sessionId: session.id, runId: run.id, projectId: session.projectId, taskId: session.taskId };
    const decision = await budget.reserve(context, {
      modelId: this.ctx.primary.id,
      inputTokens: estimateInputTokens(request.system, request.messages),
      maxOutputTokens: request.maxOutputTokens,
    });
    if (decision.allowed) {
      for (const warning of decision.warnings) emit({ type: "notice", message: warning });
      return decision;
    }
    emit({ type: "budget_stop", scope: decision.scope, cap: decision.cap, spent: decision.spent, currency: decision.currency, reason: decision.reason });
    await this.log("budget_stop", { scope: decision.scope, cap: decision.cap, spent: decision.spent, currency: decision.currency });
    await this.deps.governance.onBudgetStop?.(context, decision);
    return decision;
  }

  private callModel(request: Awaited<ReturnType<Turn["assembleRequest"]>>): Promise<CompletionOutcome> {
    const { emit } = this.ctx;
    return completeWithRecovery(this.ctx.primary, this.ctx.fallback, request, (t) => emit({ type: "text", text: t }), {
      ...this.deps.recovery,
      onRetry: (attempt, delayMs, reason) => {
        emit({ type: "retry", attempt, delayMs, reason });
        void this.log("retry", { attempt, delayMs, reason });
      },
      onFallback: (from, to, reason) => {
        emit({ type: "fallback", from, to, reason });
        void this.log("fallback", { from, to, reason });
      },
    });
  }

  private async append(role: "user" | "assistant" | "tool", content: ContentPart[], usage?: CompletionOutcome["usage"]): Promise<StoredMessage> {
    const message = await this.deps.store.appendMessage(this.ctx.session, role, content, { runId: this.ctx.run.id, ...(usage ? { usage } : {}) });
    this.history.push(message);
    this.ctx.emit({ type: "message", message });
    return message;
  }

  private async appendToolResults(results: ContentToolResult[]): Promise<void> {
    const content: ContentPart[] = [...results];
    const injected = this.ctx.injections.splice(0);
    if (injected.length > 0) {
      content.push({ type: "text", text: injected.map((t) => `[operator message] ${t}`).join("\n") });
      await this.log("injection", { count: injected.length });
    }
    await this.append("tool", content);
  }

  /**
   * Tool calls left without a result by a previous turn: approved ones run now,
   * denied ones get a refusal, the rest (a restart) get an interruption result.
   * Never a replay of something already done.
   */
  private async settlePendingToolCalls(): Promise<"none" | "settled" | "approval_pending"> {
    const last = this.history.at(-1);
    if (!last || last.role !== "assistant") return "none";
    const calls = last.content.filter((p): p is ContentToolCall => p.type === "tool_call");
    if (calls.length === 0) return "none";

    const approvals = this.deps.governance.approvals;
    const decided = approvals ? await Promise.all(calls.map((c) => approvals.forToolCall(this.ctx.session.id, c.id))) : [];
    if (approvals && decided.some((a) => a !== null)) {
      if (decided.some((a) => a?.status === "pending")) {
        this.ctx.emit({ type: "notice", message: "waiting for an approval" });
        return "approval_pending";
      }
      const batch = await this.executeToolCalls(calls, true, new Map(calls.map((c, i) => [c.id, decided[i] ?? null])));
      if (batch.kind === "results") await this.appendToolResults(batch.results);
      return "settled";
    }

    const results: ContentToolResult[] = calls.map((call) => ({
      type: "tool_result",
      toolCallId: call.id,
      content: "Execution was interrupted by a restart before this tool completed: it was NOT re-run. Check the state and repeat only if needed.",
      isError: true,
    }));
    await this.append("tool", results);
    this.ctx.emit({ type: "notice", message: `${calls.length} tool calls interrupted by a restart, not re-run` });
    await this.log("no_replay", { toolCalls: calls.map((c) => c.name) });
    return "settled";
  }

  /** The person's message enters as a user message; if the last one is already a user message, it is appended to it (alternation). */
  private async acceptUserInput(): Promise<void> {
    const last = this.history.at(-1);
    const text = this.ctx.text;
    if (text === undefined || text === "") {
      if (last && last.role === "assistant") throw new Error("no new message: the agent has already answered");
      return;
    }
    const part: ContentPart = { type: "text", text };
    if (last && last.role === "user") {
      const merged = await this.deps.store.appendToMessage(last.id, [part]);
      this.history[this.history.length - 1] = merged;
      this.ctx.emit({ type: "message", message: merged });
      return;
    }
    await this.append("user", [part]);
  }

  private toolContext(call: ContentToolCall, approved: boolean): ToolContext {
    const { session, run } = this.ctx;
    return {
      sessionId: session.id,
      companyId: session.companyId,
      agentId: session.agentId,
      agentRole: this.ctx.agentRole,
      runId: run.id,
      callId: call.id,
      workdir: session.workdir ?? `${this.deps.workRoot}/${session.id}`,
      signal: this.ctx.controller.signal,
      approved,
      taskId: session.taskId,
    };
  }

  /**
   * Runs a batch of tool calls. Before running anything, every call is checked
   * with governance: if any needs a person's approval, the whole batch is
   * suspended (nothing executed) and approvals are requested.
   */
  private async executeToolCalls(calls: ContentToolCall[], resumed: boolean, decisions?: Map<string, { status: string; decisionNote: string | null } | null>): Promise<ToolBatch> {
    const { emit } = this.ctx;
    const approvals = this.deps.governance.approvals;
    if (!resumed && approvals && this.deps.tools.preflight) {
      const needed = [];
      for (const call of calls) {
        const need = await this.deps.tools.preflight(call.name, call.arguments, this.toolContext(call, false));
        if (need) needed.push({ call, need });
      }
      if (needed.length > 0) {
        for (const { call, need } of needed) {
          const record = await approvals.request({
            companyId: this.ctx.session.companyId,
            agentId: this.ctx.session.agentId,
            sessionId: this.ctx.session.id,
            runId: this.ctx.run.id,
            kind: need.kind,
            subject: { callId: call.id, tool: call.name, arguments: call.arguments, ...need.subject },
            reason: need.reason,
            risk: need.risk,
          });
          emit({ type: "approval_requested", approvalId: record.id, callId: call.id, name: call.name, reason: need.reason, risk: need.risk });
          await this.log("approval_requested", { approvalId: record.id, callId: call.id, name: call.name, reason: need.reason });
        }
        return { kind: "suspended", stopReason: "approval_pending" };
      }
    }

    const results: ContentToolResult[] = [];
    let endTurn: string | null = null;
    for (const call of calls) {
      const decision = decisions?.get(call.id) ?? null;
      if (decision && decision.status !== "approved") {
        results.push({ type: "tool_result", toolCallId: call.id, content: `Denied by the operator${decision.decisionNote ? `: ${decision.decisionNote}` : ""}.`, isError: true });
        emit({ type: "tool_result", callId: call.id, name: call.name, content: "denied", isError: true, durationMs: 0 });
        continue;
      }
      if (this.aborted || endTurn) {
        results.push({ type: "tool_result", toolCallId: call.id, content: "Not executed: turn interrupted.", isError: true });
        continue;
      }
      emit({ type: "tool_call", callId: call.id, name: call.name, arguments: call.arguments });
      await this.log("tool_call", { callId: call.id, name: call.name, arguments: call.arguments });
      const started = Date.now();
      const outcome = await this.deps.tools.execute(call.name, call.arguments, this.toolContext(call, decision?.status === "approved"));
      const durationMs = Date.now() - started;
      const isError = outcome.isError ?? false;
      results.push({ type: "tool_result", toolCallId: call.id, content: outcome.content, isError });
      emit({ type: "tool_result", callId: call.id, name: call.name, content: outcome.content, isError, durationMs });
      await this.log("tool_result", { callId: call.id, name: call.name, isError, durationMs, chars: outcome.content.length });
      if (outcome.endTurn) endTurn = outcome.endTurn.stopReason;
    }
    return { kind: "results", results, endTurn };
  }
}
