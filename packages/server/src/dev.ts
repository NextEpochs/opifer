/**
 * Development start-up: uses the Opifer folder (OPIFER_HOME or ~/.opifer)
 * already initialised with `o4r init`, starts the embedded Postgres and the
 * server with logging enabled.
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

const app = await buildApp({ db, mode: "local", logger: true });
await app.listen({ host: config.server.host, port: config.server.port });

const shutdown = async () => {
  await app.close();
  await db.close();
  await cluster.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
