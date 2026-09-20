/**
 * Provider OpenAI per Opifer (API Chat Completions con streaming e tool
 * calling). La stessa classe, con `baseURL` diverso, serve gli endpoint
 * compatibili OpenAI (vedi @opifer/provider-openai-compatible).
 */

import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  ProviderError,
  type CompletionRequest,
  type ContentToolCall,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type StreamEvent,
} from "@opifer/sdk";

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  id?: string;
  /** Listino aggiornabile: prezzi in USD per milione di token, per prefisso di modello. */
  prices?: Record<string, { input: number; output: number; cachedInput?: number }>;
  /** Modelli da elencare quando l'endpoint non li espone (o per limitarli). */
  models?: string[];
  /** Finestra di contesto di default per i modelli sconosciuti. */
  defaultContextWindow?: number;
  /** Alcuni endpoint locali non accettano il ruolo "developer" né i tool: si adattano da qui. */
  compat?: { systemRole?: "system" | "developer"; tools?: boolean; streamUsage?: boolean };
}

/** Listino di partenza (USD per milione di token); aggiornabile da configurazione. */
export const DEFAULT_PRICES: Record<string, { input: number; output: number; cachedInput?: number }> = {
  "gpt-6": { input: 10, output: 50, cachedInput: 1 },
  "gpt-5.6-sol": { input: 4, output: 20, cachedInput: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, cachedInput: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cachedInput: 0.175 },
};

function priceFor(model: string, prices: OpenAIProviderOptions["prices"]): ModelInfo["price"] {
  const table = { ...DEFAULT_PRICES, ...prices };
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const p = key ? table[key]! : { input: 0, output: 0 };
  return { inputPerMillion: p.input, outputPerMillion: p.output, currency: "USD", ...(p.cachedInput !== undefined ? { cachedInputPerMillion: p.cachedInput } : {}) };
}

function toOpenAIMessages(request: CompletionRequest, systemRole: "system" | "developer"): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: systemRole, content: request.system }];
  for (const m of request.messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const text = m.content.filter((p): p is Extract<Message["content"][number], { type: "text" }> => p.type === "text").map((p) => p.text).join("");
      const calls = m.content.filter((p): p is ContentToolCall => p.type === "tool_call");
      const msg: ChatCompletionAssistantMessageParam = { role: "assistant", content: text || null };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      }
      out.push(msg);
      continue;
    }
    if (m.role === "tool") {
      const texts: string[] = [];
      for (const part of m.content) {
        if (part.type === "tool_result") out.push({ role: "tool", tool_call_id: part.toolCallId, content: part.content });
        else if (part.type === "text") texts.push(part.text);
      }
      // testo iniettato a metà turno: dopo i risultati, come messaggio utente
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
      continue;
    }
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function toOpenAITools(request: CompletionRequest): ChatCompletionTool[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function mapError(error: unknown, label: string): ProviderError {
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    return ProviderError.fromStatus(status, `${label}: ${error.message}`);
  }
  if (error instanceof OpenAI.APIConnectionError) return new ProviderError(`${label} non raggiungibile: ${error.message}`, "transitorio");
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("interrotto", "richiesta");
  return new ProviderError(error instanceof Error ? error.message : String(error), "sconosciuto");
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions = {}) {
    this.id = options.id ?? "openai";
    this.options = options;
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"];
    if (!apiKey && !options.baseURL) throw new ProviderError("chiave OpenAI mancante (OPENAI_API_KEY)", "autenticazione");
    this.client = new OpenAI({ apiKey: apiKey ?? "non-richiesta", ...(options.baseURL ? { baseURL: options.baseURL } : {}), maxRetries: 0 });
  }

  async listModels(): Promise<ModelInfo[]> {
    let ids = this.options.models;
    if (!ids) {
      try {
        const page = await this.client.models.list();
        ids = [];
        for await (const m of page) ids.push(m.id);
        ids.sort();
      } catch (error) {
        throw mapError(error, this.id);
      }
    }
    return ids.map((id) => ({
      id,
      capabilities: { contextWindow: this.options.defaultContextWindow ?? 128_000, maxOutputTokens: 16_384, vision: false, reasoning: false, toolCalling: this.options.compat?.tools !== false },
      price: priceFor(id, this.options.prices),
    }));
  }

  async countTokens(request: CompletionRequest): Promise<number> {
    // Nessun contatore remoto per le chat completions: approssimazione a 4 caratteri per token.
    const chars = request.system.length + request.messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    return Math.ceil(chars / 4);
  }

  async *complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const tools = this.options.compat?.tools === false ? undefined : toOpenAITools(request);
    const streamUsage = this.options.compat?.streamUsage !== false;
    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: toOpenAIMessages(request, this.options.compat?.systemRole ?? "system"),
          ...(tools ? { tools } : {}),
          ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: true,
          ...(streamUsage ? { stream_options: { include_usage: true } } : {}),
        },
        { ...(request.signal ? { signal: request.signal } : {}) },
      );
    } catch (error) {
      throw mapError(error, this.id);
    }

    const pending = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) yield { type: "text_delta", text: choice.delta.content };
        for (const tc of choice.delta.tool_calls ?? []) {
          const slot = pending.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: "", json: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.json += tc.function.arguments;
          pending.set(tc.index, slot);
        }
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
        else if (choice.finish_reason === "length") stopReason = "max_tokens";
      }
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: "usage", usage };
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      throw mapError(error, this.id);
    }
    for (const [, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      try {
        args = slot.json.trim() ? (JSON.parse(slot.json) as Record<string, unknown>) : {};
      } catch {
        args = { _raw: slot.json };
      }
      yield { type: "tool_call", call: { type: "tool_call", id: slot.id, name: slot.name, arguments: args } };
    }
    if (pending.size > 0 && stopReason === "end_turn") stopReason = "tool_use";
    yield { type: "usage", usage };
    yield { type: "done", stopReason };
  }
}
