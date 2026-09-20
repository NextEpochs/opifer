/**
 * Authenticated mode from the command line: turn it on with the first owner,
 * manage people and API keys. These commands talk to the database directly,
 * so they work with the server stopped; the server picks the mode up at start.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { migrateUp } from "@opifer/db";
import { AuthService, type Role } from "@opifer/server";
import { openDatabase } from "../database.js";
import { readConfig, requireConfig, resolveHome, writeConfig, type OpiferHome } from "../home.js";
import { c, say } from "../output.js";

export interface AuthCommon {
  home?: string;
}

/** The API key the CLI itself uses on this machine, written when authenticated mode is enabled. */
export function cliKeyFile(home: OpiferHome): string {
  return path.join(home.credentialsDir, "cli.key");
}

export async function readCliKey(home: OpiferHome): Promise<string | null> {
  try {
    return (await readFile(cliKeyFile(home), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  // The answer is not echoed: the output is muted while the person types.
  const muted = { write: (_chunk: unknown, ...rest: unknown[]) => (typeof rest.at(-1) === "function" ? (rest.at(-1) as () => void)() : true) } as unknown as NodeJS.WritableStream;
  stdout.write(question);
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  const answer = await rl.question("");
  rl.close();
  stdout.write("\n");
  return answer.trim();
}

async function withAuth<T>(options: AuthCommon, fn: (auth: AuthService) => Promise<T>): Promise<T> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);
  const db = await openDatabase(home, config);
  try {
    await migrateUp(db.handle.sql);
    return await fn(new AuthService(db.handle.sql));
  } finally {
    await db.close();
  }
}

/** Turns authenticated mode on: the first owner, and an API key for this CLI. */
export async function runAuthEnable(options: AuthCommon & { email: string; password?: string; name?: string; trustProxy?: boolean }): Promise<void> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);
  const password = options.password ?? (await askSecret(`Password for ${options.email} (at least 8 characters, not echoed): `));
  await withAuth(options, async (auth) => {
    const existing = await auth.findUser(options.email);
    if (existing) {
      say.ok(`${existing.email} already exists (${existing.role})`);
    } else {
      const user = await auth.createUser({ email: options.email, password, role: "owner", ...(options.name ? { displayName: options.name } : {}) });
      say.ok(`Owner created: ${c.bold(user.email)}`);
    }
    if (!(await readCliKey(home))) {
      const { token } = await auth.createApiKey({ name: `cli on ${hostname()}`, role: "owner" });
      await mkdir(home.credentialsDir, { recursive: true, mode: 0o700 });
      await writeFile(cliKeyFile(home), `${token}\n`, { mode: 0o600 });
      await chmod(cliKeyFile(home), 0o600);
      say.ok(`API key for this command line written to ${c.dim(cliKeyFile(home))} (owner-only file)`);
    }
  });
  config.auth = { enabled: true, ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}) };
  await writeConfig(home, config);
  say.ok(`Authenticated mode on: every call to the API and the interface needs a sign-in. Restart with ${c.cyan("o4r down && o4r up --detach")}`);
  if (config.server.host === "127.0.0.1")
    say.info(`To reach it from other machines: ${c.cyan("o4r init --host 0.0.0.0")} and a reverse proxy with HTTPS in front (see docs/security.md).`);
}

export async function runAuthDisable(options: AuthCommon): Promise<void> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);
  config.auth = { enabled: false };
  await writeConfig(home, config);
  await rm(cliKeyFile(home), { force: true });
  say.warn(`Authenticated mode off: whoever reaches the port is the owner. Restart with ${c.cyan("o4r down && o4r up --detach")}`);
}

export async function runAuthStatus(options: AuthCommon): Promise<void> {
  const home = resolveHome(options.home);
  const config = await readConfig(home);
  const enabled = config?.auth?.enabled === true;
  (enabled ? say.ok : say.warn)(enabled ? "Authenticated mode: on (sign-in required)" : "Local mode: no authentication, the server is for this machine only");
  if (enabled) {
    await withAuth(options, async (auth) => {
      const users = await auth.listUsers();
      say.info(
        `${users.length} ${users.length === 1 ? "person" : "people"}: ${users.map((u) => `${u.email} (${u.role}${u.status === "disabled" ? ", disabled" : ""})`).join(", ")}`,
      );
      const keys = (await auth.listApiKeys()).filter((k) => !k.revokedAt);
      say.info(`${keys.length} active API ${keys.length === 1 ? "key" : "keys"}`);
    });
  }
}

// --- People -----------------------------------------------------------------

export async function runUserAdd(options: AuthCommon & { email: string; password?: string; name?: string; role?: string }): Promise<void> {
  const password = options.password ?? (await askSecret(`Password for ${options.email} (at least 8 characters, not echoed): `));
  await withAuth(options, async (auth) => {
    const user = await auth.createUser({ email: options.email, password, role: (options.role ?? "operator") as Role, ...(options.name ? { displayName: options.name } : {}) });
    say.ok(`${user.email} added as ${c.bold(user.role)}`);
  });
}

export async function runUserList(options: AuthCommon): Promise<void> {
  await withAuth(options, async (auth) => {
    const users = await auth.listUsers();
    if (users.length === 0) return say.info("No people yet: o4r auth enable --email you@example.com");
    for (const u of users)
      say.info(
        `${c.bold(u.email)}  ${u.role}${u.status === "disabled" ? "  disabled" : ""}  ${c.dim(u.lastLoginAt ? `last sign-in ${u.lastLoginAt.toISOString()}` : "never signed in")}  ${c.dim(u.id)}`,
      );
  });
}

export async function runUserRemove(options: AuthCommon & { email: string }): Promise<void> {
  await withAuth(options, async (auth) => {
    const user = await auth.findUser(options.email);
    if (!user) throw new Error(`no user ${options.email}`);
    await auth.removeUser(user.id);
    say.ok(`${user.email} removed`);
  });
}

export async function runUserPassword(options: AuthCommon & { email: string; password?: string }): Promise<void> {
  const password = options.password ?? (await askSecret(`New password for ${options.email} (not echoed): `));
  await withAuth(options, async (auth) => {
    const user = await auth.findUser(options.email);
    if (!user) throw new Error(`no user ${options.email}`);
    await auth.setPassword(user.id, password);
    say.ok(`Password changed for ${user.email}; their sessions are signed out`);
  });
}

export async function runUserRole(options: AuthCommon & { email: string; role: string }): Promise<void> {
  await withAuth(options, async (auth) => {
    const user = await auth.findUser(options.email);
    if (!user) throw new Error(`no user ${options.email}`);
    const updated = await auth.setRole(user.id, options.role as Role);
    say.ok(`${updated.email} is now ${c.bold(updated.role)}`);
  });
}

// --- API keys ---------------------------------------------------------------

export async function runKeyCreate(options: AuthCommon & { name: string; role?: string }): Promise<void> {
  await withAuth(options, async (auth) => {
    const { key, token } = await auth.createApiKey({ name: options.name, role: (options.role ?? "operator") as Role });
    say.ok(`API key ${c.bold(key.name)} (${key.role}) created. Shown once:`);
    say.info(`  ${token}`);
    say.info(`  Use it as ${c.dim("Authorization: Bearer <key>")}`);
  });
}

export async function runKeyList(options: AuthCommon): Promise<void> {
  await withAuth(options, async (auth) => {
    const keys = await auth.listApiKeys();
    if (keys.length === 0) return say.info("No API keys");
    for (const k of keys)
      say.info(
        `${c.bold(k.name)}  ${k.prefix}…  ${k.role}${k.revokedAt ? "  revoked" : ""}  ${c.dim(k.lastUsedAt ? `last used ${k.lastUsedAt.toISOString()}` : "never used")}  ${c.dim(k.id)}`,
      );
  });
}

export async function runKeyRevoke(options: AuthCommon & { id: string }): Promise<void> {
  await withAuth(options, async (auth) => {
    await auth.revokeApiKey(options.id);
    say.ok("API key revoked");
  });
}
