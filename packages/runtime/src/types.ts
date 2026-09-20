import type { ContentPart, Usage } from "@opifer/sdk";

export type SessionKind = "chat" | "task" | "routine";
export type SessionStatus = "active" | "suspended" | "closed";
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
  /** The task this session works on (kind "task"); null for chats. */
  taskId: string | null;
  /** The task's project, for the budget context. */
  projectId: string | null;
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

export type RunStatus = "running" | "completed" | "interrupted" | "failed" | "waiting";

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

/** Events emitted during a turn: for streaming (CLI, WebSocket) and for the run_events log. */
export type RuntimeEvent =
  | { type: "phase"; phase: string }
  | { type: "text"; text: string }
  | { type: "message"; message: StoredMessage }
  | { type: "tool_call"; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean; durationMs: number }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "notice"; message: string }
  | { type: "approval_requested"; approvalId: string; callId: string; name: string; reason: string; risk: "low" | "medium" | "high" }
  | { type: "budget_stop"; scope: string; cap: number; spent: number; currency: string; reason: string }
  | { type: "done"; run: RunRecord };

export type RuntimeEventListener = (event: RuntimeEvent) => void;
