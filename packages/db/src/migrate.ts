/**
 * Migratore a coppie di file SQL: `NNNN_nome.up.sql` e `NNNN_nome.down.sql`.
 *
 * Ogni migrazione viene applicata (o ritirata) in una singola transazione e
 * registrata nella tabella `schema_migrations`. Una migrazione senza il suo
 * `down` non è ammessa: le migrazioni sono reversibili per contratto.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Sql } from "postgres";

export interface Migration {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

/** Cartella delle migrazioni del pacchetto, valida sia da `src` che da `dist`. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const byVersion = new Map<number, { name: string; up?: string; down?: string }>();

  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2]!;
    const direction = match[3] as "up" | "down";
    const current = byVersion.get(version) ?? { name };
    if (current.name !== name) {
      throw new Error(`Migrazione ${version}: nomi diversi per up e down ("${current.name}" e "${name}")`);
    }
    current[direction] = await readFile(path.join(dir, entry), "utf8");
    byVersion.set(version, current);
  }

  const migrations: Migration[] = [];
  for (const [version, m] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
    if (!m.up) throw new Error(`Migrazione ${version}_${m.name}: manca il file .up.sql`);
    if (!m.down) throw new Error(`Migrazione ${version}_${m.name}: manca il file .down.sql`);
    migrations.push({ version, name: m.name, upSql: m.up, downSql: m.down });
  }

  for (let i = 0; i < migrations.length; i++) {
    const expected = i + 1;
    if (migrations[i]!.version !== expected) {
      throw new Error(`Le migrazioni devono essere consecutive: attesa ${expected}, trovata ${migrations[i]!.version}`);
    }
  }
  return migrations;
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function migrationStatus(sql: Sql, dir?: string): Promise<MigrationStatus> {
  await ensureLedger(sql);
  const all = await loadMigrations(dir);
  const rows = await sql<{ version: number; name: string; applied_at: Date }[]>`
    SELECT version, name, applied_at FROM schema_migrations ORDER BY version
  `;
  const applied = rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
  const appliedVersions = new Set(applied.map((a) => a.version));
  const pending = all.filter((m) => !appliedVersions.has(m.version));
  return { applied, pending };
}

export interface MigrateOptions {
  dir?: string;
  /** Applica (o ritira) fino a questa versione inclusa. */
  to?: number;
  log?: (message: string) => void;
}

/** Applica le migrazioni in attesa, in ordine, una transazione ciascuna. */
export async function migrateUp(sql: Sql, options: MigrateOptions = {}): Promise<Migration[]> {
  const { pending } = await migrationStatus(sql, options.dir);
  const toApply = options.to === undefined ? pending : pending.filter((m) => m.version <= options.to!);
  for (const m of toApply) {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.upSql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
    });
    options.log?.(`↑ ${String(m.version).padStart(4, "0")}_${m.name}`);
  }
  return toApply;
}

export interface MigrateDownOptions extends MigrateOptions {
  /** Numero di migrazioni da ritirare partendo dall'ultima (default 1). */
  steps?: number;
}

/** Ritira le ultime migrazioni applicate, dall'ultima alla prima. */
export async function migrateDown(sql: Sql, options: MigrateDownOptions = {}): Promise<Migration[]> {
  const all = await loadMigrations(options.dir);
  const { applied } = await migrationStatus(sql, options.dir);
  const byVersion = new Map(all.map((m) => [m.version, m]));

  let targets = [...applied].sort((a, b) => b.version - a.version);
  if (options.to !== undefined) {
    targets = targets.filter((a) => a.version > options.to!);
  } else {
    targets = targets.slice(0, options.steps ?? 1);
  }

  const reverted: Migration[] = [];
  for (const a of targets) {
    const m = byVersion.get(a.version);
    if (!m) throw new Error(`Migrazione ${a.version} applicata ma file mancante: impossibile ritirarla`);
    await sql.begin(async (tx) => {
      await tx.unsafe(m.downSql);
      await tx`DELETE FROM schema_migrations WHERE version = ${m.version}`;
    });
    options.log?.(`↓ ${String(m.version).padStart(4, "0")}_${m.name}`);
    reverted.push(m);
  }
  return reverted;
}
