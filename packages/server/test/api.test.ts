import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("API /v1", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildApp({ db, mode: "local", connections: { start: false, sandbox: "local" } });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("answers the health check with the database reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", database: "ok", mode: "local" });
  });

  it("creates a company and records it in the audit log", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "NextEpochs", mission: "Try Opifer" } });
    expect(created.statusCode).toBe(201);
    const company = created.json() as { id: string; name: string; status: string };
    expect(company.name).toBe("NextEpochs");
    expect(company.status).toBe("active");

    const list = await app.inject({ method: "GET", url: "/v1/companies" });
    expect((list.json() as unknown[]).length).toBe(1);

    const audit = await app.inject({ method: "GET", url: `/v1/companies/${company.id}/audit` });
    expect(audit.json()).toMatchObject([{ action: "company.created", subjectId: company.id }]);
  });

  it("rejects a company without a name", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/companies", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("creates an agent with first revision, org chart and audit", async () => {
    const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Agents company" } })).json() as { id: string };

    const manager = await app.inject({
      method: "POST",
      url: `/v1/companies/${company.id}/agents`,
      payload: { name: "Manager", role: "coordinates the team", model: "claude" },
    });
    expect(manager.statusCode).toBe(201);
    const managerAgent = manager.json() as { id: string; currentRevision: number };
    expect(managerAgent.currentRevision).toBe(1);

    const worker = await app.inject({
      method: "POST",
      url: `/v1/companies/${company.id}/agents`,
      payload: { name: "Worker", role: "executes the tasks", reportsToAgentId: managerAgent.id },
    });
    expect(worker.statusCode).toBe(201);
    expect((worker.json() as { reportsToAgentId: string }).reportsToAgentId).toBe(managerAgent.id);

    const revisions = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_revisions WHERE company_id = ${company.id}`;
    expect(revisions[0]?.n).toBe(2);

    const audit = await app.inject({ method: "GET", url: `/v1/companies/${company.id}/audit` });
    const actions = (audit.json() as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(["agent.created", "agent.created", "company.created"]);
  });

  it("does not allow an agent to report to a manager of another company", async () => {
    const a = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "A" } })).json() as { id: string };
    const b = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "B" } })).json() as { id: string };
    const bossOfA = (await app.inject({ method: "POST", url: `/v1/companies/${a.id}/agents`, payload: { name: "Boss A" } })).json() as { id: string };
    const res = await app.inject({ method: "POST", url: `/v1/companies/${b.id}/agents`, payload: { name: "Intruder", reportsToAgentId: bossOfA.id } });
    expect(res.statusCode).toBe(400);
  });
});
