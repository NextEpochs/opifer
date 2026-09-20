import { audit } from "@opifer/db";
import type { FastifyInstance } from "fastify";

interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  role: string;
  reports_to_agent_id: string | null;
  reports_to_user_id: string | null;
  model: string | null;
  status: string;
  current_revision: number;
  created_at: Date;
  updated_at: Date;
}

function toAgent(row: AgentRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    role: row.role,
    reportsToAgentId: row.reports_to_agent_id,
    reportsToUserId: row.reports_to_user_id,
    model: row.model,
    status: row.status,
    currentRevision: row.current_revision,
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
    role: { type: "string", maxLength: 2000 },
    model: { type: "string", maxLength: 200 },
    reportsToAgentId: { type: "string", format: "uuid" },
  },
} as const;

interface CreateAgentBody {
  name: string;
  role?: string;
  model?: string;
  reportsToAgentId?: string;
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  const { sql } = app.opifer.db;

  app.get<{ Params: { id: string } }>("/companies/:id/agents", async (request) => {
    const rows = await sql<AgentRow[]>`
      SELECT * FROM agents WHERE company_id = ${request.params.id} ORDER BY created_at
    `;
    return rows.map(toAgent);
  });

  app.post<{ Params: { id: string }; Body: CreateAgentBody }>(
    "/companies/:id/agents",
    { schema: { body: createBody } },
    async (request, reply) => {
      const companyId = request.params.id;
      const [company] = await sql<{ id: string }[]>`SELECT id FROM companies WHERE id = ${companyId}`;
      if (!company) return reply.code(404).send({ error: "azienda non trovata" });

      const body = request.body;
      if (body.reportsToAgentId) {
        const [manager] = await sql<{ id: string }[]>`
          SELECT id FROM agents WHERE id = ${body.reportsToAgentId} AND company_id = ${companyId}
        `;
        if (!manager) return reply.code(400).send({ error: "il responsabile indicato non esiste in questa azienda" });
      }

      const config = { role: body.role ?? "", model: body.model ?? null };
      const created = await sql.begin(async (tx) => {
        const [row] = await tx<AgentRow[]>`
          INSERT INTO agents (company_id, name, role, model, reports_to_agent_id)
          VALUES (${companyId}, ${body.name}, ${config.role}, ${config.model}, ${body.reportsToAgentId ?? null})
          RETURNING *
        `;
        await tx`
          INSERT INTO agent_revisions (company_id, agent_id, revision, config, author_kind, note)
          VALUES (${companyId}, ${row!.id}, 1, ${config as never}::jsonb, 'persona', 'creazione')
        `;
        await audit(tx, {
          companyId,
          actorKind: "persona",
          action: "agente.creato",
          subjectKind: "agente",
          subjectId: row!.id,
          after: { name: row!.name, ...config },
        });
        return row!;
      });

      const agent = toAgent(created);
      app.opifer.bus.publish("agente.creato", companyId, agent);
      return reply.code(201).send(agent);
    },
  );
}
