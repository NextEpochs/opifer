/**
 * Avvio in sviluppo: usa la cartella di Opifer (OPIFER_HOME o ~/.opifer)
 * già inizializzata con `o4r init`, avvia il Postgres incorporato e il server
 * con log attivi.
 */

import { startEmbeddedPostgres, connect, migrateUp } from "@opifer/db";
import { buildApp } from "./app.js";
import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const home = process.env["OPIFER_HOME"] ?? path.join(homedir(), ".opifer");
const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")) as {
  server: { host: string; port: number };
  database: { port: number };
};

const cluster = await startEmbeddedPostgres({ dataDir: path.join(home, "postgres"), port: config.database.port });
const db = connect(cluster.config);
await migrateUp(db.sql, { log: console.log });

const app = await buildApp({ db, mode: "locale", logger: true });
await app.listen({ host: config.server.host, port: config.server.port });

const shutdown = async () => {
  await app.close();
  await db.close();
  await cluster.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
