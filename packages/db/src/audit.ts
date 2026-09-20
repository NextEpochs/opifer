/**
 * Scrittura nel registro immutabile. Ogni azione che modifica stato passa di
 * qui, nella stessa transazione della modifica quando possibile.
 */

import type { Sql, TransactionSql } from "postgres";

export interface AuditInput {
  companyId: string;
  actorKind: "persona" | "agente" | "sistema";
  actorId?: string | null;
  action: string;
  subjectKind: string;
  subjectId?: string | null;
  taskId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function audit(sql: Sql | TransactionSql, entry: AuditInput): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO audit_log (company_id, actor_kind, actor_id, action, subject_kind, subject_id, task_id, before, after)
    VALUES (
      ${entry.companyId},
      ${entry.actorKind},
      ${entry.actorId ?? null},
      ${entry.action},
      ${entry.subjectKind},
      ${entry.subjectId ?? null},
      ${entry.taskId ?? null},
      ${(entry.before === undefined ? null : entry.before) as never}::jsonb,
      ${(entry.after === undefined ? null : entry.after) as never}::jsonb
    )
    RETURNING id
  `;
  return rows[0]!;
}
