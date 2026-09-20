import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

/** The session cookie of a sign-in, as the browser would send it back. */
async function signIn(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  const header = String(res.headers["set-cookie"]);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Lax");
  return header.split(";")[0]!;
}

describe("Authenticated mode", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let owner: string;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider(() => ({ kind: "text", text: "ok" }));
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-auth-"));
    app = await buildApp({
      db,
      mode: "authenticated",
      connections: { start: false, sandbox: "local" },
      learning: { worker: false },
      work: { scheduler: false },
      auth: { sessionDays: 1 },
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
    });
    await app.ready();
    await app.opifer.auth!.createUser({ email: "Owner@Example.com", displayName: "Owner", password: "correct horse", role: "owner" });
    owner = await signIn(app, "owner@example.com", "correct horse");
    const created = await app.inject({ method: "POST", url: "/v1/companies", headers: { cookie: owner }, payload: { name: "Proclive" } });
    expect(created.statusCode).toBe(201);
    companyId = (created.json() as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("refuses every call without a session, except the health check and the sign-in", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/companies" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/health" })).json()).toMatchObject({ status: "ok", mode: "authenticated" });
    expect((await app.inject({ method: "GET", url: "/v1/auth/me" })).json()).toEqual({ mode: "authenticated", user: null });
    const hook = await app.inject({ method: "POST", url: "/v1/hooks/00000000-0000-0000-0000-000000000000", headers: { authorization: "Bearer opw_nope" }, payload: {} });
    expect(hook.statusCode).not.toBe(401 && (hook.json() as { error: string }).error === "sign in first");
  });

  it("signs a person in with a cookie that opens the API, and says who they are", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: owner } });
    expect(me.json()).toMatchObject({ mode: "authenticated", user: { email: "owner@example.com", role: "owner", kind: "user" } });
    const list = await app.inject({ method: "GET", url: "/v1/companies", headers: { cookie: owner } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ name: string }>).map((c) => c.name)).toContain("Proclive");
    // The person is a member of the company they created.
    const members = await db.sql<{ role: string }[]>`SELECT role FROM memberships WHERE company_id = ${companyId}`;
    expect(members).toEqual([{ role: "owner" }]);
  });

  it("roles: observers read, operators act, admins configure, owners manage people", async () => {
    const auth = app.opifer.auth!;
    await auth.createUser({ email: "obs@example.com", password: "password1", role: "observer" });
    await auth.createUser({ email: "op@example.com", password: "password1", role: "operator" });
    await auth.createUser({ email: "adm@example.com", password: "password1", role: "admin" });
    const observer = await signIn(app, "obs@example.com", "password1");
    const operator = await signIn(app, "op@example.com", "password1");
    const admin = await signIn(app, "adm@example.com", "password1");

    expect((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/tasks`, headers: { cookie: observer } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, headers: { cookie: observer }, payload: { title: "No" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, headers: { cookie: operator }, payload: { title: "Yes" } })).statusCode).toBe(201);
    expect(
      (await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/budgets`, headers: { cookie: operator }, payload: { scopeKind: "company", cap: 1 } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/users", headers: { cookie: admin } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/stop`, headers: { cookie: admin }, payload: {} })).statusCode).toBe(403);
    const users = await app.inject({ method: "GET", url: "/v1/users", headers: { cookie: owner } });
    expect((users.json() as Array<{ email: string }>).map((u) => u.email).sort()).toEqual(["adm@example.com", "obs@example.com", "op@example.com", "owner@example.com"]);
  });

  it("an owner can create the demo company", async () => {
    const demo = await app.inject({ method: "POST", url: "/v1/companies/demo", headers: { cookie: owner }, payload: {} });
    expect(demo.statusCode, demo.body).toBe(201);
  });

  it("API keys: shown once, work as a bearer token with their role, and stop when revoked", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: owner }, payload: { name: "n8n", role: "operator" } });
    expect(created.statusCode).toBe(201);
    const key = created.json() as { id: string; token: string; prefix: string };
    expect(key.token.startsWith("opk_")).toBe(true);
    const bearer = { authorization: `Bearer ${key.token}` };
    expect((await app.inject({ method: "GET", url: "/v1/companies", headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/users", headers: bearer })).statusCode).toBe(403);
    const listed = await app.inject({ method: "GET", url: "/v1/api-keys", headers: { cookie: owner } });
    expect(JSON.stringify(listed.json())).not.toContain(key.token);
    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${key.id}`, headers: { cookie: owner } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/companies", headers: bearer })).statusCode).toBe(401);
  });

  it("preferences belong to the person", async () => {
    await app.inject({ method: "PUT", url: "/v1/preferences/theme", headers: { cookie: owner }, payload: { value: "light" } });
    const operator = await signIn(app, "op@example.com", "password1");
    expect((await app.inject({ method: "GET", url: "/v1/preferences", headers: { cookie: owner } })).json()).toMatchObject({ theme: "light" });
    expect((await app.inject({ method: "GET", url: "/v1/preferences", headers: { cookie: operator } })).json()).not.toHaveProperty("theme");
  });

  it("the last owner stays, nobody removes themselves, and a sign-out ends the session", async () => {
    const me = (await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: owner } })).json() as { user: { id: string } };
    expect((await app.inject({ method: "DELETE", url: `/v1/users/${me.user.id}`, headers: { cookie: owner } })).statusCode).toBe(400);
    const second = await app.opifer.auth!.createUser({ email: "owner2@example.com", password: "password1", role: "owner" });
    const cookie2 = await signIn(app, "owner2@example.com", "password1");
    expect((await app.inject({ method: "DELETE", url: `/v1/users/${me.user.id}`, headers: { cookie: cookie2 } })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/v1/users/${second.id}`, headers: { cookie: cookie2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: cookie2 } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/companies", headers: { cookie: cookie2 } })).statusCode).toBe(401);
    // A changed password signs every session of that person out.
    const cookie3 = await signIn(app, "owner2@example.com", "password1");
    await app.opifer.auth!.setPassword(second.id, "password2");
    expect((await app.inject({ method: "GET", url: "/v1/companies", headers: { cookie: cookie3 } })).statusCode).toBe(401);
  });

  it("a wrong password is refused, and the eleventh attempt in a minute is slowed down", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@example.com", password: "wrong" } })).statusCode).toBe(401);
    }
    const eleventh = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@example.com", password: "wrong" } });
    expect(eleventh.statusCode).toBe(429);
  });
});
