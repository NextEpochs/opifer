/**
 * La cartella di Opifer: configurazione, dati del Postgres incorporato, pid e log.
 * Default `~/.opifer`, sovrascrivibile con `OPIFER_HOME` o `--home`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface OpiferConfig {
  version: 1;
  server: { host: string; port: number };
  database: { port: number };
}

export const DEFAULT_CONFIG: OpiferConfig = {
  version: 1,
  server: { host: "127.0.0.1", port: 4700 },
  database: { port: 4701 },
};

export interface OpiferHome {
  dir: string;
  configFile: string;
  postgresDir: string;
  pidFile: string;
  logFile: string;
}

export function resolveHome(override?: string): OpiferHome {
  const dir = path.resolve(override ?? process.env["OPIFER_HOME"] ?? path.join(homedir(), ".opifer"));
  return {
    dir,
    configFile: path.join(dir, "config.json"),
    postgresDir: path.join(dir, "postgres"),
    pidFile: path.join(dir, "server.pid"),
    logFile: path.join(dir, "server.log"),
  };
}

export async function readConfig(home: OpiferHome): Promise<OpiferConfig | null> {
  try {
    const raw = await readFile(home.configFile, "utf8");
    return JSON.parse(raw) as OpiferConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(home: OpiferHome, config: OpiferConfig): Promise<void> {
  await mkdir(home.dir, { recursive: true });
  await writeFile(home.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function requireConfig(home: OpiferHome): Promise<OpiferConfig> {
  const config = await readConfig(home);
  if (!config) {
    throw new Error(`Opifer non è inizializzato in ${home.dir}. Esegui prima: o4r init`);
  }
  return config;
}
