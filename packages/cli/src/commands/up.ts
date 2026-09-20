import { spawn } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "@opifer/core";
import { migrateUp } from "@opifer/db";
import { buildApp, setupProviders } from "@opifer/server";
import { isPortOpen, openDatabase } from "../database.js";
import { requireConfig, resolveHome, type OpiferHome } from "../home.js";
import { c, say } from "../output.js";

export interface UpOptions {
  home?: string;
  detach?: boolean;
}

/** Folder of the compiled UI, next to the monorepo packages. */
export function uiDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ui", "dist");
}

async function readPid(home: OpiferHome): Promise<number | null> {
  try {
    const pid = Number((await readFile(home.pidFile, "utf8")).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runUp(options: UpOptions): Promise<void> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);

  const runningPid = await readPid(home);
  if (runningPid && isProcessAlive(runningPid)) {
    say.warn(`Opifer is already running (pid ${runningPid}) on http://${config.server.host}:${config.server.port}`);
    return;
  }
  if (await isPortOpen(config.server.port)) {
    throw new Error(`Port ${config.server.port} is in use by another program`);
  }

  if (options.detach) {
    const out = openSync(home.logFile, "a");
    const child = spawn(process.execPath, [process.argv[1]!, "up", "--home", home.dir], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.unref();
    say.ok(`Opifer started in the background (pid ${child.pid}); log in ${home.logFile}`);
    say.info(`Stop with ${c.cyan("o4r down")}`);
    return;
  }

  say.step("Embedded database");
  const db = await openDatabase(home, config);
  await migrateUp(db.handle.sql, { log: (m) => say.info(`  ${m}`) });

  const uiDir = uiDistDir();
  const providers = await setupProviders(config.models, process.env, { credentialsDir: home.credentialsDir });
  for (const r of providers.report) (r.enabled ? say.ok : say.warn)(`provider ${r.id}: ${r.detail}`);
  say.ok(`Default model: ${providers.defaultModel}`);
  const app = await buildApp({ db: db.handle, mode: "local", bus: new EventBus(), uiDir, logger: { level: "warn" }, providers, workRoot: home.workDir });
  await app.listen({ host: config.server.host, port: config.server.port });
  await writeFile(home.pidFile, `${process.pid}\n`, "utf8");

  say.ok(`Server listening on ${c.bold(`http://${config.server.host}:${config.server.port}`)}`);
  if (!existsSync(uiDir)) say.warn("Interface not compiled: run `pnpm build` to serve it from this address");
  say.info(c.dim("Ctrl-C to stop"));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    say.info("");
    say.step(`Shutting down (${signal})`);
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    await rm(home.pidFile, { force: true });
    say.ok("Stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export async function runDown(options: { home?: string }): Promise<void> {
  const home = resolveHome(options.home);
  const pid = await readPid(home);
  if (!pid || !isProcessAlive(pid)) {
    await rm(home.pidFile, { force: true });
    say.warn("Opifer does not appear to be running in the background");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    say.warn(`Process ${pid} killed forcibly`);
  } else {
    say.ok(`Opifer stopped (pid ${pid})`);
  }
  await rm(home.pidFile, { force: true });
}
