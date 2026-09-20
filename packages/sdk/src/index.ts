/**
 * SDK di Opifer (MIT): i contratti che un plugin implementa.
 *
 * Il core parla con provider di modelli, canali, tool, ambienti di esecuzione,
 * memorie esterne e gestori di segreti solo attraverso queste interfacce.
 * In M0 sono definite le forme; le implementazioni arrivano con le milestone
 * successive (M1 provider, M5 canali e sandbox).
 */

export type PluginKind = "provider" | "channel" | "execution-environment" | "tool" | "memory" | "secrets" | "trace-exporter";

export interface PluginManifest {
  /** Nome del pacchetto, es. `@opifer/plugin-telegram`. */
  name: string;
  version: string;
  kind: PluginKind;
  /** Permessi che il plugin dichiara; l'installazione li mostra e li fa approvare. */
  permissions: readonly string[];
  /** Schema JSON della configurazione per azienda. */
  configSchema?: Record<string, unknown>;
}

// --- Provider di modelli (M1) ---------------------------------------------

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
}

export interface ModelPrice {
  /** Prezzo per milione di token, nella valuta indicata. */
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
  /** Il prefisso stabile (system + istantanea) può essere marcato per la cache del provider. */
  cachePrefix?: boolean;
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
  /** Identificativo del provider, prefisso dei modelli: `anthropic/claude-...`. */
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  /** Stima dei token in ingresso; i provider senza contatore usano un'approssimazione. */
  countTokens(request: CompletionRequest): Promise<number>;
  complete(request: CompletionRequest): AsyncIterable<StreamEvent>;
}

export type ProviderErrorKind = "transitorio" | "limite" | "autenticazione" | "richiesta" | "sconosciuto";

/** Errore di un provider, classificato per decidere ritentativi e riserva. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  constructor(message: string, kind: ProviderErrorKind, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
  /** Transitori e limiti di velocità si ritentano; il resto no. */
  get retryable(): boolean {
    return this.kind === "transitorio" || this.kind === "limite";
  }
  static fromStatus(status: number, message: string): ProviderError {
    if (status === 401 || status === 403) return new ProviderError(message, "autenticazione", status);
    if (status === 429) return new ProviderError(message, "limite", status);
    if (status === 408 || status === 409 || status >= 500) return new ProviderError(message, "transitorio", status);
    if (status >= 400) return new ProviderError(message, "richiesta", status);
    return new ProviderError(message, "sconosciuto", status);
  }
}

// --- Ambienti di esecuzione (M0 interfaccia, M5 Docker) --------------------

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

// --- Canali (M5) -----------------------------------------------------------

export interface InboundMessage {
  channelId: string;
  externalChatId: string;
  externalSenderId: string;
  text: string;
  attachments?: Array<{ name: string; mimeType: string; bytes: Uint8Array }>;
}

export interface OutboundMessage {
  externalChatId: string;
  text: string;
  /** Pulsanti di approvazione e comandi di controllo, dove il canale li supporta. */
  actions?: Array<{ id: string; label: string }>;
}

export interface Channel {
  readonly id: string;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

export const SDK_VERSION = "0.0.1";
