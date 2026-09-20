/**
 * ChatGPT subscription provider: OpenAI models billed to a ChatGPT plan
 * instead of an API key. Requests use the Responses API on the ChatGPT
 * backend that the Codex CLI uses, with the OAuth access token.
 *
 * Terms note: OpenAI publicly tolerates third-party tools signing in this
 * way, but nothing in its terms guarantees it. Each person must use their
 * own account and keep the credentials private.
 */

import { randomUUID } from "node:crypto";
import {
  ProviderError,
  type CompletionRequest,
  type ContentToolCall,
  type ModelInfo,
  type ModelProvider,
  type StreamEvent,
} from "@opifer/sdk";
import type { ChatGPTCredentials, CredentialStore } from "./credentials.js";
import { DEFAULT_OAUTH, refreshCredentials, type OAuthEndpoints } from "./oauth.js";

export interface ChatGPTProviderOptions {
  store: CredentialStore;
  id?: string;
  /** Backend base URL; defaults to the ChatGPT Codex backend. */
  baseURL?: string;
  oauth?: OAuthEndpoints;
  /** Models to offer when the backend does not list them. */
  models?: string[];
  /** Reasoning effort sent to reasoning models. */
  reasoningEffort?: "low" | "medium" | "high";
  fetch?: typeof fetch;
}

export const CHATGPT_BACKEND_URL = "https://chatgpt.com/backend-api/codex";

/** Models commonly available to ChatGPT plans through the Codex backend; the backend list, when reachable, wins. */
export const DEFAULT_CHATGPT_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.3-codex"];

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type ResponsesItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toResponsesInput(request: CompletionRequest): ResponsesItem[] {
  const items: ResponsesItem[] = [];
  for (const m of request.messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const part of m.content) {
        if (part.type === "tool_call") items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
      }
      continue;
    }
    if (m.role === "tool") {
      const texts: string[] = [];
      for (const part of m.content) {
        if (part.type === "tool_result") items.push({ type: "function_call_output", call_id: part.toolCallId, output: part.content });
        else if (part.type === "text") texts.push(part.text);
      }
      if (texts.length > 0) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: texts.join("\n") }] });
      continue;
    }
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (text) items.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  return items;
}

/** Minimal SSE reader: yields the JSON of every `data:` line. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // a partial or non-JSON line: skipped
        }
      }
    }
  }
}

export class ChatGPTProvider implements ModelProvider {
  readonly id: string;
  private readonly options: ChatGPTProviderOptions;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private cached: ChatGPTCredentials | null = null;
  private refreshing: Promise<ChatGPTCredentials> | null = null;

  constructor(options: ChatGPTProviderOptions) {
    this.id = options.id ?? "chatgpt";
    this.options = options;
    this.baseURL = (options.baseURL ?? CHATGPT_BACKEND_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Valid credentials, refreshed when close to expiry; one refresh at a time. */
  async credentials(): Promise<ChatGPTCredentials> {
    const current = this.cached ?? (await this.options.store.load());
    if (!current) throw new ProviderError("not signed in to ChatGPT: run `o4r login chatgpt`", "auth");
    this.cached = current;
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current;
    if (!this.refreshing) {
      this.refreshing = refreshCredentials(current, this.options.oauth ?? DEFAULT_OAUTH, this.fetchImpl)
        .then(async (next) => {
          await this.options.store.save(next);
          this.cached = next;
          return next;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async headers(): Promise<Record<string, string>> {
    const creds = await this.credentials();
    return {
      authorization: `Bearer ${creds.accessToken}`,
      "chatgpt-account-id": creds.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: (this.options.oauth ?? DEFAULT_OAUTH).originator,
      "content-type": "application/json",
      accept: "text/event-stream",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    let ids = this.options.models;
    if (!ids) {
      try {
        const response = await this.fetchImpl(`${this.baseURL}/models`, { headers: await this.headers() });
        if (response.ok) {
          const body = (await response.json()) as { models?: Array<{ slug?: string; id?: string }>; data?: Array<{ id: string }> };
          const list = body.models ?? body.data ?? [];
          ids = list.map((m) => ("slug" in m && m.slug ? m.slug : (m as { id?: string }).id)).filter((id): id is string => Boolean(id));
        }
      } catch {
        // the backend list is a convenience: fall back to the known models
      }
      if (!ids || ids.length === 0) ids = DEFAULT_CHATGPT_MODELS;
    }
    return ids.map((id) => ({
      id,
      capabilities: { contextWindow: 200_000, maxOutputTokens: 32_000, vision: true, reasoning: true, toolCalling: true },
      // Billed to the subscription: no per-token price.
      price: { inputPerMillion: 0, outputPerMillion: 0, currency: "USD" },
    }));
  }

  async countTokens(request: CompletionRequest): Promise<number> {
    const chars = request.system.length + request.messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    return Math.ceil(chars / 4);
  }

  async *complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const tools = (request.tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.system,
      input: toResponsesInput(request),
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: this.options.reasoningEffort ?? "medium", summary: "auto" },
      // The Codex backend rejects max_output_tokens ("Unsupported parameter"): the plan's limits apply instead.
    };

    const headers = { ...(await this.headers()), session_id: randomUUID() };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      throw new ProviderError(`ChatGPT backend unreachable: ${error instanceof Error ? error.message : String(error)}`, "transient");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw ProviderError.fromStatus(response.status, `ChatGPT backend: ${text.slice(0, 300) || response.statusText}`);
    }

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let sawToolCall = false;
    try {
      for await (const event of readSse(response.body)) {
        const type = event["type"];
        if (type === "response.output_text.delta") {
          yield { type: "text_delta", text: String(event["delta"] ?? "") };
        } else if (type === "response.output_item.done") {
          const item = event["item"] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type === "function_call" && item.name) {
            sawToolCall = true;
            let args: Record<string, unknown> = {};
            try {
              args = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
            } catch {
              args = { _raw: item.arguments };
            }
            const call: ContentToolCall = { type: "tool_call", id: item.call_id ?? randomUUID(), name: item.name, arguments: args };
            yield { type: "tool_call", call };
          }
        } else if (type === "response.completed" || type === "response.incomplete") {
          const resp = event["response"] as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; incomplete_details?: { reason?: string } } | undefined;
          if (resp?.usage) {
            usage = {
              inputTokens: resp.usage.input_tokens ?? 0,
              outputTokens: resp.usage.output_tokens ?? 0,
              cachedInputTokens: resp.usage.input_tokens_details?.cached_tokens ?? 0,
            };
          }
          if (type === "response.incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") stopReason = "max_tokens";
        } else if (type === "response.failed" || type === "error") {
          const err = (event["response"] as { error?: { message?: string } } | undefined)?.error ?? (event["error"] as { message?: string } | undefined);
          throw new ProviderError(`ChatGPT backend: ${err?.message ?? "response failed"}`, "transient");
        }
      }
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: "usage", usage };
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      throw error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : String(error), "transient");
    }
    if (sawToolCall && stopReason === "end_turn") stopReason = "tool_use";
    yield { type: "usage", usage };
    yield { type: "done", stopReason };
  }
}
