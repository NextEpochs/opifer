/**
 * Governance API: budgets and costs, approvals (the inbox), tool policies,
 * secrets (values never come back), agent revisions and status.
 */

import { ApprovalError } from "@opifer/gateway";
import type { AgentRuntime } from "@opifer/runtime";
import type { FastifyInstance } from "fastify";
import type { Governance } from "../governance.js";
import { startTurnInBackground } from "./sessions.js";

export interface GovernanceRoutesOptions {
  runtime: AgentRuntime;
  governance: Governance;
}

const uuid = { type: "string", format: "uuid" } as const;

const budgetBody = {
  type: "object",
  required: ["scopeKind", "cap"],
  additionalProperties: false,
  properties: {
    scopeKind: { type: "string", enum: ["company", "project", "agent", "task", "turn"] },
    scopeId: { type: "string", maxLength: 200 },
    window: { type: "string", enum: ["monthly", "daily", "lifetime"] },
    cap: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["EUR", "USD"] },
    warnRatio: { type: "number", exclusiveMinimum: 0, maximum: 1 },
  },
} as const;

const decideBody = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["approved", "denied"] },
    note: { type: "string", maxLength: 2000 },
    /** For a budget increase: the new cap; defaults to double the old one. */
    newCap: { type: "number", minimum: 0 },
  },
} as const;

const toolPolicyBody = {
  type: "object",
  required: ["targetKind", "toolName", "permission"],
  additionalProperties: false,
  properties: {
    targetKind: { type: "string", enum: ["company", "role", "agent"] },
    targetId: { type: "string", maxLength: 200 },
    toolName: { type: "string", minLength: 1, maxLength: 200 },
    permission: { type: "string", enum: ["automatic", "approval", "blocked"] },
  },
} as const;

const secretBody = {
  type: "object",
  required: ["name", "value"],
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
    value: { type: "string", minLength: 1, maxLength: 20_000 },
  },
} as const;

const bindingBody = {
  type: "object",
  required: ["secretName", "agentId"],
  additionalProperties: false,
  properties: {
    secretName: { type: "string", minLength: 1 },
    agentId: uuid,
    toolName: { type: "string", maxLength: 200 },
  },
} as const;

const agentPatchBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    role: { type: "string", maxLength: 2000 },
    model: { type: ["string", "null"], maxLength: 200 },
    reportsToAgentId: { type: ["string", "null"], format: "uuid" },
    note: { type: "string", maxLength: 500 },
  },
} as const;

const agentStatusBody = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: { status: { type: "string", enum: ["active", "paused", "archived"] }, reason: { type: "string", maxLength: 500 } },
} as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function registerGovernanceRoutes(app: FastifyInstance, options: GovernanceRoutesOptions): Promise<void> {
  const { runtime, governance } = options;
  const { budget, approvals, permissions, secrets, agents } = governance;
  const { sql } = app.opifer.db;
  const bus = app.opifer.bus;

  const agentOf = async (agentId: string) => {
    const [row] = await sql<{ id: string; company_id: string; role: string; status: string }[]>`SELECT id, company_id, role, status FROM agents WHERE id = ${agentId}`;
    return row ?? null;
  };

  // --- Budgets and costs ---------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/budgets", async (request) => budget.listPolicies(request.params.id));

  app.put<{
    Params: { id: string };
    Body: {
      scopeKind: "company" | "project" | "agent" | "task" | "turn";
      scopeId?: string;
      window?: "monthly" | "daily" | "lifetime";
      cap: number;
      currency?: "EUR" | "USD";
      warnRatio?: number;
    };
  }>("/companies/:id/budgets", { schema: { body: budgetBody } }, async (request, reply) => {
    try {
      const policy = await budget.setPolicy({ companyId: request.params.id, ...request.body });
      bus.publish("budget.policy_set", request.params.id, policy);
      return policy;
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.delete<{ Params: { id: string; policyId: string } }>("/companies/:id/budgets/:policyId", async (request, reply) => {
    const removed = await budget.removePolicy(request.params.id, request.params.policyId);
    return reply.code(removed ? 204 : 404).send();
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/companies/:id/costs", async (request) => {
    const since = request.query.since === "all" ? null : request.query.since ? new Date(request.query.since) : undefined;
    const report = await budget.report(request.params.id, since === undefined ? {} : { since });
    const policies = await budget.listPolicies(request.params.id);
    return { ...report, policies };
  });

  // --- Approvals -----------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: "pending" | "approved" | "denied" | "expired"; limit?: string } }>("/companies/:id/approvals", async (request) => {
    return approvals.list(request.params.id, { status: request.query.status ?? null, limit: Number(request.query.limit ?? 100) || 100 });
  });

  app.get<{ Params: { id: string } }>("/approvals/:id", async (request, reply) => {
    const [row] = await sql<{ company_id: string }[]>`SELECT company_id FROM approvals WHERE id = ${request.params.id}`;
    if (!row) return reply.code(404).send({ error: "approval not found" });
    return approvals.get(row.company_id, request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { status: "approved" | "denied"; note?: string; newCap?: number } }>(
    "/approvals/:id/decide",
    { schema: { body: decideBody } },
    async (request, reply) => {
      const [row] = await sql<{ company_id: string }[]>`SELECT company_id FROM approvals WHERE id = ${request.params.id}`;
      if (!row) return reply.code(404).send({ error: "approval not found" });
      const companyId = row.company_id;
      let approval;
      try {
        approval = await approvals.decide(companyId, request.params.id, { status: request.body.status, note: request.body.note ?? null });
      } catch (error) {
        if (error instanceof ApprovalError) return reply.code(error.code === "not_found" ? 404 : 409).send({ error: error.message });
        throw error;
      }
      bus.publish("approval.decided", companyId, {
        approvalId: approval.id,
        kind: approval.kind,
        status: approval.status,
        agentId: approval.agentId,
        sessionId: approval.sessionId,
      });

      let followUp: string | null = null;
      const resume = async (sessionId: string) => {
        if (runtime.isRunning(sessionId)) return;
        const session = await runtime.store.getSession(sessionId);
        if (!session || session.status !== "active") return;
        if (session.taskId) {
          // A task session resumes through the scheduler, which holds the lease.
          await app.opifer.work.wake(session.companyId, session.agentId, "decision", { taskId: session.taskId, dedupeKey: `decision:${approval.id}` });
          followUp = followUp ? `${followUp}; task resumed` : "task_resumed";
        } else {
          startTurnInBackground(app, runtime, session);
          followUp = followUp ? `${followUp}; session resumed` : "session_resumed";
        }
      };
      if (approval.kind === "tool_use" || approval.kind === "dangerous_command") {
        // Either way the session resumes: the approved call runs, the denied one is refused to the model.
        if (approval.sessionId) await resume(approval.sessionId);
      } else if (approval.kind === "budget_increase" && approval.status === "approved" && approval.agentId) {
        const subject = approval.subject as { policyId?: string | null; cap?: number };
        const policy = subject.policyId ? (await budget.listPolicies(companyId)).find((p) => p.id === subject.policyId) : undefined;
        if (policy) {
          const cap = request.body.newCap ?? policy.cap * 2;
          await budget.setPolicy({
            companyId,
            scopeKind: policy.scopeKind,
            scopeId: policy.scopeId,
            window: policy.window,
            cap,
            currency: policy.currency,
            warnRatio: policy.warnRatio,
          });
          followUp = `cap raised to ${cap} ${policy.currency}`;
        }
        await agents.setStatus(companyId, approval.agentId, "active", { reason: "budget increase approved" });
        bus.publish("agent.status_changed", companyId, { agentId: approval.agentId, status: "active" });
        if (approval.sessionId) await resume(approval.sessionId);
      } else if (approval.kind === "skill_promotion" && app.opifer.learning) {
        // The promotion follows the decision: applied (a copy at the new scope) or denied.
        const promotion = await app.opifer.learning.promotions.byApproval(companyId, approval.id);
        if (promotion) {
          try {
            const decided = await app.opifer.learning.promotions.decide(companyId, promotion.id, approval.status === "approved", { kind: "person" });
            followUp = decided.status === "applied" ? "promotion_applied" : "promotion_denied";
            bus.publish("promotion.decided", companyId, { promotionId: decided.id, status: decided.status, kind: decided.kind });
          } catch (error) {
            followUp = `promotion failed: ${message(error)}`;
          }
        }
      }
      return { ...approval, followUp };
    },
  );

  // --- Tool policies and permissions -----------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/tool-policies", async (request) => permissions.listPolicies(request.params.id));

  app.put<{ Params: { id: string }; Body: { targetKind: "company" | "role" | "agent"; targetId?: string; toolName: string; permission: "automatic" | "approval" | "blocked" } }>(
    "/companies/:id/tool-policies",
    { schema: { body: toolPolicyBody } },
    async (request, reply) => {
      try {
        const policy = await permissions.setPolicy({ companyId: request.params.id, ...request.body });
        bus.publish("tool.policy_set", request.params.id, policy);
        return policy;
      } catch (error) {
        return reply.code(400).send({ error: message(error) });
      }
    },
  );

  app.delete<{ Params: { id: string; policyId: string } }>("/companies/:id/tool-policies/:policyId", async (request, reply) => {
    const removed = await permissions.removePolicy(request.params.id, request.params.policyId);
    return reply.code(removed ? 204 : 404).send();
  });

  /** Every tool with the permission this agent ends up with, and where it comes from. */
  app.get<{ Params: { id: string } }>("/agents/:id/permissions", async (request, reply) => {
    const agent = await agentOf(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const tools = governance.tools.definitions();
    return Promise.all(
      tools.map(async (tool) => {
        const risk = governance.tools.riskOf?.(tool.name) ?? "high";
        const resolved = await permissions.resolve({ companyId: agent.company_id, agentId: agent.id, agentRole: agent.role, toolName: tool.name, risk });
        return { name: tool.name, description: tool.description, risk, permission: resolved.permission, source: resolved.source };
      }),
    );
  });

  // --- Secrets ---------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/secrets", async (request) => secrets.list(request.params.id));

  app.put<{ Params: { id: string }; Body: { name: string; value: string } }>("/companies/:id/secrets", { schema: { body: secretBody } }, async (request, reply) => {
    try {
      const info = await secrets.set({ companyId: request.params.id, name: request.body.name, value: request.body.value });
      return reply.code(201).send(info);
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.delete<{ Params: { id: string; name: string } }>("/companies/:id/secrets/:name", async (request, reply) => {
    const removed = await secrets.remove(request.params.id, request.params.name);
    return reply.code(removed ? 204 : 404).send();
  });

  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>("/companies/:id/secret-bindings", async (request) =>
    secrets.listBindings(request.params.id, request.query.agentId ?? null),
  );

  app.post<{ Params: { id: string }; Body: { secretName: string; agentId: string; toolName?: string } }>(
    "/companies/:id/secret-bindings",
    { schema: { body: bindingBody } },
    async (request, reply) => {
      try {
        const binding = await secrets.bind({
          companyId: request.params.id,
          secretName: request.body.secretName,
          agentId: request.body.agentId,
          toolName: request.body.toolName ?? null,
        });
        return reply.code(201).send(binding);
      } catch (error) {
        return reply.code(400).send({ error: message(error) });
      }
    },
  );

  app.delete<{ Params: { id: string; bindingId: string } }>("/companies/:id/secret-bindings/:bindingId", async (request, reply) => {
    const removed = await secrets.unbind(request.params.id, request.params.bindingId);
    return reply.code(removed ? 204 : 404).send();
  });

  app.get<{ Params: { id: string } }>("/companies/:id/secret-access", async (request) => secrets.accessLog(request.params.id));

  // --- Agent configuration and status ---------------------------------------

  app.patch<{ Params: { id: string }; Body: { name?: string; role?: string; model?: string | null; reportsToAgentId?: string | null; note?: string } }>(
    "/agents/:id",
    { schema: { body: agentPatchBody } },
    async (request, reply) => {
      const agent = await agentOf(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const { note, ...patch } = request.body;
      try {
        const result = await agents.update(agent.company_id, agent.id, patch, { note: note ?? null });
        bus.publish("agent.updated", agent.company_id, { agentId: agent.id, revision: result.revision });
        return result;
      } catch (error) {
        return reply.code(400).send({ error: message(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/agents/:id/revisions", async (request, reply) => {
    const agent = await agentOf(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    return agents.revisions(agent.company_id, agent.id);
  });

  app.post<{ Params: { id: string; revision: string } }>("/agents/:id/revisions/:revision/restore", async (request, reply) => {
    const agent = await agentOf(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    try {
      const result = await agents.restore(agent.company_id, agent.id, Number(request.params.revision));
      bus.publish("agent.updated", agent.company_id, { agentId: agent.id, revision: result.revision });
      return result;
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { status: "active" | "paused" | "archived"; reason?: string } }>(
    "/agents/:id/status",
    { schema: { body: agentStatusBody } },
    async (request, reply) => {
      const agent = await agentOf(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      const status = await agents.setStatus(agent.company_id, agent.id, request.body.status, { reason: request.body.reason ?? null });
      bus.publish("agent.status_changed", agent.company_id, { agentId: agent.id, status });
      return { id: agent.id, status };
    },
  );
}
