import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("API /v1", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildApp({ db, mode: "locale" });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("risponde allo stato di salute con il database raggiungibile", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", database: "ok", mode: "locale" });
  });

  it("crea un'azienda e la registra nell'audit", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "NextEpochs", mission: "Provare Opifer" } });
    expect(created.statusCode).toBe(201);
    const company = created.json() as { id: string; name: string; status: string };
    expect(company.name).toBe("NextEpochs");
    expect(company.status).toBe("attiva");

    const list = await app.inject({ method: "GET", url: "/v1/companies" });
    expect((list.json() as unknown[]).length).toBe(1);

    const audit = await app.inject({ method: "GET", url: `/v1/companies/${company.id}/audit` });
    expect(audit.json()).toMatchObject([{ action: "azienda.creata", subjectId: company.id }]);
  });

  it("rifiuta un'azienda senza nome", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/companies", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("crea un agente con prima revisione, organigramma e audit", async () => {
    const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Azienda agenti" } })).json() as { id: string };

    const manager = await app.inject({
      method: "POST",
      url: `/v1/companies/${company.id}/agents`,
      payload: { name: "Responsabile", role: "coordina il team", model: "claude" },
    });
    expect(manager.statusCode).toBe(201);
    const managerAgent = manager.json() as { id: string; currentRevision: number };
    expect(managerAgent.currentRevision).toBe(1);

    const worker = await app.inject({
      method: "POST",
      url: `/v1/companies/${company.id}/agents`,
      payload: { name: "Operativo", role: "esegue i task", reportsToAgentId: managerAgent.id },
    });
    expect(worker.statusCode).toBe(201);
    expect((worker.json() as { reportsToAgentId: string }).reportsToAgentId).toBe(managerAgent.id);

    const revisions = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_revisions WHERE company_id = ${company.id}`;
    expect(revisions[0]?.n).toBe(2);

    const audit = await app.inject({ method: "GET", url: `/v1/companies/${company.id}/audit` });
    const actions = (audit.json() as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(["agente.creato", "agente.creato", "azienda.creata"]);
  });

  it("non permette a un agente di rispondere a un responsabile di un'altra azienda", async () => {
    const a = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "A" } })).json() as { id: string };
    const b = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "B" } })).json() as { id: string };
    const bossOfA = (await app.inject({ method: "POST", url: `/v1/companies/${a.id}/agents`, payload: { name: "Capo A" } })).json() as { id: string };
    const res = await app.inject({ method: "POST", url: `/v1/companies/${b.id}/agents`, payload: { name: "Intruso", reportsToAgentId: bossOfA.id } });
    expect(res.statusCode).toBe(400);
  });
});
