/**
 * Sign-in, the current person, people and API keys. Present in every mode:
 * in local mode `/auth/me` says so and nothing else is needed.
 */

import type { FastifyInstance } from "fastify";
import { AuthError, ROLES, SESSION_COOKIE, sessionTokenOf, type AuthService, type Role } from "../auth.js";

const loginBody = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: { email: { type: "string", maxLength: 200 }, password: { type: "string", maxLength: 200 } },
} as const;

const userBody = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", maxLength: 200 },
    password: { type: "string", maxLength: 200 },
    displayName: { type: "string", maxLength: 100 },
    role: { type: "string", enum: ROLES },
  },
} as const;

const userPatch = {
  type: "object",
  additionalProperties: false,
  properties: { password: { type: "string", maxLength: 200 }, role: { type: "string", enum: ROLES }, status: { type: "string", enum: ["active", "disabled"] } },
} as const;

const keyBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 }, role: { type: "string", enum: ROLES }, companyId: { type: "string", format: "uuid" } },
} as const;

function fail(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown): unknown {
  if (error instanceof AuthError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "forbidden" ? 403 : 400;
    return reply.code(status).send({ error: error.message });
  }
  throw error;
}

export function cookieFor(token: string | null, options: { secure: boolean; maxAgeSeconds: number }): string {
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? options.maxAgeSeconds : 0}`;
  return options.secure ? `${base}; Secure` : base;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService | null; mode: string; sessionDays: number; loginFailures: Map<string, { count: number; since: number }> },
): Promise<void> {
  const { auth } = deps;

  app.get("/auth/me", async (request) => {
    if (!auth) return { mode: deps.mode, user: null };
    const actor = request.actor ?? null;
    return { mode: deps.mode, user: actor ? { id: actor.id, name: actor.name, email: actor.email, role: actor.role, kind: actor.kind } : null };
  });

  app.post<{ Body: { email: string; password: string } }>("/auth/login", { schema: { body: loginBody } }, async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "this installation runs in local mode: nobody needs to sign in" });
    const userAgent = request.headers["user-agent"];
    const result = await auth.login(request.body.email, request.body.password, { ip: request.ip, ...(userAgent ? { userAgent } : {}) });
    if (!result) {
      const now = Date.now();
      const entry = deps.loginFailures.get(request.ip) ?? { count: 0, since: now };
      if (now - entry.since > 60_000) Object.assign(entry, { count: 0, since: now });
      entry.count++;
      deps.loginFailures.set(request.ip, entry);
      if (deps.loginFailures.size > 10_000) deps.loginFailures.clear();
      return reply.code(401).send({ error: "wrong email or password" });
    }
    deps.loginFailures.delete(request.ip);
    reply.header("set-cookie", cookieFor(result.token, { secure: request.protocol === "https", maxAgeSeconds: deps.sessionDays * 86400 }));
    return { user: { id: result.user.id, name: result.user.displayName, email: result.user.email, role: result.user.role, kind: "user" } };
  });

  app.post("/auth/logout", async (request, reply) => {
    if (!auth) return reply.code(204).send();
    const token = sessionTokenOf(request.headers.cookie);
    if (token) await auth.logout(token);
    reply.header("set-cookie", cookieFor(null, { secure: request.protocol === "https", maxAgeSeconds: 0 }));
    return reply.code(204).send();
  });

  // --- People (owner) ---------------------------------------------------------

  app.get("/users", async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no users" });
    return auth.listUsers();
  });

  app.post<{ Body: { email: string; password: string; displayName?: string; role?: Role } }>("/users", { schema: { body: userBody } }, async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no users" });
    try {
      const user = await auth.createUser({
        email: request.body.email,
        password: request.body.password,
        role: request.body.role ?? "operator",
        ...(request.body.displayName ? { displayName: request.body.displayName } : {}),
      });
      return reply.code(201).send(user);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: { password?: string; role?: Role; status?: "active" | "disabled" } }>(
    "/users/:id",
    { schema: { body: userPatch } },
    async (request, reply) => {
      if (!auth) return reply.code(404).send({ error: "local mode has no users" });
      try {
        if (request.body.password) await auth.setPassword(request.params.id, request.body.password);
        if (request.body.role) await auth.setRole(request.params.id, request.body.role);
        if (request.body.status) await auth.setStatus(request.params.id, request.body.status);
        const user = await auth.findUser(request.params.id);
        return user ?? reply.code(404).send({ error: "user not found" });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/users/:id", async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no users" });
    if (request.actor?.kind === "user" && request.actor.id === request.params.id) return reply.code(400).send({ error: "you cannot remove yourself" });
    try {
      await auth.removeUser(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --- API keys (owner) -------------------------------------------------------

  app.get("/api-keys", async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no API keys" });
    return auth.listApiKeys();
  });

  app.post<{ Body: { name: string; role?: Role; companyId?: string } }>("/api-keys", { schema: { body: keyBody } }, async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no API keys" });
    try {
      const { key, token } = await auth.createApiKey({
        name: request.body.name,
        role: request.body.role ?? "operator",
        userId: request.actor?.userId ?? null,
        companyId: request.body.companyId ?? null,
      });
      // The token is shown once.
      return reply.code(201).send({ ...key, token });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api-keys/:id", async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: "local mode has no API keys" });
    try {
      await auth.revokeApiKey(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
