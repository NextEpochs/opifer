/**
 * Governance gates the runtime consults. The gateway package implements
 * them; the runtime only knows the contract, so it never depends on the
 * gateway (narrow core, capabilities at the edges).
 */

import type { Usage } from "@opifer/sdk";

export interface BudgetContext {
  companyId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  projectId?: string | null;
  taskId?: string | null;
}

export interface CostEstimate {
  modelId: string;
  inputTokens: number;
  maxOutputTokens: number;
}

export type BudgetDecision =
  | { allowed: true; reservationId: string; warnings: string[] }
  | { allowed: false; reason: string; scope: string; cap: number; spent: number; currency: string; policyId?: string; window?: string };

export interface BudgetGate {
  /** Reserves the estimated cost of a call before it starts; denied when a cap is reached. */
  reserve(context: BudgetContext, estimate: CostEstimate): Promise<BudgetDecision>;
  /** Records the real usage of a reserved call. */
  settle(reservationId: string, modelId: string, usage: Usage): Promise<void>;
  /** Frees a reservation whose call never happened. */
  release(reservationId: string): Promise<void>;
}

export interface ApprovalRequest {
  companyId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  kind: "tool_use" | "dangerous_command" | "budget_increase";
  subject: Record<string, unknown>;
  reason: string;
  risk: "low" | "medium" | "high";
  estimatedCost?: number | null;
}

export interface ApprovalRecord {
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  decisionNote: string | null;
}

export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<ApprovalRecord>;
  /** The approval attached to a pending tool call of a session, if any. */
  forToolCall(sessionId: string, callId: string): Promise<ApprovalRecord | null>;
}

export interface GovernanceGates {
  budget?: BudgetGate;
  approvals?: ApprovalGate;
  /** Called when a cap stops an agent, so the organisation can mark it and ask for a decision. */
  onBudgetStop?: (context: BudgetContext, decision: Extract<BudgetDecision, { allowed: false }>) => Promise<void>;
}
