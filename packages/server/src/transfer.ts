/**
 * Company export and import (spec 10.3, M7): one JSON document with the
 * company, its agents and their permissions and budgets, goals, projects,
 * tasks, routines, connections, channels, memories, skills, learning rules,
 * webhooks and subscriptions. Secret values never leave: only their names,
 * so whoever imports re-enters them. Sessions, runs, costs and the audit
 * stay where they were made: they are history, not configuration.
 *
 * On import every row gets a new id (a copy, never a collision), references
 * are remapped, leases are cleared, webhook tokens and subscription secrets
 * are minted afresh and returned once.
 */

import { randomUUID } from "node:crypto";
import { audit } from "@opifer/db";
import type { Sql, TransactionSql } from "postgres";
import type { EventService, WebhookService } from "@opifer/connections";

export const EXPORT_FORMAT = "opifer-company";
export const EXPORT_VERSION = 1;

type Row = Record<string, unknown>;

export interface CompanyExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  opiferVersion: string;
  company: Row;
  tables: Record<string, Row[]>;
  /** Names of the company secrets: values are never exported. */
  secretNames: string[];
  webhooks: Array<{ name: string; action: string; defaults: unknown; enabled: boolean }>;
  subscriptions: Array<{ name: string; url: string; events: unknown; enabled: boolean }>;
}

/** Tables copied as they are (minus history and secrets), in an order that respects foreign keys. */
const TABLES = [
  "agents",
  "agent_revisions",
  "tool_policies",
  "budget_policies",
  "learning_settings",
  "goals",
  "projects",
  "tasks",
  "task_relations",
  "routines",
  "tool_connections",
  "channels",
  "memories",
  "skills",
  "skill_versions",
] as const;

/** Columns that point at history (sessions, runs, people) or are generated: cleared on import. */
const CLEARED = new Set([
  "lease_run_id",
  "lease_session_id",
  "lease_expires_at",
  "checked_out_at",
  "source_session_id",
  "source_run_id",
  "session_id",
  "run_id",
  "assignee_user_id",
  "reports_to_user_id",
  "user_id",
  "search",
  "last_checked_at",
  "last_seen_at",
  "last_run_at",
  "next_due_at",
]);

/** Columns that carry an id of another exported row. */
const REFERENCES = [
  "id",
  "company_id",
  "agent_id",
  "scope_agent_id",
  "reports_to_agent_id",
  "assignee_agent_id",
  "reviewer_agent_id",
  "default_agent_id",
  "parent_id",
  "goal_id",
  "project_id",
  "skill_id",
  "supersedes_id",
  "promoted_from_id",
  "task_id",
  "from_task_id",
  "to_task_id",
  "target_id",
  "scope_id",
  "source_task_id",
];

export async function exportCompany(sql: Sql, companyId: string, opiferVersion: string): Promise<CompanyExport | null> {
  const [company] = await sql<Row[]>`SELECT id, name, mission, status, settings FROM companies WHERE id = ${companyId}`;
  if (!company) return null;
  const tables: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const rows = await sql<Row[]>`SELECT * FROM ${sql(table)} WHERE company_id = ${companyId} ORDER BY created_at`;
    tables[table] = rows.map((row) => {
      const copy: Row = {};
      for (const [key, value] of Object.entries(row)) {
        if (CLEARED.has(key)) continue;
        copy[key] = value instanceof Date ? value.toISOString() : value;
      }
      return copy;
    });
  }
  const secrets = await sql<{ name: string }[]>`SELECT DISTINCT name FROM secrets WHERE company_id = ${companyId} ORDER BY name`;
  const webhooks = await sql<
    { name: string; action: string; defaults: unknown; enabled: boolean }[]
  >`SELECT name, action, defaults, enabled FROM webhooks WHERE company_id = ${companyId} ORDER BY created_at`;
  const subscriptions = await sql<
    { name: string; url: string; events: unknown; enabled: boolean }[]
  >`SELECT name, url, events, enabled FROM event_subscriptions WHERE company_id = ${companyId} ORDER BY created_at`;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    opiferVersion,
    company: { name: company["name"], mission: company["mission"], settings: company["settings"] },
    tables,
    secretNames: secrets.map((s) => s.name),
    webhooks,
    subscriptions,
  };
}

export interface ImportResult {
  companyId: string;
  name: string;
  counts: Record<string, number>;
  /** Fresh credentials, shown once. */
  webhooks: Array<{ name: string; id: string; token: string }>;
  subscriptions: Array<{ name: string; id: string; secret: string }>;
  secretsToEnter: string[];
}

/** Rows with a self reference are inserted parents first. */
function parentsFirst(rows: Row[], key: string): Row[] {
  const byId = new Map(rows.map((r) => [r["id"] as string, r]));
  const done = new Set<string>();
  const ordered: Row[] = [];
  const visit = (row: Row, depth = 0) => {
    const id = row["id"] as string;
    if (done.has(id) || depth > 100) return;
    const parent = row[key] as string | null | undefined;
    if (parent && byId.has(parent) && !done.has(parent)) visit(byId.get(parent)!, depth + 1);
    done.add(id);
    ordered.push(row);
  };
  for (const row of rows) visit(row);
  return ordered;
}

const SELF_REFERENCE: Record<string, string> = { agents: "reports_to_agent_id", goals: "parent_id", tasks: "parent_id", memories: "supersedes_id", skills: "promoted_from_id" };

export async function importCompany(
  sql: Sql,
  doc: CompanyExport,
  services: { webhooks: WebhookService; events: EventService },
  options: { name?: string } = {},
): Promise<ImportResult> {
  if (doc.format !== EXPORT_FORMAT) throw new Error(`not an Opifer company export (format ${String(doc.format)})`);
  if (doc.version !== EXPORT_VERSION) throw new Error(`unsupported export version ${String(doc.version)}`);
  const ids = new Map<string, string>();
  const remap = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    if (!ids.has(value)) ids.set(value, randomUUID());
    return ids.get(value)!;
  };
  const counts: Record<string, number> = {};
  const companyId = await sql.begin(async (tx) => {
    const [company] = await tx<
      { id: string }[]
    >`INSERT INTO companies (name, mission, settings) VALUES (${options.name ?? String(doc.company["name"])}, ${(doc.company["mission"] as string | null) ?? null}, ${(doc.company["settings"] ?? {}) as never}::jsonb) RETURNING id`;
    const newCompanyId = company!.id;
    for (const table of TABLES) {
      let rows = doc.tables[table] ?? [];
      if (SELF_REFERENCE[table]) rows = parentsFirst(rows, SELF_REFERENCE[table]!);
      for (const source of rows) {
        const row: Row = {};
        for (const [key, value] of Object.entries(source)) {
          if (CLEARED.has(key)) continue;
          if (key === "company_id") row[key] = newCompanyId;
          else if (key === "created_by_id" || key === "author_id" || key === "author")
            row[key] = source["created_by_kind"] === "agent" || source["author_kind"] === "agent" ? remap(value) : null;
          else if (REFERENCES.includes(key) && value !== null && value !== undefined)
            row[key] = key === "target_id" ? (source["target_kind"] === "agent" ? remap(value) : source["target_kind"] === "role" ? value : null) : remap(value);
          else if (key === "embedding") row[key] = null;
          else row[key] = value;
        }
        const columns = Object.keys(row);
        await tx`INSERT INTO ${tx(table)} ${tx(row, ...columns)}`;
        counts[table] = (counts[table] ?? 0) + 1;
      }
    }
    await audit(tx as unknown as TransactionSql, {
      companyId: newCompanyId,
      actorKind: "person",
      action: "company.imported",
      subjectKind: "company",
      subjectId: newCompanyId,
      after: { from: doc.exportedAt, opiferVersion: doc.opiferVersion, counts },
    });
    return newCompanyId;
  });
  const webhooks: ImportResult["webhooks"] = [];
  for (const w of doc.webhooks ?? []) {
    const created = await services.webhooks.create(
      { companyId, name: w.name, action: w.action as never, defaults: (w.defaults as Record<string, unknown>) ?? {} },
      { kind: "person" },
    );
    webhooks.push({ name: w.name, id: created.webhook.id, token: created.token });
  }
  const subscriptions: ImportResult["subscriptions"] = [];
  for (const s of doc.subscriptions ?? []) {
    const created = await services.events.create({ companyId, name: s.name, url: s.url, events: (s.events as string[]) ?? ["*"] }, { kind: "person" });
    subscriptions.push({ name: s.name, id: created.id, secret: created.secret });
  }
  return { companyId, name: options.name ?? String(doc.company["name"]), counts, webhooks, subscriptions, secretsToEnter: doc.secretNames ?? [] };
}
