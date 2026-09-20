/**
 * Authenticated mode: who is calling, and what may they do.
 *
 * People sign in with an email and a password (scrypt, never stored in clear);
 * the interface keeps an HttpOnly session cookie; the CLI and integrations use
 * API keys (`opk_…`, stored hashed, shown once). Roles are server-wide in this
 * version: one team per server.
 *
 *   observer  reads everything
 *   operator  does the daily work: chat, tasks, approvals, routine runs
 *   admin     configures the company: agents, budgets, policies, secrets, connections, learning
 *   owner     people, API keys, emergency stop, export and import
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";

const scrypt = (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))));

export type Role = "owner" | "admin" | "operator" | "observer";
export const ROLES: Role[] = ["observer", "operator", "admin", "owner"];
const RANK: Record<Role, number> = { observer: 0, operator: 1, admin: 2, owner: 3 };

export function atLeast(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

export interface Actor {
  /** A signed-in person or an API key. */
  kind: "user" | "api_key";
  /** The user id for a person, the key id for an API key. */
  id: string;
  /** The person behind the actor, when there is one. */
  userId: string | null;
  name: string;
  email: string | null;
  role: Role;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "disabled";
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  companyId: string | null;
  userId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  role: Role;
  status: "active" | "disabled";
  last_login_at: Date | null;
  created_at: Date;
}

interface ApiKeyRow {
  id: string;
  company_id: string | null;
  user_id: string | null;
  name: string;
  prefix: string;
  role: Role;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export class AuthError extends Error {
  constructor(
    public readonly code: "invalid_input" | "not_found" | "conflict" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new AuthError("invalid_input", "the password needs at least 8 characters");
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email ?? "",
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function toKey(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    role: row.role,
    companyId: row.company_id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export const SESSION_COOKIE = "opifer_session";
export const API_KEY_PREFIX = "opk_";

export class AuthService {
  private readonly sessionMs: number;

  constructor(
    private readonly sql: Sql,
    options: { sessionDays?: number } = {},
  ) {
    this.sessionMs = (options.sessionDays ?? 30) * 24 * 60 * 60 * 1000;
  }

  // --- People ---------------------------------------------------------------

  async createUser(input: { email: string; displayName?: string; password: string; role: Role }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("invalid_input", "a valid email address is required");
    if (!ROLES.includes(input.role)) throw new AuthError("invalid_input", `unknown role ${input.role}`);
    const passwordHash = await hashPassword(input.password);
    const displayName = input.displayName?.trim() || email.split("@")[0]!;
    return this.sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
      if (existing) throw new AuthError("conflict", `a user with the email ${email} already exists`);
      const [row] = await tx<UserRow[]>`
        INSERT INTO users (display_name, email, password_hash, role) VALUES (${displayName}, ${email}, ${passwordHash}, ${input.role}) RETURNING *
      `;
      // A membership in every company keeps the per-company record for a later per-company mode.
      await tx`INSERT INTO memberships (company_id, user_id, role) SELECT id, ${row!.id}, ${input.role} FROM companies ON CONFLICT DO NOTHING`;
      return toUser(row!);
    });
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.sql<UserRow[]>`SELECT * FROM users WHERE email IS NOT NULL ORDER BY created_at`;
    return rows.map(toUser);
  }

  async findUser(idOrEmail: string): Promise<AuthUser | null> {
    const [row] = await this.sql<UserRow[]>`SELECT * FROM users WHERE id::text = ${idOrEmail} OR email = ${idOrEmail.toLowerCase()} LIMIT 1`;
    return row ? toUser(row) : null;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const rows = await this.sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId} RETURNING id`;
    if (rows.length === 0) throw new AuthError("not_found", "user not found");
    // Every session of that person ends: a changed password signs everyone out.
    await this.sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  }

  async setRole(userId: string, role: Role): Promise<AuthUser> {
    if (!ROLES.includes(role)) throw new AuthError("invalid_input", `unknown role ${role}`);
    const [row] = await this.sql<UserRow[]>`UPDATE users SET role = ${role} WHERE id = ${userId} RETURNING *`;
    if (!row) throw new AuthError("not_found", "user not found");
    await this.sql`UPDATE memberships SET role = ${role} WHERE user_id = ${userId}`;
    return toUser(row);
  }

  async setStatus(userId: string, status: "active" | "disabled"): Promise<AuthUser> {
    const [row] = await this.sql<UserRow[]>`UPDATE users SET status = ${status} WHERE id = ${userId} RETURNING *`;
    if (!row) throw new AuthError("not_found", "user not found");
    if (status === "disabled") await this.sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
    return toUser(row);
  }

  async removeUser(userId: string): Promise<void> {
    const owners = await this.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users WHERE role = 'owner' AND status = 'active' AND id <> ${userId}`;
    const [target] = await this.sql<UserRow[]>`SELECT * FROM users WHERE id = ${userId}`;
    if (!target) throw new AuthError("not_found", "user not found");
    if (target.role === "owner" && Number(owners[0]?.count ?? 0) === 0) throw new AuthError("forbidden", "the last owner cannot be removed");
    await this.sql`DELETE FROM users WHERE id = ${userId}`;
  }

  async countUsers(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users WHERE email IS NOT NULL AND password_hash IS NOT NULL`;
    return Number(row?.count ?? 0);
  }

  // --- Sessions -------------------------------------------------------------

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; expiresAt: Date; user: AuthUser } | null> {
    const [row] = await this.sql<UserRow[]>`SELECT * FROM users WHERE email = ${email.trim().toLowerCase()}`;
    // The password is always checked, so a wrong email costs the same time as a wrong password.
    const ok = await verifyPassword(password, row?.password_hash ?? null);
    if (!row || !ok || row.status !== "active") return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.sessionMs);
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES (${row.id}, ${sha256(token)}, ${expiresAt}, ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 300) ?? null})`;
      await tx`UPDATE users SET last_login_at = now() WHERE id = ${row.id}`;
      await tx`DELETE FROM user_sessions WHERE expires_at < now()`;
    });
    return { token, expiresAt, user: toUser(row) };
  }

  async resolveSession(token: string): Promise<Actor | null> {
    const [row] = await this.sql<(UserRow & { session_id: string; last_seen_at: Date })[]>`
      SELECT u.*, s.id AS session_id, s.last_seen_at FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now() AND u.status = 'active'
    `;
    if (!row) return null;
    // Sliding expiry, refreshed at most once an hour.
    if (Date.now() - row.last_seen_at.getTime() > 60 * 60 * 1000) {
      await this.sql`UPDATE user_sessions SET last_seen_at = now(), expires_at = ${new Date(Date.now() + this.sessionMs)} WHERE id = ${row.session_id}`;
    }
    return { kind: "user", id: row.id, userId: row.id, name: row.display_name, email: row.email, role: row.role };
  }

  async logout(token: string): Promise<void> {
    await this.sql`DELETE FROM user_sessions WHERE token_hash = ${sha256(token)}`;
  }

  // --- API keys -------------------------------------------------------------

  async createApiKey(input: { name: string; role: Role; userId?: string | null; companyId?: string | null }): Promise<{ key: ApiKeyInfo; token: string }> {
    if (!input.name.trim()) throw new AuthError("invalid_input", "a name is required");
    if (!ROLES.includes(input.role)) throw new AuthError("invalid_input", `unknown role ${input.role}`);
    const token = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const [row] = await this.sql<ApiKeyRow[]>`
      INSERT INTO api_keys (company_id, user_id, name, token_hash, prefix, role)
      VALUES (${input.companyId ?? null}, ${input.userId ?? null}, ${input.name.trim()}, ${sha256(token)}, ${token.slice(0, 10)}, ${input.role}) RETURNING *
    `;
    return { key: toKey(row!), token };
  }

  async listApiKeys(): Promise<ApiKeyInfo[]> {
    const rows = await this.sql<ApiKeyRow[]>`SELECT * FROM api_keys ORDER BY created_at`;
    return rows.map(toKey);
  }

  async revokeApiKey(id: string): Promise<void> {
    const rows = await this.sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) throw new AuthError("not_found", "API key not found or already revoked");
  }

  async resolveApiKey(token: string): Promise<Actor | null> {
    const [row] = await this.sql<ApiKeyRow[]>`SELECT * FROM api_keys WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL`;
    if (!row) return null;
    void this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`.catch(() => {});
    return { kind: "api_key", id: row.id, userId: row.user_id, name: row.name, email: null, role: row.role };
  }
}

/**
 * The role a request needs, from its method and path. Reads are for everyone signed in; the daily
 * work for operators; configuration for admins; people, keys and the emergency stop for owners.
 */
export function requiredRole(method: string, url: string): Role {
  const path = url.split("?")[0]!;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    if (/^\/v1\/(users|api-keys)(\/|$)/.test(path)) return "owner";
    return "observer";
  }
  if (/^\/v1\/(users|api-keys)(\/|$)/.test(path)) return "owner";
  if (/^\/v1\/companies(\/[^/]+\/(stop|resume|export)|\/import)?$/.test(path)) return "owner";
  if (/^\/v1\/companies\/[^/]+\/(budgets|tool-policies|secrets|secret-bindings|learning|connections|webhooks|subscriptions|channels|routines)(\/|$)/.test(path)) {
    // Running a routine now is daily work; creating or changing one is configuration.
    if (/\/routines\/[^/]+\/run$/.test(path)) return "operator";
    return "admin";
  }
  if (/^\/v1\/companies\/demo$/.test(path)) return "admin";
  if (/^\/v1\/companies\/[^/]+\/agents$/.test(path)) return "admin";
  if (/^\/v1\/agents\/[^/]+(\/(status|revisions\/[^/]+\/restore))?$/.test(path)) return "admin";
  if (/^\/v1\/(connections|webhooks|subscriptions|channels|channel-bindings)(\/|$)/.test(path)) return "admin";
  if (/^\/v1\/(memories|skills|promotions)(\/|$)/.test(path)) return "operator";
  return "operator";
}

/** Reads the session token from the Cookie header. */
export function sessionTokenOf(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
