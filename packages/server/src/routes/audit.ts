import type { FastifyInstance } from "fastify";

interface AuditRow {
  id: string;
  company_id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  subject_kind: string;
  subject_id: string | null;
  task_id: string | null;
  before: unknown;
  after: unknown;
  occurred_at: Date;
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const { sql } = app.opifer.db;

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/companies/:id/audit", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 500);
    const rows = await sql<AuditRow[]>`
      SELECT * FROM audit_log WHERE company_id = ${request.params.id}
      ORDER BY occurred_at DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      actorKind: r.actor_kind,
      actorId: r.actor_id,
      action: r.action,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      taskId: r.task_id,
      before: r.before,
      after: r.after,
      occurredAt: r.occurred_at.toISOString(),
    }));
  });
}
