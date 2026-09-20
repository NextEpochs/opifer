/**
 * Governance for the server: the gateway services, the governed tool
 * executor and the gates the runtime consults. When a cap stops an agent,
 * the agent is marked, a "budget increase" approval is opened and the
 * organisation is told on the bus.
 */

import path from "node:path";
import type { EventBus } from "@opifer/core";
import type { DatabaseHandle } from "@opifer/db";
import {
  AgentConfigService,
  ApprovalService,
  BudgetService,
  GovernedToolExecutor,
  PermissionService,
  PriceBook,
  SecretCipher,
  SecretService,
  loadMasterKey,
} from "@opifer/gateway";
import { NATIVE_TOOLS, NativeToolExecutor, type GovernanceGates, type ProviderRegistry, type ToolExecutor } from "@opifer/runtime";

export interface Governance {
  prices: PriceBook;
  budget: BudgetService;
  approvals: ApprovalService;
  permissions: PermissionService;
  secrets: SecretService;
  agents: AgentConfigService;
  tools: ToolExecutor;
  gates: GovernanceGates;
}

export interface GovernanceOptions {
  /** Directory holding the master key (`<OPIFER_HOME>/credentials`). */
  credentialsDir: string;
  /** Euros per dollar for the cost events. */
  usdToEur?: number;
  /** Underlying executor; defaults to the native tools. */
  inner?: ToolExecutor;
}

/** Where the master key lives under the credentials directory. */
export function masterKeyFile(credentialsDir: string): string {
  return path.join(credentialsDir, "master.key");
}

export async function buildGovernance(db: DatabaseHandle, providers: ProviderRegistry, bus: EventBus, options: GovernanceOptions): Promise<Governance> {
  const prices = new PriceBook(providers, options.usdToEur !== undefined ? { usdToEur: options.usdToEur } : {});
  const budget = new BudgetService(db.sql, prices);
  const approvals = new ApprovalService(db.sql);
  const permissions = new PermissionService(db.sql);
  const secrets = new SecretService(db.sql, new SecretCipher(await loadMasterKey(masterKeyFile(options.credentialsDir))));
  const agents = new AgentConfigService(db.sql);
  const tools = new GovernedToolExecutor({ sql: db.sql, inner: options.inner ?? new NativeToolExecutor(NATIVE_TOOLS), permissions, secrets });

  const gates: GovernanceGates = {
    budget,
    approvals: {
      // Every approval a turn asks for is announced on the bus: the interface, the channels and the subscribers hear it.
      request: async (request) => {
        const approval = await approvals.request(request);
        bus.publish("approval.requested", request.companyId, { approvalId: approval.id, kind: request.kind, agentId: request.agentId, sessionId: request.sessionId });
        return approval;
      },
      forToolCall: (sessionId, callId) => approvals.forToolCall(sessionId, callId),
    },
    onBudgetStop: async (context, decision) => {
      await agents.setStatus(context.companyId, context.agentId, "budget_stopped", { actorKind: "system", reason: decision.reason });
      const approval = await approvals.request({
        companyId: context.companyId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        runId: context.runId,
        kind: "budget_increase",
        subject: {
          policyId: decision.policyId ?? null,
          scope: decision.scope,
          window: decision.window ?? null,
          cap: decision.cap,
          spent: decision.spent,
          currency: decision.currency,
        },
        reason: decision.reason,
        risk: "medium",
      });
      bus.publish("agent.budget_stopped", context.companyId, { agentId: context.agentId, sessionId: context.sessionId, approvalId: approval.id, reason: decision.reason });
      bus.publish("approval.requested", context.companyId, { approvalId: approval.id, kind: approval.kind, agentId: context.agentId, sessionId: context.sessionId });
    },
  };

  return { prices, budget, approvals, permissions, secrets, agents, tools, gates };
}
