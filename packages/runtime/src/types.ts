import type { ContentPart, Usage } from "@opifer/sdk";

export type SessionKind = "chat" | "task" | "routine";
export type SessionStatus = "attiva" | "sospesa" | "chiusa";
export type StoredRole = "user" | "assistant" | "tool";

export interface SessionRecord {
  id: string;
  companyId: string;
  agentId: string;
  kind: SessionKind;
  title: string | null;
  systemPrompt: string;
  systemPromptHash: string;
  model: string;
  fallbackModel: string | null;
  status: SessionStatus;
  workdir: string | null;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  seq: number;
  role: StoredRole;
  content: ContentPart[];
  usage: Usage | null;
  createdAt: string;
}

export type RunStatus = "in_corso" | "conclusa" | "interrotta" | "fallita" | "in_attesa";

export interface RunRecord {
  id: string;
  companyId: string;
  sessionId: string;
  agentId: string;
  status: RunStatus;
  stopReason: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Eventi emessi durante un turno: per streaming (CLI, WebSocket) e per il registro run_events. */
export type RuntimeEvent =
  | { type: "fase"; phase: string }
  | { type: "testo"; text: string }
  | { type: "messaggio"; message: StoredMessage }
  | { type: "tool_chiamata"; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_risultato"; callId: string; name: string; content: string; isError: boolean; durationMs: number }
  | { type: "ritentativo"; attempt: number; delayMs: number; reason: string }
  | { type: "riserva"; from: string; to: string; reason: string }
  | { type: "avviso"; message: string }
  | { type: "fine"; run: RunRecord };

export type RuntimeEventListener = (event: RuntimeEvent) => void;
