/**
 * Domain types shared between server, CLI and UI.
 * They mirror the tables in `packages/db/migrations`; the typed query types
 * live in the Drizzle schema, here there are only the shapes exposed by the
 * API.
 */

export type CompanyStatus = "active" | "suspended" | "archived";

export interface Company {
  id: string;
  name: string;
  mission: string | null;
  status: CompanyStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type MembershipRole = "owner" | "admin" | "operator" | "observer";

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

export type AgentStatus = "active" | "paused" | "budget_stopped" | "archived";

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

export type AuditActorKind = "person" | "agent" | "system";

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

/** Installation mode: the same code serves all three. */
export type InstallMode = "local" | "authenticated" | "managed";
