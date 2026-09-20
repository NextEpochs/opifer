import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { seedDemoCompany } from "../src/demo.js";
import type { CompanyExport } from "../src/transfer.js";

/** Export a whole company and import it back: same shape, new ids, no secret value, fresh tokens. */
describe("Company export and import", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-transfer-"));
    app = await buildApp({
      db,
      mode: "local",
      providers: { providers: new ProviderRegistry().register(new FakeProvider(() => ({ kind: "text", text: "ok" }))), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
      work: { scheduler: false },
      learning: { worker: false },
      connections: { start: false, sandbox: "local" },
    });
    await app.ready();
    companyId = (await seedDemoCompany(app, { sessions: false })).companyId;
    await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/secrets`, payload: { name: "N8N_TOKEN", value: "top-secret-n8n" } });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("the export carries configuration and work, never a secret value or a session", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/companies/${companyId}/export` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("opifer-nextepochs.json");
    const doc = response.json() as CompanyExport;
    expect(doc.format).toBe("opifer-company");
    expect(doc.tables["agents"]).toHaveLength(4);
    expect(doc.tables["tasks"]!.length).toBeGreaterThanOrEqual(7);
    expect(doc.tables["skills"]!.length).toBeGreaterThanOrEqual(2);
    expect(doc.tables["routines"]!.length).toBeGreaterThanOrEqual(2);
    expect(doc.secretNames).toEqual(["N8N_TOKEN"]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain("top-secret-n8n");
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("whsec_");
    expect(Object.keys(doc.tables)).not.toContain("sessions");
    expect(Object.keys(doc.tables)).not.toContain("secrets");
  });

  it("the import creates a copy with new ids, remapped references, cleared leases and fresh credentials", async () => {
    const doc = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/export` })).json() as CompanyExport;
    const imported = await app.inject({ method: "POST", url: "/v1/companies/import?name=NextEpochs%20copy", payload: doc });
    if (imported.statusCode !== 201) console.log("IMPORT", imported.json());
    expect(imported.statusCode).toBe(201);
    const result = imported.json() as {
      companyId: string;
      counts: Record<string, number>;
      webhooks: Array<{ token: string }>;
      subscriptions: Array<{ secret: string }>;
      secretsToEnter: string[];
    };
    expect(result.companyId).not.toBe(companyId);
    expect(result.counts["agents"]).toBe(4);
    expect(result.counts["tasks"]).toBe(doc.tables["tasks"]!.length);
    expect(result.webhooks[0]!.token.startsWith("opw_")).toBe(true);
    expect(result.subscriptions[0]!.secret.startsWith("whsec_")).toBe(true);
    expect(result.secretsToEnter).toEqual(["N8N_TOKEN"]);
    // The copy is coherent: the org chart, the task tree and the skills point inside the new company.
    const agents = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/agents` })).json() as Array<{
      id: string;
      name: string;
      reportsToAgentId: string | null;
    }>;
    const philip = agents.find((a) => a.name === "Philip")!;
    expect(
      agents
        .filter((a) => a.reportsToAgentId === philip.id)
        .map((a) => a.name)
        .sort(),
    ).toEqual(["Leo", "Nora", "Sam"]);
    const tasks = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/tasks?status=todo,in_progress,in_review,blocked,done` })).json() as Array<{
      status: string;
      assigneeAgentId: string | null;
      leaseSessionId: string | null;
      projectId: string | null;
    }>;
    expect(tasks.every((t) => t.leaseSessionId === null)).toBe(true);
    expect(tasks.every((t) => !t.assigneeAgentId || agents.some((a) => a.id === t.assigneeAgentId))).toBe(true);
    const projects = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/projects` })).json() as Array<{ id: string }>;
    expect(tasks.every((t) => !t.projectId || projects.some((p) => p.id === t.projectId))).toBe(true);
    const skills = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/skills` })).json() as Array<{ name: string; currentVersion: number }>;
    expect(skills.map((s) => s.name).sort()).toEqual((doc.tables["skills"] as Array<{ name: string }>).map((s) => s.name).sort());
    const overview = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/overview` })).json() as { agents: unknown[] };
    expect(overview.agents).toHaveLength(4);
    // Secrets must be entered again: the connection that needs one is not healthy yet.
    const connections = (await app.inject({ method: "GET", url: `/v1/companies/${result.companyId}/connections` })).json() as Array<{ name: string; secretNames: string[] }>;
    expect(connections.find((c) => c.name === "n8n_report")?.secretNames).toEqual(["N8N_TOKEN"]);
  });

  it("refuses a document that is not an Opifer export", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/companies/import", payload: { format: "something-else", version: 1 } });
    expect(bad.statusCode).toBe(400);
  });
});
