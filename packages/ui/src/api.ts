/** Minimal client of the /v1 API: same rules and same data as the CLI. */

export interface Health {
  status: "ok" | "degraded";
  version: string;
  mode: string;
  database: "ok" | "error";
  runtime?: "ok" | "absent";
  governance?: "ok" | "absent";
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
  runs: Array<{ id: string; status: string; stopReason: string | null; error: string | null; inputTokens: number; outputTokens: number }>;
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
  if (res.status === 204) return undefined as T;
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
  approvals: (companyId: string, status?: string) => request<Approval[]>(`/v1/companies/${companyId}/approvals${status ? `?status=${status}` : ""}`),
  decide: (approvalId: string, status: "approved" | "denied", note?: string, newCap?: number) =>
    request<Approval>(`/v1/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ status, ...(note ? { note } : {}), ...(newCap !== undefined ? { newCap } : {}) }) }),
  costs: (companyId: string) => request<CostReport>(`/v1/companies/${companyId}/costs`),
  setBudget: (companyId: string, input: { scopeKind: string; scopeId?: string; cap: number; window?: string; currency?: string }) =>
    request<BudgetPolicy>(`/v1/companies/${companyId}/budgets`, { method: "PUT", body: JSON.stringify(input) }),
  removeBudget: (companyId: string, policyId: string) => request<void>(`/v1/companies/${companyId}/budgets/${policyId}`, { method: "DELETE" }),
  permissions: (agentId: string) => request<ToolPermissionView[]>(`/v1/agents/${agentId}/permissions`),
  setToolPolicy: (companyId: string, input: { targetKind: string; targetId?: string; toolName: string; permission: string }) =>
    request<unknown>(`/v1/companies/${companyId}/tool-policies`, { method: "PUT", body: JSON.stringify(input) }),
  setAgentStatus: (agentId: string, status: "active" | "paused" | "archived") => request<{ status: string }>(`/v1/agents/${agentId}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  updateAgent: (agentId: string, patch: { name?: string; role?: string; model?: string | null; reportsToAgentId?: string | null; note?: string }) =>
    request<{ revision: number }>(`/v1/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  revisions: (agentId: string) => request<Array<{ revision: number; config: { name: string; role: string; model: string | null }; note: string | null; createdAt: string }>>(`/v1/agents/${agentId}/revisions`),
  restoreRevision: (agentId: string, revision: number) => request<{ revision: number }>(`/v1/agents/${agentId}/revisions/${revision}/restore`, { method: "POST" }),
  overview: (companyId: string) => request<Overview>(`/v1/companies/${companyId}/overview`),
  models: () => request<ModelsInfo>("/v1/models"),
  sessionsAll: (companyId: string) => request<Session[]>(`/v1/companies/${companyId}/sessions`),
};

export interface Approval {
  id: string;
  kind: string;
  status: "pending" | "approved" | "denied" | "expired";
  agentId: string | null;
  sessionId: string | null;
  subject: Record<string, unknown>;
  reason: string | null;
  risk: "low" | "medium" | "high";
  decisionNote: string | null;
  createdAt: string;
}

export interface BudgetPolicy {
  id: string;
  scopeKind: string;
  scopeId: string | null;
  window: string;
  cap: number;
  currency: string;
  warnRatio: number;
}

export interface CostReport {
  total: { usd: number; eur: number };
  byAgent: Array<{ agentId: string | null; agentName: string | null; usd: number; eur: number; calls: number }>;
  byModel: Array<{ model: string | null; usd: number; eur: number; calls: number; inputTokens: number; outputTokens: number }>;
  policies: BudgetPolicy[];
}

export interface ToolPermissionView {
  name: string;
  description: string;
  risk: string;
  permission: "automatic" | "approval" | "blocked";
  source: "agent" | "role" | "company" | "risk";
}

export type AgentActivity = "working" | "waiting" | "idle" | "paused" | "stopped";

export interface AgentView extends Agent {
  activity: AgentActivity;
  /** Title of the conversation or task the agent is on, if any. */
  doing: string | null;
  pendingApprovals: number;
  spend: { eur: number; usd: number; calls: number; cap: number | null; currency: string };
  lastActiveAt: string | null;
}

export interface RecentRun {
  id: string;
  sessionId: string;
  sessionTitle: string | null;
  agentId: string;
  status: string;
  stopReason: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  preview: string | null;
}

export interface ActivityEntry {
  id: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  subjectKind: string;
  subjectId: string | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface Overview {
  company: { id: string; name: string; mission: string | null };
  agents: AgentView[];
  pending: number;
  spend: { eur: number; usd: number; cap: number | null; currency: string; since: string };
  recentRuns: RecentRun[];
  activity: ActivityEntry[];
  working: number;
}

export interface ModelsInfo {
  default: string;
  fallback: string | null;
  providers: Array<{ id: string; enabled: boolean; detail: string }>;
  models: Array<{ id: string; provider: string; contextWindow: number; price: { inputPerMillion: number; outputPerMillion: number; currency: string } }>;
}

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
