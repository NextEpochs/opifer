/**
 * Versioned agent configuration. Every change creates a revision; a
 * revision can be restored, which is itself a new revision. Nothing is
 * ever rewritten in place.
 */

import type { Sql } from "postgres";
import { audit } from "@opifer/db";

export interface AgentConfig {
  name: string;
  role: string;
  model: string | null;
  reportsToAgentId: string | null;
}

export interface AgentRevision {
  revision: number;
  config: AgentConfig;
  authorKind: "person" | "agent" | "system";
  authorId: string | null;
  note: string | null;
  createdAt: Date;
}

export type AgentStatus = "active" | "paused" | "budget_stopped" | "archived";

interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  role: string;
  model: string | null;
  reports_to_agent_id: string | null;
  status: AgentStatus;
  current_revision: number;
}

interface RevisionRow {
  revision: number;
  config: Partial<AgentConfig>;
  author_kind: "person" | "agent" | "system";
  author_id: string | null;
  note: string | null;
  created_at: Date;
}

function configOf(row: AgentRow): AgentConfig {
  return { name: row.name, role: row.role, model: row.model, reportsToAgentId: row.reports_to_agent_id };
}

export class AgentConfigService {
  constructor(private readonly sql: Sql) {}

  async revisions(companyId: string, agentId: string): Promise<AgentRevision[]> {
    const rows = await this.sql<RevisionRow[]>`
      SELECT revision, config, author_kind, author_id, note, created_at FROM agent_revisions
      WHERE company_id = ${companyId} AND agent_id = ${agentId} ORDER BY revision DESC
    `;
    return rows.map((r) => ({ revision: r.revision, config: { name: "", role: "", model: null, reportsToAgentId: null, ...r.config }, authorKind: r.author_kind, authorId: r.author_id, note: r.note, createdAt: r.created_at }));
  }

  /** Applies a change as a new revision. Returns the new revision number. */
  async update(companyId: string, agentId: string, patch: Partial<AgentConfig>, options: { actorKind?: "person" | "agent" | "system"; actorId?: string | null; note?: string | null } = {}): Promise<{ revision: number; config: AgentConfig }> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<AgentRow[]>`SELECT * FROM agents WHERE id = ${agentId} AND company_id = ${companyId} FOR UPDATE`;
      if (!row) throw new Error("agent not found");
      const before = configOf(row);
      const config: AgentConfig = { ...before, ...stripUndefined(patch) };
      if (config.reportsToAgentId) {
        if (config.reportsToAgentId === agentId) throw new Error("an agent cannot report to itself");
        const [manager] = await tx<{ id: string }[]>`SELECT id FROM agents WHERE id = ${config.reportsToAgentId} AND company_id = ${companyId}`;
        if (!manager) throw new Error("the given manager does not exist in this company");
      }
      const revision = row.current_revision + 1;
      await tx`
        UPDATE agents SET name = ${config.name}, role = ${config.role}, model = ${config.model}, reports_to_agent_id = ${config.reportsToAgentId}, current_revision = ${revision}
        WHERE id = ${agentId}
      `;
      await tx`
        INSERT INTO agent_revisions (company_id, agent_id, revision, config, author_kind, author_id, note)
        VALUES (${companyId}, ${agentId}, ${revision}, ${config as never}::jsonb, ${options.actorKind ?? "person"}, ${options.actorId ?? null}, ${options.note ?? null})
      `;
      await audit(tx, {
        companyId,
        actorKind: options.actorKind ?? "person",
        actorId: options.actorId ?? null,
        action: "agent.updated",
        subjectKind: "agent",
        subjectId: agentId,
        before: { revision: row.current_revision, ...before },
        after: { revision, ...config },
      });
      return { revision, config };
    });
  }

  /** Brings back an older configuration as a new revision. */
  async restore(companyId: string, agentId: string, revision: number, options: { actorId?: string | null } = {}): Promise<{ revision: number; config: AgentConfig }> {
    const [target] = await this.sql<RevisionRow[]>`
      SELECT revision, config, author_kind, author_id, note, created_at FROM agent_revisions WHERE company_id = ${companyId} AND agent_id = ${agentId} AND revision = ${revision}
    `;
    if (!target) throw new Error(`revision ${revision} not found`);
    const config = target.config;
    const patch: Partial<AgentConfig> = {};
    if (config.name !== undefined) patch.name = config.name;
    if (config.role !== undefined) patch.role = config.role;
    if (config.model !== undefined) patch.model = config.model;
    if (config.reportsToAgentId !== undefined) patch.reportsToAgentId = config.reportsToAgentId;
    return this.update(companyId, agentId, patch, { actorId: options.actorId ?? null, note: `restored revision ${revision}` });
  }

  async setStatus(companyId: string, agentId: string, status: AgentStatus, options: { actorKind?: "person" | "agent" | "system"; actorId?: string | null; reason?: string | null } = {}): Promise<AgentStatus> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<AgentRow[]>`SELECT * FROM agents WHERE id = ${agentId} AND company_id = ${companyId} FOR UPDATE`;
      if (!row) throw new Error("agent not found");
      if (row.status === status) return status;
      await tx`UPDATE agents SET status = ${status} WHERE id = ${agentId}`;
      await audit(tx, {
        companyId,
        actorKind: options.actorKind ?? "person",
        actorId: options.actorId ?? null,
        action: "agent.status_changed",
        subjectKind: "agent",
        subjectId: agentId,
        before: { status: row.status },
        after: { status, reason: options.reason ?? null },
      });
      return status;
    });
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
