/**
 * Opifer SDK (MIT): the contracts a plugin implements.
 *
 * The core talks to model providers, channels, tools, execution environments,
 * external memories and secret managers only through these interfaces.
 * In M0 the shapes are defined; the implementations arrive with the later
 * milestones (M1 providers, M5 channels and sandbox).
 */

export type PluginKind = "provider" | "channel" | "execution-environment" | "tool" | "memory" | "secrets" | "trace-exporter";

export interface PluginManifest {
  /** Package name, e.g. `@opifer/plugin-telegram`. */
  name: string;
  version: string;
  kind: PluginKind;
  /** Permissions the plugin declares; installation shows them and asks for approval. */
  permissions: readonly string[];
  /** JSON schema of the per-company configuration. */
  configSchema?: Record<string, unknown>;
}

// --- Model providers (M1) -------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ContentText {
  type: "text";
  text: string;
}

export interface ContentToolCall {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ContentToolResult {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ContentPart = ContentText | ContentToolCall | ContentToolResult;

export interface Message {
  role: MessageRole;
  content: ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
  toolCalling: boolean;
  /** The provider can let the model search the web with a tool of its own (no key of ours needed). */
  webSearch?: boolean;
}

export interface ModelPrice {
  /** Price per million tokens, in the indicated currency. */
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  currency: "EUR" | "USD";
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  /** The stable prefix (system + snapshot) can be marked for the provider's cache. */
  cachePrefix?: boolean;
  /** Let the model search the web with the provider's own tool, where there is one (ChatGPT, Anthropic). */
  webSearch?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ContentToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" };

export interface ModelInfo {
  id: string;
  capabilities: ModelCapabilities;
  price: ModelPrice;
}

export interface ModelProvider {
  /** Provider identifier, prefix of the models: `anthropic/claude-...`. */
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  /** Estimate of the input tokens; providers without a counter use an approximation. */
  countTokens(request: CompletionRequest): Promise<number>;
  complete(request: CompletionRequest): AsyncIterable<StreamEvent>;
}

/** Turns texts into vectors for semantic search; a provider may offer one. */
export interface Embedder {
  /** Identifier, `provider/model`. */
  readonly id: string;
  /** Vector length. */
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** A provider that can also embed. */
export interface EmbeddingProvider {
  embedder(model?: string): Embedder;
}

export type ProviderErrorKind = "transient" | "rate_limit" | "auth" | "request" | "unknown";

/** Provider error, classified to decide retries and fallback. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  constructor(message: string, kind: ProviderErrorKind, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
  /** Transient errors and rate limits are retried; the rest are not. */
  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limit";
  }
  static fromStatus(status: number, message: string): ProviderError {
    if (status === 401 || status === 403) return new ProviderError(message, "auth", status);
    if (status === 429) return new ProviderError(message, "rate_limit", status);
    if (status === 408 || status === 409 || status >= 500) return new ProviderError(message, "transient", status);
    if (status >= 400) return new ProviderError(message, "request", status);
    return new ProviderError(message, "unknown", status);
  }
}

// --- Execution environments (M0 interface, M5 Docker) ----------------------

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecutionEnvironment {
  readonly id: string;
  prepare(workdir: string): Promise<void>;
  run(command: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<CommandResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  dispose(): Promise<void>;
}

// --- Channels (M5) ---------------------------------------------------------

export interface InboundMessage {
  channelId: string;
  externalChatId: string;
  externalSenderId: string;
  /** How the sender calls themself on the platform. */
  senderName?: string;
  text: string;
  /** A tapped button (an approval, a control command) instead of text. */
  actionId?: string;
  attachments?: Array<{ name: string; mimeType: string; bytes: Uint8Array }>;
}

export interface OutboundMessage {
  externalChatId: string;
  text: string;
  /** Approval buttons and control commands, where the channel supports them. */
  actions?: Array<{ id: string; label: string }>;
  /** Markdown-ish text: the channel renders what it can. */
  markdown?: boolean;
}

export interface Channel {
  readonly id: string;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

export const SDK_VERSION = "0.1.0";
