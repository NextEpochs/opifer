/**
 * Permission per role on every tool. Three states: automatic, approval,
 * blocked. Resolution order: a policy for the agent, then for its role, then
 * the company default, then the tool's declared risk (low and medium run
 * automatically, high asks for approval). A policy with tool name "*"
 * applies to every tool of its target.
 */

import type { Sql } from "postgres";
import { audit } from "@opifer/db";

export type ToolPermission = "automatic" | "approval" | "blocked";
export type RiskLevel = "low" | "medium" | "high";
export type PolicyTarget = "company" | "role" | "agent";

export interface ToolPolicy {
  id: string;
  companyId: string;
  targetKind: PolicyTarget;
  targetId: string | null;
  toolName: string;
  permission: ToolPermission;
}

export interface ResolvedPermission {
  permission: ToolPermission;
  /** Where the permission came from, for the audit and the UI. */
  source: "agent" | "role" | "company" | "risk";
  risk: RiskLevel;
}

interface PolicyRow {
  id: string;
  company_id: string;
  target_kind: PolicyTarget;
  target_id: string | null;
  tool_name: string;
  permission: ToolPermission;
}

function toPolicy(r: PolicyRow): ToolPolicy {
  return { id: r.id, companyId: r.company_id, targetKind: r.target_kind, targetId: r.target_id, toolName: r.tool_name, permission: r.permission };
}

export function defaultPermissionForRisk(risk: RiskLevel): ToolPermission {
  return risk === "high" ? "approval" : "automatic";
}

export class PermissionService {
  constructor(private readonly sql: Sql) {}

  async listPolicies(companyId: string): Promise<ToolPolicy[]> {
    const rows = await this.sql<PolicyRow[]>`SELECT * FROM tool_policies WHERE company_id = ${companyId} ORDER BY target_kind, target_id, tool_name`;
    return rows.map(toPolicy);
  }

  async setPolicy(input: {
    companyId: string;
    targetKind: PolicyTarget;
    targetId?: string | null;
    toolName: string;
    permission: ToolPermission;
    actorId?: string | null;
  }): Promise<ToolPolicy> {
    const targetId = input.targetKind === "company" ? null : (input.targetId ?? null);
    if (input.targetKind !== "company" && !targetId) throw new Error(`a ${input.targetKind} policy needs the ${input.targetKind} id`);
    const [existing] = await this.sql<PolicyRow[]>`
      SELECT * FROM tool_policies WHERE company_id = ${input.companyId} AND target_kind = ${input.targetKind} AND target_id IS NOT DISTINCT FROM ${targetId} AND tool_name = ${input.toolName}
    `;
    const [row] = await this.sql<PolicyRow[]>`
      INSERT INTO tool_policies (company_id, target_kind, target_id, tool_name, permission)
      VALUES (${input.companyId}, ${input.targetKind}, ${targetId}, ${input.toolName}, ${input.permission})
      ON CONFLICT (company_id, target_kind, target_id, tool_name) DO UPDATE SET permission = EXCLUDED.permission
      RETURNING *
    `;
    const policy = toPolicy(row!);
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: "person",
      actorId: input.actorId ?? null,
      action: "tool.policy_set",
      subjectKind: "tool_policy",
      subjectId: policy.id,
      before: existing ? { permission: existing.permission } : null,
      after: { targetKind: policy.targetKind, targetId: policy.targetId, toolName: policy.toolName, permission: policy.permission },
    });
    return policy;
  }

  async removePolicy(companyId: string, policyId: string, actorId?: string | null): Promise<boolean> {
    const [row] = await this.sql<PolicyRow[]>`DELETE FROM tool_policies WHERE id = ${policyId} AND company_id = ${companyId} RETURNING *`;
    if (!row) return false;
    await audit(this.sql, {
      companyId,
      actorKind: "person",
      actorId: actorId ?? null,
      action: "tool.policy_removed",
      subjectKind: "tool_policy",
      subjectId: policyId,
      before: toPolicy(row),
    });
    return true;
  }

  async resolve(input: { companyId: string; agentId: string; agentRole: string; toolName: string; risk: RiskLevel }): Promise<ResolvedPermission> {
    const rows = await this.sql<PolicyRow[]>`
      SELECT * FROM tool_policies
      WHERE company_id = ${input.companyId}
        AND (tool_name = ${input.toolName} OR tool_name = '*')
        AND (
          (target_kind = 'agent' AND target_id = ${input.agentId})
          OR (target_kind = 'role' AND target_id = ${input.agentRole})
          OR target_kind = 'company'
        )
    `;
    const pick = (kind: PolicyTarget): PolicyRow | undefined =>
      rows.find((r) => r.target_kind === kind && r.tool_name === input.toolName) ?? rows.find((r) => r.target_kind === kind && r.tool_name === "*");
    for (const kind of ["agent", "role", "company"] as const) {
      const row = pick(kind);
      if (row) return { permission: row.permission, source: kind, risk: input.risk };
    }
    return { permission: defaultPermissionForRisk(input.risk), source: "risk", risk: input.risk };
  }
}
