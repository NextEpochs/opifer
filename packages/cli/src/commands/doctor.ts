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
  /** Un controllo che non blocca: segnalato ma non conteggiato tra i fallimenti. */
  warn?: boolean;
}

export async function runDoctor(options: { home?: string }): Promise<void> {
  const home = resolveHome(options.home);
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: (major ?? 0) >= 22, detail: `v${process.versions.node} (richiesto 22 o superiore)` });

  const config = await readConfig(home);
  checks.push({ name: "Cartella di Opifer", ok: config !== null, detail: config ? home.dir : `${home.dir} non inizializzata (o4r init)` });

  if (config) {
    const clusterReady = existsSync(path.join(home.postgresDir, "PG_VERSION"));
    checks.push({ name: "Database incorporato", ok: clusterReady, detail: clusterReady ? home.postgresDir : "cluster non inizializzato" });

    const serverUp = await isPortOpen(config.server.port);
    checks.push({
      name: "Server",
      ok: true,
      detail: serverUp ? `in ascolto su http://${config.server.host}:${config.server.port}` : `fermo (porta ${config.server.port} libera)`,
    });

    if (clusterReady) {
      try {
        const db = await openDatabase(home, config);
        try {
          const status = await migrationStatus(db.handle.sql);
          checks.push({
            name: "Migrazioni",
            ok: status.pending.length === 0,
            detail: status.pending.length === 0 ? `${status.applied.length} applicate, nessuna in attesa` : `${status.pending.length} in attesa (o4r migrate up)`,
          });
          const [row] = await db.handle.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM companies`;
          checks.push({ name: "Aziende", ok: (row?.n ?? 0) > 0, detail: `${row?.n ?? 0} presenti` });
        } finally {
          await db.close();
        }
      } catch (error) {
        checks.push({ name: "Connessione al database", ok: false, detail: String(error) });
      }
    }
  }

  if (config) {
    const setup = setupProviders(config.models);
    const enabled = setup.report.filter((r) => r.enabled).map((r) => r.id);
    checks.push({
      name: "Provider di modelli",
      ok: enabled.length > 0,
      warn: true,
      detail: enabled.length > 0 ? `${enabled.join(", ")} (default ${setup.defaultModel})` : "nessuno: imposta ANTHROPIC_API_KEY, OPENAI_API_KEY o un endpoint locale",
    });
  }

  const ui = existsSync(path.join(uiDistDir(), "index.html"));
  checks.push({ name: "Interfaccia compilata", ok: ui, detail: ui ? uiDistDir() : "assente: pnpm build" });

  for (const check of checks) {
    (check.ok ? say.ok : check.warn ? say.warn : say.fail)(`${c.bold(check.name)}: ${check.detail}`);
  }
  const failed = checks.filter((ch) => !ch.ok && !ch.warn).length;
  say.info("");
  if (failed === 0) say.ok("Tutto in ordine");
  else {
    say.warn(`${failed} controlli da sistemare`);
    process.exitCode = 1;
  }
}
