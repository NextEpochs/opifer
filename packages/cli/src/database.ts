/**
 * Accesso al Postgres incorporato dalla CLI: se il cluster è già in ascolto
 * (server avviato) ci si collega; altrimenti si avvia per la durata del
 * comando e si ferma alla fine.
 */

import { connect as netConnect } from "node:net";
import { connect, embeddedConfig, startEmbeddedPostgres, type DatabaseHandle, type EmbeddedCluster } from "@opifer/db";
import type { OpiferConfig, OpiferHome } from "./home.js";

export function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

export interface OpenDatabase {
  handle: DatabaseHandle;
  cluster: EmbeddedCluster | null;
  close(): Promise<void>;
}

export async function openDatabase(home: OpiferHome, config: OpiferConfig, log?: (m: string) => void): Promise<OpenDatabase> {
  const options = { dataDir: home.postgresDir, port: config.database.port, ...(log ? { log } : {}) };
  if (await isPortOpen(config.database.port)) {
    const handle = connect(embeddedConfig(options), { max: 4 });
    return { handle, cluster: null, close: () => handle.close() };
  }
  const cluster = await startEmbeddedPostgres(options);
  const handle = connect(cluster.config, { max: 4 });
  return {
    handle,
    cluster,
    close: async () => {
      await handle.close().catch(() => {});
      await cluster.stop();
    },
  };
}
