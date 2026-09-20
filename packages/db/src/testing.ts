/**
 * Supporto ai test: un Postgres incorporato temporaneo, su una porta libera,
 * con le migrazioni applicate. Viene distrutto alla fine.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type DatabaseHandle } from "./client.js";
import { startEmbeddedPostgres, type EmbeddedCluster } from "./embedded.js";
import { migrateUp } from "./migrate.js";

export interface TestDatabase extends DatabaseHandle {
  cluster: EmbeddedCluster;
  dataDir: string;
  destroy(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "opifer-test-"));
  // Come root il cluster gira con l'utente "postgres": la cartella deve essere attraversabile.
  await chmod(dataDir, 0o755);
  const port = await freePort();
  const cluster = await startEmbeddedPostgres({ dataDir: path.join(dataDir, "postgres"), port });
  const handle = connect(cluster.config, { max: 4 });
  if (options.migrate !== false) {
    await migrateUp(handle.sql);
  }
  return {
    ...handle,
    cluster,
    dataDir,
    destroy: async () => {
      await handle.close().catch(() => {});
      await cluster.stop().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
