import { dockerAvailable } from "@opifer/runtime";
import { existsSync } from "node:fs";
import path from "node:path";
import { migrationStatus } from "@opifer/db";
import { setupProviders } from "@opifer/server";
import { isPortOpen, openDatabase } from "../database.js";
import { readConfig, resolveHome } from "../home.js";
import { c, say } from "../output.js";
import { uiDistDir } from "./up.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A non-blocking check: reported but not counted among the failures. */
  warn?: boolean;
}

export async function runDoctor(options: { home?: string }): Promise<void> {
  const home = resolveHome(options.home);
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: (major ?? 0) >= 22, detail: `v${process.versions.node} (22 or later required)` });

  const config = await readConfig(home);
  checks.push({ name: "Opifer folder", ok: config !== null, detail: config ? home.dir : `${home.dir} not initialised (o4r init)` });

  if (config) {
    const clusterReady = existsSync(path.join(home.postgresDir, "PG_VERSION"));
    checks.push({ name: "Embedded database", ok: clusterReady, detail: clusterReady ? home.postgresDir : "cluster not initialised" });

    const serverUp = await isPortOpen(config.server.port);
    checks.push({
      name: "Server",
      ok: true,
      detail: serverUp ? `listening on http://${config.server.host}:${config.server.port}` : `stopped (port ${config.server.port} free)`,
    });

    if (clusterReady) {
      try {
        const db = await openDatabase(home, config);
        try {
          const status = await migrationStatus(db.handle.sql);
          checks.push({
            name: "Migrations",
            ok: status.pending.length === 0,
            detail: status.pending.length === 0 ? `${status.applied.length} applied, none pending` : `${status.pending.length} pending (o4r migrate up)`,
          });
          const [row] = await db.handle.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM companies`;
          checks.push({ name: "Companies", ok: (row?.n ?? 0) > 0, detail: `${row?.n ?? 0} present` });
        } finally {
          await db.close();
        }
      } catch (error) {
        checks.push({ name: "Database connection", ok: false, detail: String(error) });
      }
    }
  }

  if (config) {
    const setup = await setupProviders(config.models, process.env, { credentialsDir: home.credentialsDir });
    const enabled = setup.report.filter((r) => r.enabled).map((r) => r.id);
    checks.push({
      name: "Model providers",
      ok: enabled.length > 0,
      warn: true,
      detail: enabled.length > 0 ? `${enabled.join(", ")} (default ${setup.defaultModel})` : "none: set ANTHROPIC_API_KEY, OPENAI_API_KEY or a local endpoint",
    });
  }

  const docker = await dockerAvailable();
  checks.push({
    name: "Docker sandbox",
    ok: docker.ok,
    warn: true,
    detail: docker.ok ? `${docker.detail}: agent commands run in containers with no network` : `not available (${docker.detail.slice(0, 80)}): commands run on this machine`,
  });

  const ui = existsSync(path.join(uiDistDir(), "index.html"));
  checks.push({ name: "Compiled interface", ok: ui, detail: ui ? uiDistDir() : "missing: pnpm build" });

  for (const check of checks) {
    (check.ok ? say.ok : check.warn ? say.warn : say.fail)(`${c.bold(check.name)}: ${check.detail}`);
  }
  const failed = checks.filter((ch) => !ch.ok && !ch.warn).length;
  say.info("");
  if (failed === 0) say.ok("All good");
  else {
    say.warn(`${failed} checks to fix`);
    process.exitCode = 1;
  }
}
