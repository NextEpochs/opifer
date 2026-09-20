import { audit, migrateUp } from "@opifer/db";
import { setupProviders } from "@opifer/server";
import { isPortOpen, openDatabase } from "../database.js";
import { DEFAULT_CONFIG, readConfig, resolveHome, writeConfig, type OpiferConfig } from "../home.js";
import { c, say } from "../output.js";

export interface InitOptions {
  home?: string;
  company?: string;
  host?: string;
  port?: string;
  dbPort?: string;
  model?: string;
  localUrl?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const home = resolveHome(options.home);
  const existing = await readConfig(home);
  const config: OpiferConfig = existing ?? structuredClone(DEFAULT_CONFIG);
  if (options.host) config.server.host = options.host;
  if (options.port) config.server.port = Number(options.port);
  if (options.dbPort) config.database.port = Number(options.dbPort);
  config.models ??= { default: null, fallback: null, auxiliary: null, local: null };
  if (options.model) config.models.default = options.model;
  if (options.localUrl) config.models.local = { baseURL: options.localUrl };

  say.step(`Cartella di Opifer: ${c.bold(home.dir)}`);
  if (!existing) {
    if (await isPortOpen(config.database.port)) {
      throw new Error(`La porta ${config.database.port} è occupata: scegli un'altra porta per il database con --db-port`);
    }
  }
  await writeConfig(home, config);
  say.ok(existing ? "Configurazione esistente mantenuta" : "Configurazione scritta");

  say.step("Database incorporato");
  const db = await openDatabase(home, config);
  try {
    const applied = await migrateUp(db.handle.sql, { log: (m) => say.info(`  ${m}`) });
    say.ok(applied.length ? `${applied.length} migrazioni applicate` : "Schema già aggiornato");

    const companies = await db.handle.sql<{ id: string; name: string }[]>`SELECT id, name FROM companies ORDER BY created_at`;
    const name = options.company?.trim() || (companies.length === 0 ? "La mia azienda" : null);
    if (name && !companies.some((co) => co.name === name)) {
      const created = await db.handle.sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`INSERT INTO companies (name) VALUES (${name}) RETURNING id`;
        await audit(tx, {
          companyId: row!.id,
          actorKind: "persona",
          action: "azienda.creata",
          subjectKind: "azienda",
          subjectId: row!.id,
          after: { name, origine: "o4r init" },
        });
        return row!;
      });
      say.ok(`Azienda creata: ${c.bold(name)} ${c.dim(created.id)}`);
    } else if (name) {
      say.ok(`Azienda già presente: ${c.bold(name)}`);
    } else {
      say.ok(`${companies.length} aziende presenti`);
    }
  } finally {
    await db.close();
  }

  say.step("Provider di modelli");
  const setup = setupProviders(config.models);
  for (const r of setup.report) (r.enabled ? say.ok : say.warn)(`${r.id}: ${r.detail}`);
  if (!setup.report.some((r) => r.enabled)) {
    say.warn("Nessun provider configurato: imposta ANTHROPIC_API_KEY o OPENAI_API_KEY, oppure un endpoint locale con --local-url");
  } else {
    say.ok(`Modello di default: ${c.bold(setup.defaultModel)}`);
  }

  say.info("");
  say.info(`${c.bold("Pronto.")} Avvia con ${c.cyan("o4r up")} e apri http://${config.server.host}:${config.server.port}`);
}
