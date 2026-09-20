/**
 * Postgres incorporato: l'installazione locale non richiede alcun server
 * esterno. I binari arrivano come pacchetto npm per la piattaforma corrente;
 * i dati vivono nella cartella di Opifer.
 */

import { access, mkdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { DatabaseConfig } from "./client.js";
import { waitForDatabase } from "./client.js";

export interface EmbeddedOptions {
  /** Cartella dati del cluster (es. `~/.opifer/postgres`). */
  dataDir: string;
  port: number;
  user?: string;
  password?: string;
  /** Nome del database applicativo da creare alla prima inizializzazione. */
  database?: string;
  log?: (message: string) => void;
}

export interface EmbeddedCluster {
  config: DatabaseConfig;
  /** Vero se il cluster è stato creato adesso (prima installazione). */
  freshlyInitialised: boolean;
  stop(): Promise<void>;
}

const DEFAULT_USER = "opifer";
const DEFAULT_DATABASE = "opifer";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Come root, Postgres gira con un utente di sistema dedicato: ogni cartella
 * sopra quella dei dati deve essere attraversabile da quell'utente.
 */
async function ensureTraversableByOthers(dir: string): Promise<void> {
  let current = path.resolve(dir);
  const blocked: string[] = [];
  while (true) {
    const info = await stat(current);
    if ((info.mode & 0o001) === 0) blocked.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (blocked.length > 0) {
    throw new Error(
      `Come root il database incorporato gira con l'utente di sistema "postgres", che non può attraversare: ${blocked.join(", ")}. ` +
        `Usa una cartella accessibile (es. OPIFER_HOME=/var/lib/opifer) oppure concedi il permesso di attraversamento (chmod o+x).`,
    );
  }
}

export function embeddedConfig(options: EmbeddedOptions): DatabaseConfig {
  return {
    host: "127.0.0.1",
    port: options.port,
    database: options.database ?? DEFAULT_DATABASE,
    user: options.user ?? DEFAULT_USER,
    password: options.password ?? "opifer-locale",
  };
}

/** Inizializza (se serve) e avvia il cluster incorporato; risolve quando risponde. */
export async function startEmbeddedPostgres(options: EmbeddedOptions): Promise<EmbeddedCluster> {
  const config = embeddedConfig(options);
  const log = options.log ?? (() => {});
  const clusterDir = path.resolve(options.dataDir);
  await mkdir(path.dirname(clusterDir), { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port: config.port,
    user: config.user,
    password: config.password,
    authMethod: "scram-sha-256",
    persistent: true,
    // Postgres non gira come root: in un container root si crea un utente di sistema dedicato.
    createPostgresUser: userInfo().uid === 0,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => log(message.trimEnd()),
    onError: (message) => log(`[postgres] ${String(message).trimEnd()}`),
  });

  const freshlyInitialised = !(await exists(path.join(clusterDir, "PG_VERSION")));
  if (freshlyInitialised) {
    if (userInfo().uid === 0) await ensureTraversableByOthers(path.dirname(clusterDir));
    log(`Inizializzo il database incorporato in ${clusterDir}`);
    await pg.initialise();
  }

  await pg.start();
  try {
    await waitForDatabase({ ...config, database: "postgres" });
    if (freshlyInitialised) {
      await pg.createDatabase(config.database);
    }
    await waitForDatabase(config);
  } catch (error) {
    await pg.stop().catch(() => {});
    throw error;
  }

  return {
    config,
    freshlyInitialised,
    stop: () => pg.stop(),
  };
}
