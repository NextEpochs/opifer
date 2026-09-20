/** Minimal client of the /v1 API: same rules and same data as the CLI. */

export interface Health {
  status: "ok" | "degraded";
  version: string;
  mode: string;
  database: "ok" | "error";
}

export interface Company {
  id: string;
  name: string;
  mission: string | null;
  status: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsToAgentId: string | null;
  model: string | null;
  status: string;
  currentRevision: number;
}

export interface Session {
  id: string;
  companyId: string;
  agentId: string;
  kind: string;
  title: string | null;
  model: string;
  status: string;
  createdAt: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
  createdAt: string;
}

export interface SessionDetail extends Session {
  running: boolean;
  messages: StoredMessage[];
  runs: Array<{ id: string; status: string; stopReason: string | null; inputTokens: number; outputTokens: number }>;
}

export interface AuditEntry {
  id: string;
  actorKind: string;
  action: string;
  subjectKind: string;
  subjectId: string | null;
  occurredAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>("/v1/health"),
  companies: () => request<Company[]>("/v1/companies"),
  createCompany: (name: string, mission?: string) =>
    request<Company>("/v1/companies", { method: "POST", body: JSON.stringify(mission ? { name, mission } : { name }) }),
  agents: (companyId: string) => request<Agent[]>(`/v1/companies/${companyId}/agents`),
  createAgent: (companyId: string, input: { name: string; role?: string; reportsToAgentId?: string }) =>
    request<Agent>(`/v1/companies/${companyId}/agents`, { method: "POST", body: JSON.stringify(input) }),
  audit: (companyId: string) => request<AuditEntry[]>(`/v1/companies/${companyId}/audit?limit=20`),
  sessions: (companyId: string) => request<Session[]>(`/v1/companies/${companyId}/sessions`),
  createSession: (companyId: string, agentId: string) => request<Session>(`/v1/companies/${companyId}/sessions`, { method: "POST", body: JSON.stringify({ agentId }) }),
  session: (id: string) => request<SessionDetail>(`/v1/sessions/${id}`),
  sendMessage: (id: string, text: string) => request<{ accepted: string }>(`/v1/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  interrupt: (id: string) => request<{ interrupted: boolean }>(`/v1/sessions/${id}/interrupt`, { method: "POST" }),
};

export interface BusEvent {
  type: string;
  companyId: string | null;
  payload?: unknown;
}

export function eventsSocket(onEvent: (event: BusEvent) => void, onState: (open: boolean) => void): () => void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/v1/events`);
  socket.onopen = () => onState(true);
  socket.onclose = () => onState(false);
  socket.onerror = () => onState(false);
  socket.onmessage = (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as BusEvent);
    } catch {
      // invalid message: ignored
    }
  };
  return () => socket.close();
}
