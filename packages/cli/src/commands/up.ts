import { spawn } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "@opifer/core";
import { migrateUp } from "@opifer/db";
import { buildApp } from "@opifer/server";
import { isPortOpen, openDatabase } from "../database.js";
import { requireConfig, resolveHome, type OpiferHome } from "../home.js";
import { c, say } from "../output.js";

export interface UpOptions {
  home?: string;
  detach?: boolean;
}

/** Cartella della UI compilata, accanto ai pacchetti del monorepo. */
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
    say.warn(`Opifer è già avviato (pid ${runningPid}) su http://${config.server.host}:${config.server.port}`);
    return;
  }
  if (await isPortOpen(config.server.port)) {
    throw new Error(`La porta ${config.server.port} è occupata da un altro programma`);
  }

  if (options.detach) {
    const out = openSync(home.logFile, "a");
    const child = spawn(process.execPath, [process.argv[1]!, "up", "--home", home.dir], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.unref();
    say.ok(`Opifer avviato in background (pid ${child.pid}); log in ${home.logFile}`);
    say.info(`Ferma con ${c.cyan("o4r down")}`);
    return;
  }

  say.step("Database incorporato");
  const db = await openDatabase(home, config);
  await migrateUp(db.handle.sql, { log: (m) => say.info(`  ${m}`) });

  const uiDir = uiDistDir();
  const app = await buildApp({ db: db.handle, mode: "locale", bus: new EventBus(), uiDir, logger: false });
  await app.listen({ host: config.server.host, port: config.server.port });
  await writeFile(home.pidFile, `${process.pid}\n`, "utf8");

  say.ok(`Server in ascolto su ${c.bold(`http://${config.server.host}:${config.server.port}`)}`);
  if (!existsSync(uiDir)) say.warn("Interfaccia non compilata: esegui `pnpm build` per servirla da questo indirizzo");
  say.info(c.dim("Ctrl-C per fermare"));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    say.info("");
    say.step(`Arresto (${signal})`);
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    await rm(home.pidFile, { force: true });
    say.ok("Fermato");
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
    say.warn("Opifer non risulta avviato in background");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    say.warn(`Processo ${pid} terminato forzatamente`);
  } else {
    say.ok(`Opifer fermato (pid ${pid})`);
  }
  await rm(home.pidFile, { force: true });
}
