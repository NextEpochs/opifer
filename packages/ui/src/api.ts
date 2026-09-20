/** Client minimo dell'API /v1: stesse regole e stessi dati della CLI. */

export interface Health {
  status: "ok" | "degradato";
  version: string;
  mode: string;
  database: "ok" | "errore";
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
};

export function eventsSocket(onEvent: (event: { type: string; companyId: string | null }) => void, onState: (open: boolean) => void): () => void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/v1/events`);
  socket.onopen = () => onState(true);
  socket.onclose = () => onState(false);
  socket.onerror = () => onState(false);
  socket.onmessage = (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as { type: string; companyId: string | null });
    } catch {
      // messaggio non valido: ignorato
    }
  };
  return () => socket.close();
}
