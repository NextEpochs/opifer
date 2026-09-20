/**
 * Tipi di dominio condivisi tra server, CLI e UI.
 * Rispecchiano le tabelle di `packages/db/migrations`; i tipi tipizzati per
 * le query stanno nello schema Drizzle, qui ci sono solo le forme esposte
 * dall'API.
 */

export type CompanyStatus = "attiva" | "sospesa" | "archiviata";

export interface Company {
  id: string;
  name: string;
  mission: string | null;
  status: CompanyStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type MembershipRole = "proprietario" | "amministratore" | "operatore" | "osservatore";

export interface User {
  id: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  companyId: string;
  userId: string;
  role: MembershipRole;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = "attivo" | "in_pausa" | "fermato_per_budget" | "archiviato";

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsToAgentId: string | null;
  reportsToUserId: string | null;
  model: string | null;
  status: AgentStatus;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export type AuditActorKind = "persona" | "agente" | "sistema";

export interface AuditEntry {
  id: string;
  companyId: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  action: string;
  subjectKind: string;
  subjectId: string | null;
  taskId: string | null;
  before: unknown;
  after: unknown;
  occurredAt: string;
}

/** Modalità di installazione: lo stesso codice serve tutte e tre. */
export type InstallMode = "locale" | "autenticata" | "gestita";
