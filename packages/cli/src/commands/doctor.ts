import { dockerAvailable } from "@opifer/runtime";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import { migrationStatus } from "@opifer/db";
import { setupProviders } from "@opifer/server";
import { isPortOpen, openDatabase } from "../database.js";
import { readConfig, resolveHome } from "../home.js";
import { c, say } from "../output.js";
import { uiDistDir } from "./up.js";
import { readCliKey } from "./auth.js";
import { cliVersion } from "./update.js";
import { compareVersions, fetchLatestVersion } from "@opifer/server";

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
  {
    const current = cliVersion();
    const latest = config?.updates?.check === false ? null : await fetchLatestVersion(fetch, 3000);
    const newer = latest !== null && compareVersions(latest, current) > 0;
    checks.push({
      name: "Version",
      ok: !newer,
      warn: true,
      detail: newer
        ? `${current}; ${latest} is on npm: o4r update`
        : latest
          ? `${current} (latest)`
          : `${current}${config?.updates?.check === false ? " (update check off)" : " (npm not reachable)"}`,
    });
  }
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
      detail:
        enabled.length > 0
          ? `${enabled.join(", ")} (default ${setup.defaultModel ?? "none"})`
          : "none connected: o4r login chatgpt (--manual on a server), or ANTHROPIC_API_KEY / OPENAI_API_KEY, then restart",
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

  // Disk and memory: the embedded database and the sandboxes need room; 4 GB and 2 GB free are comfortable.
  try {
    const stat = await statfs(home.dir);
    const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
    checks.push({ name: "Disk space", ok: freeGb >= 2, warn: freeGb >= 0.5, detail: `${freeGb.toFixed(1)} GB free in ${home.dir}` });
  } catch {
    // an unknown filesystem is not a failure
  }
  const totalGb = totalmem() / 1024 ** 3;
  checks.push({
    name: "Memory",
    ok: totalGb >= 4,
    warn: true,
    detail: `${totalGb.toFixed(1)} GB (4 GB recommended; the MVP was tested with 20 agents and 10 concurrent runs on 2 vCPU / 4 GB)`,
  });

  // The live server, when it runs: health, sandbox in use and whether a company is stopped.
  if (config && (await isPortOpen(config.server.port))) {
    try {
      const health = (await (await fetch(`http://${config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host}:${config.server.port}/v1/health`)).json()) as {
        status: string;
        database: string;
        runtime: string;
        governance: string;
        sandbox?: { kind: string };
      };
      checks.push({
        name: "Health",
        ok: health.status === "ok",
        detail: `${health.status} (database ${health.database}, runtime ${health.runtime}, governance ${health.governance}, sandbox ${health.sandbox?.kind ?? "?"})`,
      });
      // Authenticated mode: the companies list needs the CLI's own key (the health check is public).
      const key = config.auth?.enabled ? await readCliKey(home) : null;
      const answer = await fetch(`http://${config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host}:${config.server.port}/v1/companies`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      const companies = answer.ok ? ((await answer.json()) as Array<{ name: string; status: string }>) : [];
      if (!answer.ok)
        checks.push({
          name: "Companies",
          ok: false,
          warn: true,
          detail: `the server refused the companies list (${answer.status}): is this command line's key in place? o4r auth enable`,
        });
      const stopped = companies.filter((co) => co.status === "suspended");
      if (stopped.length > 0) checks.push({ name: "Emergency stop", ok: false, warn: true, detail: `${stopped.map((co) => co.name).join(", ")} stopped: o4r resume when ready` });
    } catch (error) {
      checks.push({ name: "Health", ok: false, detail: `the server does not answer: ${String(error).slice(0, 80)}` });
    }
    if (config.auth?.enabled) checks.push({ name: "Authentication", ok: true, detail: "authenticated mode: sign-in required on the API and the interface" });
    else if (config.server.host === "0.0.0.0")
      checks.push({
        name: "Exposure",
        ok: false,
        warn: true,
        detail: "the server listens on every interface with no authentication (local mode): o4r auth enable --email you@example.com, or keep it behind a firewall",
      });
  }

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
