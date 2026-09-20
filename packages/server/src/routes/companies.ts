import { audit } from "@opifer/db";
import type { FastifyInstance } from "fastify";

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
}
