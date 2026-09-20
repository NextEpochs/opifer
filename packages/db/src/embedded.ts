/**
 * Embedded Postgres: the local installation requires no external server.
 * The binaries come as an npm package for the current platform; the data
 * lives in the Opifer folder.
 */

import { access, mkdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { DatabaseConfig } from "./client.js";
import { waitForDatabase } from "./client.js";

export interface EmbeddedOptions {
  /** Data folder of the cluster (e.g. `~/.opifer/postgres`). */
  dataDir: string;
  port: number;
  user?: string;
  password?: string;
  /** Name of the application database to create on first initialisation. */
  database?: string;
  log?: (message: string) => void;
}

export interface EmbeddedCluster {
  config: DatabaseConfig;
  /** True if the cluster was created just now (first installation). */
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
 * As root, Postgres runs with a dedicated system user: every folder above
 * the data folder must be traversable by that user.
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
      `As root the embedded database runs with the system user "postgres", which cannot traverse: ${blocked.join(", ")}. ` +
        `Use an accessible folder (e.g. OPIFER_HOME=/var/lib/opifer) or grant traverse permission (chmod o+x).`,
    );
  }
}

export function embeddedConfig(options: EmbeddedOptions): DatabaseConfig {
  return {
    host: "127.0.0.1",
    port: options.port,
    database: options.database ?? DEFAULT_DATABASE,
    user: options.user ?? DEFAULT_USER,
    password: options.password ?? "opifer-local",
  };
}

/** Initialises (if needed) and starts the embedded cluster; resolves when it answers. */
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
    // Postgres does not run as root: in a root container a dedicated system user is created.
    createPostgresUser: userInfo().uid === 0,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => log(message.trimEnd()),
    onError: (message) => log(`[postgres] ${String(message).trimEnd()}`),
  });

  const freshlyInitialised = !(await exists(path.join(clusterDir, "PG_VERSION")));
  if (freshlyInitialised) {
    if (userInfo().uid === 0) await ensureTraversableByOthers(path.dirname(clusterDir));
    log(`Initialising the embedded database in ${clusterDir}`);
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
