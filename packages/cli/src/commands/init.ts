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

  say.step(`Opifer folder: ${c.bold(home.dir)}`);
  if (!existing) {
    if (await isPortOpen(config.database.port)) {
      throw new Error(`Port ${config.database.port} is in use: choose another port for the database with --db-port`);
    }
  }
  await writeConfig(home, config);
  say.ok(existing ? "Existing configuration kept" : "Configuration written");

  say.step("Embedded database");
  const db = await openDatabase(home, config);
  try {
    const applied = await migrateUp(db.handle.sql, { log: (m) => say.info(`  ${m}`) });
    say.ok(applied.length ? `${applied.length} migrations applied` : "Schema already up to date");

    const companies = await db.handle.sql<{ id: string; name: string }[]>`SELECT id, name FROM companies ORDER BY created_at`;
    const name = options.company?.trim() || (companies.length === 0 ? "My company" : null);
    if (name && !companies.some((co) => co.name === name)) {
      const created = await db.handle.sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`INSERT INTO companies (name) VALUES (${name}) RETURNING id`;
        await audit(tx, {
          companyId: row!.id,
          actorKind: "person",
          action: "company.created",
          subjectKind: "company",
          subjectId: row!.id,
          after: { name, origin: "o4r init" },
        });
        return row!;
      });
      say.ok(`Company created: ${c.bold(name)} ${c.dim(created.id)}`);
    } else if (name) {
      say.ok(`Company already present: ${c.bold(name)}`);
    } else {
      say.ok(`${companies.length} companies present`);
    }
  } finally {
    await db.close();
  }

  say.step("Model providers");
  const setup = setupProviders(config.models);
  for (const r of setup.report) (r.enabled ? say.ok : say.warn)(`${r.id}: ${r.detail}`);
  if (!setup.report.some((r) => r.enabled)) {
    say.warn("No provider configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or a local endpoint with --local-url");
  } else {
    say.ok(`Default model: ${c.bold(setup.defaultModel)}`);
  }

  say.info("");
  say.info(`${c.bold("Ready.")} Start with ${c.cyan("o4r up")} and open http://${config.server.host}:${config.server.port}`);
}
