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
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

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
  runs: Array<{
    id: string;
    status: string;
    stopReason: string | null;
    error: string | null;
    inputTokens: number;
    outputTokens: number;
  }>;
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
  // A JSON content type without a body is refused by the server: bodiless POSTs go without it.
  const res = await fetch(url, {
    ...init,
    headers:
      init?.body !== undefined ? { "content-type": "application/json" } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(
      body.error ?? body.message ?? `${res.status} ${res.statusText}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>("/v1/health"),
  companies: () => request<Company[]>("/v1/companies"),
  createCompany: (name: string, mission?: string) =>
    request<Company>("/v1/companies", {
      method: "POST",
      body: JSON.stringify(mission ? { name, mission } : { name }),
    }),
  agents: (companyId: string) =>
    request<Agent[]>(`/v1/companies/${companyId}/agents`),
  createAgent: (
    companyId: string,
    input: { name: string; role?: string; reportsToAgentId?: string },
  ) =>
    request<Agent>(`/v1/companies/${companyId}/agents`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  audit: (companyId: string) =>
    request<AuditEntry[]>(`/v1/companies/${companyId}/audit?limit=20`),
  sessions: (companyId: string) =>
    request<Session[]>(`/v1/companies/${companyId}/sessions`),
  createSession: (companyId: string, agentId: string) =>
    request<Session>(`/v1/companies/${companyId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
  session: (id: string) => request<SessionDetail>(`/v1/sessions/${id}`),
  sendMessage: (id: string, text: string) =>
    request<{ accepted: string }>(`/v1/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  interrupt: (id: string) =>
    request<{ interrupted: boolean }>(`/v1/sessions/${id}/interrupt`, {
      method: "POST",
    }),
  approvals: (companyId: string, status?: string) =>
    request<Approval[]>(
      `/v1/companies/${companyId}/approvals${status ? `?status=${status}` : ""}`,
    ),
  decide: (
    approvalId: string,
    status: "approved" | "denied",
    note?: string,
    newCap?: number,
  ) =>
    request<Approval>(`/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({
        status,
        ...(note ? { note } : {}),
        ...(newCap !== undefined ? { newCap } : {}),
      }),
    }),
  costs: (companyId: string) =>
    request<CostReport>(`/v1/companies/${companyId}/costs`),
  setBudget: (
    companyId: string,
    input: {
      scopeKind: string;
      scopeId?: string;
      cap: number;
      window?: string;
      currency?: string;
    },
  ) =>
    request<BudgetPolicy>(`/v1/companies/${companyId}/budgets`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  removeBudget: (companyId: string, policyId: string) =>
    request<void>(`/v1/companies/${companyId}/budgets/${policyId}`, {
      method: "DELETE",
    }),
  permissions: (agentId: string) =>
    request<ToolPermissionView[]>(`/v1/agents/${agentId}/permissions`),
  setToolPolicy: (
    companyId: string,
    input: {
      targetKind: string;
      targetId?: string;
      toolName: string;
      permission: string;
    },
  ) =>
    request<unknown>(`/v1/companies/${companyId}/tool-policies`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  setAgentStatus: (agentId: string, status: "active" | "paused" | "archived") =>
    request<{ status: string }>(`/v1/agents/${agentId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  updateAgent: (
    agentId: string,
    patch: {
      name?: string;
      role?: string;
      model?: string | null;
      reportsToAgentId?: string | null;
      note?: string;
    },
  ) =>
    request<{ revision: number }>(`/v1/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  revisions: (agentId: string) =>
    request<
      Array<{
        revision: number;
        config: { name: string; role: string; model: string | null };
        note: string | null;
        createdAt: string;
      }>
    >(`/v1/agents/${agentId}/revisions`),
  restoreRevision: (agentId: string, revision: number) =>
    request<{ revision: number }>(
      `/v1/agents/${agentId}/revisions/${revision}/restore`,
      { method: "POST" },
    ),
  overview: (companyId: string) =>
    request<Overview>(`/v1/companies/${companyId}/overview`),
  models: () => request<ModelsInfo>("/v1/models"),
  sessionsAll: (companyId: string) =>
    request<Session[]>(`/v1/companies/${companyId}/sessions`),
  // work
  tasks: (
    companyId: string,
    query: { status?: string; agentId?: string; projectId?: string } = {},
  ) => {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v) as [string, string][],
    );
    return request<Task[]>(`/v1/companies/${companyId}/tasks?${params}`);
  },
  task: (id: string) => request<TaskDetail>(`/v1/tasks/${id}`),
  createTask: (
    companyId: string,
    input: {
      title: string;
      description?: string;
      acceptance?: string;
      priority?: TaskPriority;
      projectId?: string | null;
      goalId?: string | null;
      parentId?: string | null;
      assigneeAgentId?: string | null;
      dueAt?: string | null;
    },
  ) =>
    request<Task>(`/v1/companies/${companyId}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTask: (
    id: string,
    patch: Partial<
      Pick<
        Task,
        | "title"
        | "description"
        | "acceptance"
        | "priority"
        | "projectId"
        | "goalId"
        | "dueAt"
      >
    >,
  ) =>
    request<Task>(`/v1/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  taskAction: (
    id: string,
    action:
      | "assign"
      | "complete"
      | "request-changes"
      | "block"
      | "unblock"
      | "cancel"
      | "release"
      | "wake",
    body: Record<string, unknown> = {},
  ) =>
    request<Task>(`/v1/tasks/${id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  commentTask: (id: string, body: string) =>
    request<TaskComment>(`/v1/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  goals: (companyId: string) =>
    request<Goal[]>(`/v1/companies/${companyId}/goals`),
  createGoal: (
    companyId: string,
    input: { title: string; measure?: string; parentId?: string | null },
  ) =>
    request<Goal>(`/v1/companies/${companyId}/goals`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGoal: (
    companyId: string,
    id: string,
    patch: Partial<Pick<Goal, "title" | "measure" | "status">>,
  ) =>
    request<Goal>(`/v1/companies/${companyId}/goals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  projects: (companyId: string) =>
    request<Project[]>(`/v1/companies/${companyId}/projects`),
  createProject: (
    companyId: string,
    input: { name: string; description?: string; goalId?: string | null },
  ) =>
    request<Project>(`/v1/companies/${companyId}/projects`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  // learning
  memories: (
    companyId: string,
    query: {
      agent?: string;
      scope?: Scope;
      scopeAgentId?: string;
      status?: string;
      q?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") params.set(k, String(v));
    return request<Memory[]>(`/v1/companies/${companyId}/memories?${params}`);
  },
  saveMemory: (
    companyId: string,
    input: {
      scope: Scope;
      scopeAgentId?: string | null;
      kind?: "note" | "profile";
      subject?: string;
      content: string;
      pinned?: boolean;
    },
  ) =>
    request<Memory>(`/v1/companies/${companyId}/memories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  memoryAction: (
    companyId: string,
    id: string,
    action: "correct" | "retire" | "pin" | "promote",
    body: Record<string, unknown>,
  ) =>
    request<Memory | Promotion>(
      `/v1/companies/${companyId}/memories/${id}/${action}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  skills: (
    companyId: string,
    query: {
      agent?: string;
      scope?: Scope;
      scopeAgentId?: string;
      status?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") params.set(k, String(v));
    return request<Skill[]>(`/v1/companies/${companyId}/skills?${params}`);
  },
  skill: (companyId: string, id: string) =>
    request<SkillDetail>(`/v1/companies/${companyId}/skills/${id}`),
  skillVersion: (companyId: string, id: string, version: number) =>
    request<{ version: number; content: string; note: string }>(
      `/v1/companies/${companyId}/skills/${id}/versions/${version}`,
    ),
  createSkill: (
    companyId: string,
    input: {
      scope: Scope;
      scopeAgentId?: string | null;
      name: string;
      description: string;
      content: string;
      pinned?: boolean;
    },
  ) =>
    request<Skill>(`/v1/companies/${companyId}/skills`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateSkill: (
    companyId: string,
    id: string,
    input: { description?: string; content: string; note?: string },
  ) =>
    request<{ skill: Skill; version: { version: number } }>(
      `/v1/companies/${companyId}/skills/${id}/versions`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  restoreSkill: (companyId: string, id: string, version: number) =>
    request<{ skill: Skill; version: { version: number } }>(
      `/v1/companies/${companyId}/skills/${id}/versions/${version}/restore`,
      { method: "POST", body: "{}" },
    ),
  skillStatus: (companyId: string, id: string, status: Skill["status"]) =>
    request<Skill>(`/v1/companies/${companyId}/skills/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  pinSkill: (companyId: string, id: string, pinned: boolean) =>
    request<Skill>(`/v1/companies/${companyId}/skills/${id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned }),
    }),
  promoteSkill: (companyId: string, id: string) =>
    request<Promotion>(`/v1/companies/${companyId}/skills/${id}/promote`, {
      method: "POST",
      body: JSON.stringify({ toScope: "company" }),
    }),
  learningReviews: (companyId: string, agent?: string) =>
    request<LearningReview[]>(
      `/v1/companies/${companyId}/learning/reviews?limit=40${agent ? `&agent=${agent}` : ""}`,
    ),
  learningSettings: (companyId: string) =>
    request<LearningSettings>(`/v1/companies/${companyId}/learning`),
  updateLearningSettings: (
    companyId: string,
    patch: Partial<Omit<LearningSettings, "semanticSearch">>,
  ) =>
    request<LearningSettings>(`/v1/companies/${companyId}/learning`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  promotions: (companyId: string) =>
    request<Promotion[]>(`/v1/companies/${companyId}/promotions`),
};

// --- Learning (M4) -----------------------------------------------------------

export type Scope = "agent" | "team" | "company";

export interface Memory {
  id: string;
  scope: Scope;
  scopeAgentId: string | null;
  kind: "note" | "profile";
  subject: string;
  content: string;
  status: "active" | "retired" | "superseded";
  supersedesId: string | null;
  pinned: boolean;
  sourceSessionId: string | null;
  sourceTaskId: string | null;
  authorKind: "person" | "agent" | "system";
  authorId: string | null;
  retiredReason: string | null;
  createdAt: string;
  score?: number;
}

export interface Skill {
  id: string;
  scope: Scope;
  scopeAgentId: string | null;
  name: string;
  description: string;
  tags: string[];
  origin: "agent" | "person" | "imported";
  status: "active" | "inactive" | "archived";
  pinned: boolean;
  currentVersion: number;
  uses: number;
  lastUsedAt: string | null;
  promotedFromId: string | null;
  createdByKind: "person" | "agent" | "system";
  createdAt: string;
}

export interface SkillDetail extends Skill {
  version: {
    version: number;
    content: string;
    note: string;
    files: Record<string, string>;
  } | null;
  versions: Array<{
    version: number;
    note: string;
    createdAt: string;
    createdByKind: string;
    description: string;
  }>;
  usage: {
    successes: number;
    failures: number;
    recent: Array<{
      taskId: string | null;
      outcome: string;
      createdAt: string;
    }>;
  };
  promotions: Promotion[];
}

export interface Promotion {
  id: string;
  kind: "skill" | "memory";
  subjectId: string;
  fromScope: string;
  toScope: string;
  status: "proposed" | "approved" | "denied" | "applied" | "forbidden";
  approvalId: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface LearningReview {
  id: string;
  agentId: string;
  sessionId: string;
  taskId: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  proposals: { reason?: string };
  applied: {
    memoryIds?: string[];
    retiredIds?: string[];
    skill?: { id: string; name: string; version: number } | null;
  };
  costEur: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface LearningSettings {
  reviewEnabled: boolean;
  promotion: "automatic" | "review" | "forbidden";
  promotionThreshold: number;
  snapshotMaxChars: number;
  inactiveAfterDays: number;
  archiveAfterDays: number;
  semanticSearch: boolean;
}

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
  byAgent: Array<{
    agentId: string | null;
    agentName: string | null;
    usd: number;
    eur: number;
    calls: number;
  }>;
  byModel: Array<{
    model: string | null;
    usd: number;
    eur: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  policies: BudgetPolicy[];
}

export interface ToolPermissionView {
  name: string;
  description: string;
  risk: string;
  permission: "automatic" | "approval" | "blocked";
  source: "agent" | "role" | "company" | "risk";
}

export type AgentActivity =
  "working" | "waiting" | "idle" | "paused" | "stopped";

export interface AgentView extends Agent {
  activity: AgentActivity;
  /** Title of the conversation or task the agent is on, if any. */
  doing: string | null;
  pendingApprovals: number;
  spend: {
    eur: number;
    usd: number;
    calls: number;
    cap: number | null;
    currency: string;
  };
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
  spend: {
    eur: number;
    usd: number;
    cap: number | null;
    currency: string;
    since: string;
  };
  recentRuns: RecentRun[];
  activity: ActivityEntry[];
  working: number;
}

export interface ModelsInfo {
  default: string;
  fallback: string | null;
  providers: Array<{ id: string; enabled: boolean; detail: string }>;
  models: Array<{
    id: string;
    provider: string;
    contextWindow: number;
    price: {
      inputPerMillion: number;
      outputPerMillion: number;
      currency: string;
    };
  }>;
}

export type TaskStatus =
  "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  title: string;
  description: string;
  acceptance: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerAgentId: string | null;
  createdByKind: string;
  createdById: string | null;
  dueAt: string | null;
  leaseSessionId: string | null;
  leaseExpiresAt: string | null;
  failures: number;
  blockedReason: string | null;
  result: { summary: string; verification?: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  measure: string;
  status: "active" | "reached" | "dropped";
  dueAt: string | null;
}

export interface Project {
  id: string;
  goalId: string | null;
  name: string;
  description: string;
  status: "active" | "paused" | "done" | "archived";
  workdir: string | null;
}

export interface TaskComment {
  id: string;
  authorKind: "person" | "agent" | "system";
  authorId: string | null;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface WorkProduct {
  id: string;
  kind: "file" | "link" | "diff" | "document" | "decision" | "note";
  title: string;
  ref: string;
  summary: string;
  createdAt: string;
}

export interface TaskDetail extends Task {
  why: {
    mission: string | null;
    companyName: string;
    goals: Goal[];
    project: Project | null;
    parents: Array<{ id: string; title: string }>;
  };
  comments: TaskComment[];
  products: WorkProduct[];
  children: Task[];
  sessions: Array<{
    id: string;
    agentId: string;
    status: string;
    running: boolean;
    createdAt: string;
  }>;
  cost: { eur: number; usd: number; calls: number };
}

export interface BusEvent {
  type: string;
  companyId: string | null;
  payload?: unknown;
}

export function eventsSocket(
  onEvent: (event: BusEvent) => void,
  onState: (open: boolean) => void,
): () => void {
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
