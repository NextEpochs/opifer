/**
 * Approvals: the decisions a person has to take. A request is a row and an
 * audit entry; a decision is an update and an audit entry. The runtime asks
 * for the approval attached to a pending tool call to resume a session.
 */

import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import type { ApprovalGate, ApprovalRecord, ApprovalRequest } from "@opifer/runtime";

export type ApprovalKind = ApprovalRequest["kind"] | "agent_hire" | "plan" | "skill_promotion" | "config_change" | "secret_access";
export type ApprovalStatus = ApprovalRecord["status"];

export interface Approval {
  id: string;
  status: ApprovalStatus;
  decisionNote: string | null;
  companyId: string;
  kind: ApprovalKind;
  agentId: string | null;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  subject: Record<string, unknown>;
  reason: string | null;
  estimatedCost: number | null;
  risk: "low" | "medium" | "high";
  decidedBy: string | null;
  expiresAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
}

interface ApprovalRow {
  id: string;
  company_id: string;
  kind: ApprovalKind;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  subject: Record<string, unknown>;
  reason: string | null;
  estimated_cost: string | null;
  risk: "low" | "medium" | "high";
  status: ApprovalStatus;
  decided_by: string | null;
  decision_note: string | null;
  expires_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    agentId: r.agent_id,
    sessionId: r.session_id,
    runId: r.run_id,
    taskId: r.task_id,
    subject: r.subject,
    reason: r.reason,
    estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost),
    risk: r.risk,
    status: r.status,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

export interface ApprovalInput extends Omit<ApprovalRequest, "kind" | "agentId" | "sessionId" | "runId"> {
  kind: ApprovalKind;
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
}

export interface ApprovalServiceOptions {
  /** Pending approvals expire after this long; null means never. */
  ttlMs?: number | null;
}

export class ApprovalService implements ApprovalGate {
  private readonly ttlMs: number | null;

  constructor(
    private readonly sql: Sql,
    options: ApprovalServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs === undefined ? 7 * 24 * 3600 * 1000 : options.ttlMs;
  }

  async request(input: ApprovalInput): Promise<Approval> {
    const expiresAt = this.ttlMs === null ? null : new Date(Date.now() + this.ttlMs);
    const approval = await this.sql.begin(async (tx) => {
      const [row] = await tx<ApprovalRow[]>`
        INSERT INTO approvals (company_id, kind, agent_id, session_id, run_id, task_id, subject, reason, estimated_cost, risk, expires_at)
        VALUES (
          ${input.companyId}, ${input.kind}, ${input.agentId ?? null}, ${input.sessionId ?? null}, ${input.runId ?? null}, ${input.taskId ?? null},
          ${input.subject as never}::jsonb, ${input.reason}, ${input.estimatedCost ?? null}, ${input.risk}, ${expiresAt}
        )
        RETURNING *
      `;
      const approval = toApproval(row!);
      await audit(tx, {
        companyId: input.companyId,
        actorKind: input.agentId ? "agent" : "system",
        actorId: input.agentId ?? null,
        action: "approval.requested",
        subjectKind: "approval",
        subjectId: approval.id,
        taskId: input.taskId ?? null,
        after: { kind: approval.kind, reason: approval.reason, risk: approval.risk, subject: approval.subject },
      });
      return approval;
    });
    return approval;
  }

  async get(companyId: string, id: string): Promise<Approval | null> {
    const [row] = await this.sql<ApprovalRow[]>`SELECT * FROM approvals WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toApproval(row) : null;
  }

  async list(companyId: string, options: { status?: ApprovalStatus | null; limit?: number } = {}): Promise<Approval[]> {
    const statusFilter = options.status ? this.sql`AND status = ${options.status}` : this.sql``;
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM approvals WHERE company_id = ${companyId} ${statusFilter}
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT ${options.limit ?? 100}
    `;
    return rows.map(toApproval);
  }

  /** Records a person's decision; only a pending approval can be decided, once. */
  async decide(companyId: string, id: string, decision: { status: "approved" | "denied"; decidedBy?: string | null; note?: string | null }): Promise<Approval> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<ApprovalRow[]>`SELECT * FROM approvals WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
      if (!before) throw new ApprovalError("not_found", `approval ${id} not found`);
      if (before.status !== "pending") throw new ApprovalError("already_decided", `approval ${id} is ${before.status}`);
      const [row] = await tx<ApprovalRow[]>`
        UPDATE approvals SET status = ${decision.status}, decided_by = ${decision.decidedBy ?? null}, decision_note = ${decision.note ?? null}, decided_at = now()
        WHERE id = ${id} RETURNING *
      `;
      const approval = toApproval(row!);
      await audit(tx, {
        companyId,
        actorKind: "person",
        actorId: decision.decidedBy ?? null,
        action: "approval.decided",
        subjectKind: "approval",
        subjectId: id,
        taskId: before.task_id,
        before: { status: "pending" },
        after: { status: approval.status, note: approval.decisionNote, kind: approval.kind },
      });
      return approval;
    });
  }

  /** Marks pending approvals past their deadline as expired. Returns how many. */
  async expire(now: Date = new Date()): Promise<number> {
    const rows = await this.sql<{ id: string; company_id: string }[]>`
      UPDATE approvals SET status = 'expired', decided_at = ${now} WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ${now} RETURNING id, company_id
    `;
    for (const row of rows) {
      await audit(this.sql, { companyId: row.company_id, actorKind: "system", action: "approval.expired", subjectKind: "approval", subjectId: row.id, before: { status: "pending" }, after: { status: "expired" } });
    }
    return rows.length;
  }

  async forToolCall(sessionId: string, callId: string): Promise<ApprovalRecord | null> {
    const [row] = await this.sql<ApprovalRow[]>`
      SELECT * FROM approvals WHERE session_id = ${sessionId} AND subject->>'callId' = ${callId} ORDER BY created_at DESC LIMIT 1
    `;
    return row ? toApproval(row) : null;
  }

  async pendingCount(companyId: string): Promise<number> {
    const [row] = await this.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM approvals WHERE company_id = ${companyId} AND status = 'pending'`;
    return Number(row?.n ?? 0);
  }
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "not_found" | "already_decided",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}
