/**
 * Anthropic (Claude) provider for Opifer: streaming, tool calling, token
 * counting and price list. The stable prefix (system prompt) is marked for
 * the provider cache.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, MessageStreamEvent, TextBlockParam, Tool, ToolResultBlockParam, ToolUseBlockParam } from "@anthropic-ai/sdk/resources/messages";
import {
  ProviderError,
  type CompletionRequest,
  type ContentToolCall,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type StreamEvent,
} from "@opifer/sdk";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  id?: string;
  /** Updatable price list: USD per million tokens, by model prefix. */
  prices?: Record<string, { input: number; output: number; cachedInput?: number }>;
}

/** Starting price list (USD per million tokens); updatable from configuration. */
export const DEFAULT_PRICES: Record<string, { input: number; output: number; cachedInput?: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 1 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
};

const KNOWN_MODELS: Array<{ id: string; contextWindow: number; maxOutputTokens: number; reasoning: boolean }> = [
  { id: "claude-fable-5-1", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "claude-opus-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "claude-sonnet-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "claude-haiku-4-5-20251001", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
];

function priceFor(model: string, prices: AnthropicProviderOptions["prices"]): ModelInfo["price"] {
  const table = { ...DEFAULT_PRICES, ...prices };
  const key = Object.keys(table).find((k) => model.startsWith(k));
  const p = key ? table[key]! : { input: 0, output: 0 };
  return { inputPerMillion: p.input, outputPerMillion: p.output, currency: "USD", ...(p.cachedInput !== undefined ? { cachedInputPerMillion: p.cachedInput } : {}) };
}

function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const content: Array<TextBlockParam | ToolUseBlockParam> = [];
      for (const part of m.content) {
        if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
        else if (part.type === "tool_call") content.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }
    // user and tool both travel as user messages: results as tool_result blocks
    const content: Array<TextBlockParam | ToolResultBlockParam> = [];
    for (const part of m.content) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      else if (part.type === "tool_result") {
        content.push({ type: "tool_result", tool_use_id: part.toolCallId, content: part.content, ...(part.isError ? { is_error: true } : {}) });
      }
    }
    if (content.length > 0) out.push({ role: "user", content });
  }
  return out;
}

function toAnthropicTools(request: CompletionRequest): Tool[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", ...(t.inputSchema as Record<string, unknown>) } as Tool["input_schema"],
  }));
}

function mapError(error: unknown): ProviderError {
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    if (status === 529) return new ProviderError(`Anthropic overloaded: ${error.message}`, "transient", status);
    return ProviderError.fromStatus(status, `Anthropic: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError(`Anthropic unreachable: ${error.message}`, "transient");
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("interrupted", "request");
  return new ProviderError(error instanceof Error ? error.message : String(error), "unknown");
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly prices: AnthropicProviderOptions["prices"];

  constructor(options: AnthropicProviderOptions = {}) {
    this.id = options.id ?? "anthropic";
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new ProviderError("missing Anthropic key (ANTHROPIC_API_KEY)", "auth");
    this.client = new Anthropic({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), maxRetries: 0 });
    this.prices = options.prices;
  }

  async listModels(): Promise<ModelInfo[]> {
    return KNOWN_MODELS.map((m) => ({
      id: m.id,
      capabilities: { contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, vision: true, reasoning: m.reasoning, toolCalling: true },
      price: priceFor(m.id, this.prices),
    }));
  }

  async countTokens(request: CompletionRequest): Promise<number> {
    try {
      const tools = toAnthropicTools(request);
      const result = await this.client.messages.countTokens({
        model: request.model,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...(tools ? { tools } : {}),
      });
      return result.input_tokens;
    } catch (error) {
      throw mapError(error);
    }
  }

  async *complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const tools = toAnthropicTools(request);
    const system: TextBlockParam[] = [{ type: "text", text: request.system, ...(request.cachePrefix ? { cache_control: { type: "ephemeral" } } : {}) }];
    let stream: AsyncIterable<MessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens ?? 8192,
          system,
          messages: toAnthropicMessages(request.messages),
          ...(tools ? { tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: true,
        },
        { ...(request.signal ? { signal: request.signal } : {}) },
      );
    } catch (error) {
      throw mapError(error);
    }

    const pending = new Map<number, { call: ContentToolCall; json: string }>();
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" = "end_turn";
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens;
            cachedInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
            break;
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              pending.set(event.index, { call: { type: "tool_call", id: event.content_block.id, name: event.content_block.name, arguments: {} }, json: "" });
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
            else if (event.delta.type === "input_json_delta") {
              const p = pending.get(event.index);
              if (p) p.json += event.delta.partial_json;
            }
            break;
          case "content_block_stop": {
            const p = pending.get(event.index);
            if (p) {
              p.call.arguments = p.json.trim() ? (JSON.parse(p.json) as Record<string, unknown>) : {};
              pending.delete(event.index);
              yield { type: "tool_call", call: p.call };
            }
            break;
          }
          case "message_delta":
            outputTokens = event.usage.output_tokens;
            if (event.delta.stop_reason === "tool_use") stopReason = "tool_use";
            else if (event.delta.stop_reason === "max_tokens") stopReason = "max_tokens";
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: "usage", usage: { inputTokens, outputTokens, cachedInputTokens } };
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      throw mapError(error);
    }
    yield { type: "usage", usage: { inputTokens, outputTokens, cachedInputTokens } };
    yield { type: "done", stopReason };
  }
}
