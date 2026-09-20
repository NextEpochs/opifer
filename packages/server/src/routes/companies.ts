import { OPIFER_VERSION } from "@opifer/core";
import { audit } from "@opifer/db";
import type { FastifyInstance } from "fastify";
import { seedDemoCompany } from "../demo.js";
import { exportCompany, importCompany, type CompanyExport } from "../transfer.js";

interface CompanyRow {
  id: string;
  name: string;
  mission: string | null;
  status: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export function toCompany(row: CompanyRow) {
  return {
    id: row.id,
    name: row.name,
    mission: row.mission,
    status: row.status,
    settings: row.settings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const createBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    mission: { type: "string", maxLength: 5000 },
  },
} as const;

export async function registerCompanyRoutes(app: FastifyInstance): Promise<void> {
  const { sql } = app.opifer.db;

  app.get("/companies", async () => {
    const rows = await sql<CompanyRow[]>`SELECT * FROM companies ORDER BY created_at`;
    return rows.map(toCompany);
  });

  app.get<{ Params: { id: string } }>("/companies/:id", async (request, reply) => {
    const [row] = await sql<CompanyRow[]>`SELECT * FROM companies WHERE id = ${request.params.id}`;
    if (!row) return reply.code(404).send({ error: "company not found" });
    return toCompany(row);
  });

  app.post<{ Body: { name: string; mission?: string } }>("/companies", { schema: { body: createBody } }, async (request, reply) => {
    const created = await sql.begin(async (tx) => {
      const [row] = await tx<CompanyRow[]>`
        INSERT INTO companies (name, mission) VALUES (${request.body.name}, ${request.body.mission ?? null}) RETURNING *
      `;
      await audit(tx, {
        companyId: row!.id,
        actorKind: "person",
        action: "company.created",
        subjectKind: "company",
        subjectId: row!.id,
        after: { name: row!.name, mission: row!.mission },
      });
      return row!;
    });
    const company = toCompany(created);
    app.opifer.bus.publish("company.created", company.id, company);
    return reply.code(201).send(company);
  });

  // Emergency stop: one command stops every agent, suspends the routines and denies new budget reservations until a person resumes.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/companies/:id/stop", async (request, reply) => {
    const [row] = await sql<CompanyRow[]>`UPDATE companies SET status = 'suspended' WHERE id = ${request.params.id} AND status <> 'archived' RETURNING *`;
    if (!row) return reply.code(404).send({ error: "company not found" });
    const stoppedSessions = app.opifer.runtime?.interruptCompany(row.id) ?? [];
    const routines = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM routines WHERE company_id = ${row.id} AND enabled`;
    await audit(sql, {
      companyId: row.id,
      actorKind: "person",
      action: "company.stopped",
      subjectKind: "company",
      subjectId: row.id,
      after: { reason: request.body?.reason ?? null, interruptedSessions: stoppedSessions.length, routinesSuspended: Number(routines[0]?.n ?? 0) },
    });
    app.opifer.bus.publish("company.stopped", row.id, { reason: request.body?.reason ?? null, interruptedSessions: stoppedSessions });
    return { ...toCompany(row), interruptedSessions: stoppedSessions.length, routinesSuspended: Number(routines[0]?.n ?? 0) };
  });

  // The demo company: a team, goals, tasks in every state, memories, skills, routines and connections; no model is called.
  app.post<{ Body: { name?: string; mission?: string } }>("/companies/demo", async (request, reply) => {
    const { companyId } = await seedDemoCompany(app, {
      sessions: false,
      ...(request.body?.name ? { name: request.body.name } : {}),
      ...(request.body?.mission ? { mission: request.body.mission } : {}),
    });
    const [row] = await sql<CompanyRow[]>`SELECT * FROM companies WHERE id = ${companyId}`;
    const company = toCompany(row!);
    app.opifer.bus.publish("company.created", company.id, company);
    return reply.code(201).send(company);
  });

  // Export and import: configuration and work, never secret values or history (see transfer.ts).
  app.get<{ Params: { id: string } }>("/companies/:id/export", async (request, reply) => {
    const doc = await exportCompany(sql, request.params.id, OPIFER_VERSION);
    if (!doc) return reply.code(404).send({ error: "company not found" });
    reply.header(
      "content-disposition",
      `attachment; filename="opifer-${String(doc.company["name"])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}.json"`,
    );
    return doc;
  });

  app.post<{ Body: CompanyExport & { name?: string }; Querystring: { name?: string } }>("/companies/import", { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    try {
      const result = await importCompany(sql, request.body, { webhooks: app.opifer.webhooks, events: app.opifer.events }, request.query.name ? { name: request.query.name } : {});
      const [row] = await sql<CompanyRow[]>`SELECT * FROM companies WHERE id = ${result.companyId}`;
      app.opifer.bus.publish("company.created", result.companyId, toCompany(row!));
      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/companies/:id/resume", async (request, reply) => {
    const [row] = await sql<CompanyRow[]>`UPDATE companies SET status = 'active' WHERE id = ${request.params.id} AND status = 'suspended' RETURNING *`;
    if (!row) return reply.code(409).send({ error: "the company is not stopped" });
    // Work interrupted by the stop goes on: every open task with an agent is woken again (deduplicated while pending).
    const open = await app.opifer.work.listTasks(row.id, { status: ["todo"] });
    let rewoken = 0;
    for (const t of open) {
      if (!t.assigneeAgentId) continue;
      await app.opifer.work.wake(row.id, t.assigneeAgentId, "assignment", { taskId: t.id, dedupeKey: `assignment:${t.id}` });
      rewoken++;
    }
    await audit(sql, { companyId: row.id, actorKind: "person", action: "company.resumed", subjectKind: "company", subjectId: row.id, after: { rewoken } });
    app.opifer.bus.publish("company.resumed", row.id, { rewoken });
    return { ...toCompany(row), rewoken };
  });
}
