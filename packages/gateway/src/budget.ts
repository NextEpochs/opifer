/**
 * Budget before the call. Every paid call reserves its estimated cost; the
 * reservation is refused when a cap is reached, so the call never starts.
 * Open reservations count as spending, which bounds the overrun to one call.
 */

import type { Sql, TransactionSql } from "postgres";
import type { Usage } from "@opifer/sdk";
import { audit } from "@opifer/db";
import type { BudgetContext, BudgetDecision, BudgetGate, CostEstimate } from "@opifer/runtime";
import type { PriceBook } from "./prices.js";

export type BudgetScope = "company" | "project" | "agent" | "task" | "turn";
export type BudgetWindow = "monthly" | "daily" | "lifetime";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeKind: BudgetScope;
  scopeId: string | null;
  window: BudgetWindow;
  cap: number;
  currency: "EUR" | "USD";
  warnRatio: number;
}

export interface Spending {
  policy: BudgetPolicy;
  settled: number;
  reserved: number;
  /** settled + reserved, in the policy's currency. */
  total: number;
}

interface PolicyRow {
  id: string;
  company_id: string;
  scope_kind: BudgetScope;
  scope_id: string | null;
  window: BudgetWindow;
  cap: string;
  currency: "EUR" | "USD";
  warn_ratio: string;
}

function toPolicy(r: PolicyRow): BudgetPolicy {
  return {
    id: r.id,
    companyId: r.company_id,
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    window: r.window,
    cap: Number(r.cap),
    currency: r.currency,
    warnRatio: Number(r.warn_ratio),
  };
}

function windowStart(window: BudgetWindow): Date | null {
  const now = new Date();
  if (window === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (window === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return null;
}

export class BudgetService implements BudgetGate {
  constructor(
    private readonly sql: Sql,
    private readonly prices: PriceBook,
  ) {}

  async listPolicies(companyId: string): Promise<BudgetPolicy[]> {
    const rows = await this.sql<PolicyRow[]>`SELECT * FROM budget_policies WHERE company_id = ${companyId} ORDER BY scope_kind, created_at`;
    return rows.map(toPolicy);
  }

  async setPolicy(input: {
    companyId: string;
    scopeKind: BudgetScope;
    scopeId?: string | null;
    window?: BudgetWindow;
    cap: number;
    currency?: "EUR" | "USD";
    warnRatio?: number;
    actorId?: string | null;
  }): Promise<BudgetPolicy> {
    const scopeId = input.scopeKind === "company" ? null : (input.scopeId ?? null);
    if (input.scopeKind !== "company" && !scopeId) throw new Error(`a ${input.scopeKind} budget needs the ${input.scopeKind} id`);
    const window = input.window ?? "monthly";
    const [row] = await this.sql<PolicyRow[]>`
      INSERT INTO budget_policies (company_id, scope_kind, scope_id, "window", cap, currency, warn_ratio)
      VALUES (${input.companyId}, ${input.scopeKind}, ${scopeId}, ${window}, ${input.cap}, ${input.currency ?? "EUR"}, ${input.warnRatio ?? 0.8})
      ON CONFLICT (company_id, scope_kind, scope_id, "window") DO UPDATE SET cap = EXCLUDED.cap, currency = EXCLUDED.currency, warn_ratio = EXCLUDED.warn_ratio
      RETURNING *
    `;
    const policy = toPolicy(row!);
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: "person",
      actorId: input.actorId ?? null,
      action: "budget.policy_set",
      subjectKind: "budget_policy",
      subjectId: policy.id,
      after: { scopeKind: policy.scopeKind, scopeId: policy.scopeId, window: policy.window, cap: policy.cap, currency: policy.currency },
    });
    return policy;
  }

  async removePolicy(companyId: string, policyId: string, actorId?: string | null): Promise<boolean> {
    const [row] = await this.sql<PolicyRow[]>`DELETE FROM budget_policies WHERE id = ${policyId} AND company_id = ${companyId} RETURNING *`;
    if (!row) return false;
    await audit(this.sql, {
      companyId,
      actorKind: "person",
      actorId: actorId ?? null,
      action: "budget.policy_removed",
      subjectKind: "budget_policy",
      subjectId: policyId,
      before: toPolicy(row),
    });
    return true;
  }

  /** Policies that apply to a call: company, the agent, the run (turn), the project and task when known. */
  /** Runs on the transaction when given: a query on the pool from inside a locked transaction can wait for a connection held by a turn waiting for that very lock. */
  private async applicablePolicies(context: BudgetContext, db: Sql | TransactionSql = this.sql): Promise<BudgetPolicy[]> {
    const rows = await db<PolicyRow[]>`
      SELECT * FROM budget_policies
      WHERE company_id = ${context.companyId}
        AND (
          scope_kind = 'company'
          OR (scope_kind = 'agent' AND scope_id = ${context.agentId})
          OR scope_kind = 'turn'
          OR (scope_kind = 'project' AND scope_id = ${context.projectId ?? null})
          OR (scope_kind = 'task' AND scope_id = ${context.taskId ?? null})
        )
    `;
    return rows.map(toPolicy);
  }

  /** Settled cost events plus open reservations for a policy's scope and window, in the policy's currency. */
  async spending(policy: BudgetPolicy, context: BudgetContext, tx: Sql | TransactionSql = this.sql): Promise<Spending> {
    const col = policy.currency === "EUR" ? "eur" : "usd";
    const since = windowStart(policy.window);
    const scopeFilter = (alias: string) => {
      switch (policy.scopeKind) {
        case "agent":
          return tx`AND ${tx(alias + ".agent_id")} = ${policy.scopeId}`;
        case "project":
          return tx`AND ${tx(alias + ".project_id")} = ${policy.scopeId}`;
        case "task":
          return tx`AND ${tx(alias + ".task_id")} = ${policy.scopeId}`;
        case "turn":
          return tx`AND ${tx(alias + ".run_id")} = ${context.runId}`;
        default:
          return tx``;
      }
    };
    const sinceFilter = (alias: string) => (since ? tx`AND ${tx(alias + ".occurred_at")} >= ${since}` : tx``);
    const sinceReserved = since ? tx`AND r.created_at >= ${since}` : tx``;
    const [settledRow] = await tx<{ total: string }[]>`
      SELECT coalesce(sum(${tx("c.amount_" + col)}), 0)::text AS total FROM cost_events c
      WHERE c.company_id = ${policy.companyId} ${scopeFilter("c")} ${sinceFilter("c")}
    `;
    const [reservedRow] = await tx<{ total: string }[]>`
      SELECT coalesce(sum(${tx("r.estimated_" + col)}), 0)::text AS total FROM budget_reservations r
      WHERE r.company_id = ${policy.companyId} AND r.status = 'open' ${scopeFilter("r")} ${sinceReserved}
    `;
    const settled = Number(settledRow?.total ?? 0);
    const reserved = Number(reservedRow?.total ?? 0);
    return { policy, settled, reserved, total: settled + reserved };
  }

  async reserve(context: BudgetContext, estimate: CostEstimate): Promise<BudgetDecision> {
    const money = await this.prices.estimate(estimate.modelId, estimate.inputTokens, estimate.maxOutputTokens);
    return this.sql.begin(async (tx) => {
      // One reservation at a time per company: concurrent turns cannot both slip under a cap.
      const [company] = await tx<{ status: string }[]>`SELECT status FROM companies WHERE id = ${context.companyId} FOR UPDATE`;
      if (company && company.status !== "active") {
        // Emergency stop: no new reservation until a person reactivates the company.
        return { allowed: false, reason: `the company is ${company.status}: no model call until a person resumes it`, scope: "company", cap: 0, spent: 0, currency: "EUR" };
      }
      const policies = await this.applicablePolicies(context, tx);
      const warnings: string[] = [];
      for (const policy of policies) {
        const spent = await this.spending(policy, context, tx);
        const label = policy.scopeKind === "company" ? "company" : `${policy.scopeKind} ${policy.scopeId ?? ""}`.trim();
        if (spent.total >= policy.cap) {
          await audit(tx, {
            companyId: context.companyId,
            actorKind: "system",
            action: "budget.blocked",
            subjectKind: "run",
            subjectId: context.runId,
            after: { scope: label, window: policy.window, cap: policy.cap, spent: spent.total, currency: policy.currency },
          });
          return {
            allowed: false,
            reason: `${policy.window} budget for ${label} reached: ${spent.total.toFixed(4)} of ${policy.cap} ${policy.currency}`,
            scope: label,
            cap: policy.cap,
            spent: spent.total,
            currency: policy.currency,
            policyId: policy.id,
            window: policy.window,
          };
        }
        if (spent.total >= policy.cap * policy.warnRatio) {
          warnings.push(`budget warning: ${label} at ${spent.total.toFixed(4)} of ${policy.cap} ${policy.currency} (${policy.window})`);
        }
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO budget_reservations (company_id, agent_id, session_id, run_id, project_id, task_id, estimated_usd, estimated_eur)
        VALUES (${context.companyId}, ${context.agentId}, ${context.sessionId}, ${context.runId}, ${context.projectId ?? null}, ${context.taskId ?? null}, ${money.usd}, ${money.eur})
        RETURNING id
      `;
      return { allowed: true, reservationId: row!.id, warnings };
    });
  }

  async settle(reservationId: string, modelId: string, usage: Usage, kind: "model" | "auxiliary_model" = "model"): Promise<{ eur: number; usd: number }> {
    const money = await this.prices.cost(modelId, usage);
    const slash = modelId.indexOf("/");
    await this.sql.begin(async (tx) => {
      const [reservation] = await tx<
        { id: string; company_id: string; agent_id: string | null; session_id: string | null; run_id: string | null; project_id: string | null; task_id: string | null }[]
      >`
        SELECT * FROM budget_reservations WHERE id = ${reservationId} AND status = 'open' FOR UPDATE
      `;
      if (!reservation) return;
      const [event] = await tx<{ id: string }[]>`
        INSERT INTO cost_events (company_id, agent_id, session_id, run_id, project_id, task_id, kind, provider, model, input_tokens, cached_input_tokens, output_tokens, amount_usd, amount_eur)
        VALUES (
          ${reservation.company_id}, ${reservation.agent_id}, ${reservation.session_id}, ${reservation.run_id}, ${reservation.project_id}, ${reservation.task_id},
          ${kind}, ${slash > 0 ? modelId.slice(0, slash) : null}, ${slash > 0 ? modelId.slice(slash + 1) : modelId},
          ${usage.inputTokens}, ${usage.cachedInputTokens ?? 0}, ${usage.outputTokens}, ${money.usd}, ${money.eur}
        )
        RETURNING id
      `;
      await tx`UPDATE budget_reservations SET status = 'settled', cost_event_id = ${event!.id}, settled_at = now() WHERE id = ${reservationId}`;
    });
    return { eur: money.eur, usd: money.usd };
  }

  async release(reservationId: string): Promise<void> {
    await this.sql`UPDATE budget_reservations SET status = 'released', settled_at = now() WHERE id = ${reservationId} AND status = 'open'`;
  }

  /** Spend report for the UI and the CLI. */
  async report(
    companyId: string,
    options: { since?: Date | null } = {},
  ): Promise<{
    total: { usd: number; eur: number };
    byAgent: Array<{ agentId: string | null; agentName: string | null; usd: number; eur: number; calls: number }>;
    byModel: Array<{ model: string | null; usd: number; eur: number; calls: number; inputTokens: number; outputTokens: number }>;
  }> {
    const since = options.since === undefined ? windowStart("monthly") : options.since;
    const sinceFilter = since ? this.sql`AND c.occurred_at >= ${since}` : this.sql``;
    const [total] = await this.sql<{ usd: string; eur: string }[]>`
      SELECT coalesce(sum(amount_usd), 0)::text AS usd, coalesce(sum(amount_eur), 0)::text AS eur FROM cost_events c WHERE c.company_id = ${companyId} ${sinceFilter}
    `;
    const byAgent = await this.sql<{ agent_id: string | null; agent_name: string | null; usd: string; eur: string; calls: string }[]>`
      SELECT c.agent_id, a.name AS agent_name, sum(c.amount_usd)::text AS usd, sum(c.amount_eur)::text AS eur, count(*)::text AS calls
      FROM cost_events c LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.company_id = ${companyId} ${sinceFilter}
      GROUP BY c.agent_id, a.name ORDER BY sum(c.amount_usd) DESC
    `;
    const byModel = await this.sql<{ model: string | null; usd: string; eur: string; calls: string; input_tokens: string; output_tokens: string }[]>`
      SELECT c.model, sum(c.amount_usd)::text AS usd, sum(c.amount_eur)::text AS eur, count(*)::text AS calls, sum(c.input_tokens)::text AS input_tokens, sum(c.output_tokens)::text AS output_tokens
      FROM cost_events c WHERE c.company_id = ${companyId} ${sinceFilter}
      GROUP BY c.model ORDER BY sum(c.amount_usd) DESC
    `;
    return {
      total: { usd: Number(total?.usd ?? 0), eur: Number(total?.eur ?? 0) },
      byAgent: byAgent.map((r) => ({ agentId: r.agent_id, agentName: r.agent_name, usd: Number(r.usd), eur: Number(r.eur), calls: Number(r.calls) })),
      byModel: byModel.map((r) => ({
        model: r.model,
        usd: Number(r.usd),
        eur: Number(r.eur),
        calls: Number(r.calls),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
      })),
    };
  }
}
