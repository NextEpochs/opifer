/**
 * Schema Drizzle: rispecchia le migrazioni SQL in `migrations/` e serve per
 * le query tipizzate. La verità sullo schema resta nelle migrazioni; il test
 * `schema.test.ts` verifica che le due descrizioni coincidano.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  mission: text("mission"),
  status: text("status", { enum: ["attiva", "sospesa", "archiviata"] }).notNull().default("attiva"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  displayName: text("display_name").notNull(),
  email: text("email").unique(),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["proprietario", "amministratore", "operatore", "osservatore"] }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.companyId, t.userId] })],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    reportsToAgentId: uuid("reports_to_agent_id"),
    reportsToUserId: uuid("reports_to_user_id").references(() => users.id, { onDelete: "set null" }),
    model: text("model"),
    status: text("status", { enum: ["attivo", "in_pausa", "fermato_per_budget", "archiviato"] })
      .notNull()
      .default("attivo"),
    currentRevision: integer("current_revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [index("agents_company_idx").on(t.companyId), unique().on(t.companyId, t.name)],
);

export const agentRevisions = pgTable(
  "agent_revisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    authorKind: text("author_kind", { enum: ["persona", "agente", "sistema"] }).notNull(),
    authorId: uuid("author_id"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("agent_revisions_company_idx").on(t.companyId), unique().on(t.agentId, t.revision)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    actorKind: text("actor_kind", { enum: ["persona", "agente", "sistema"] }).notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id"),
    taskId: uuid("task_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("audit_log_company_time_idx").on(t.companyId, t.occurredAt)],
);

/** Tabelle di dominio: tutte devono portare company_id (le aziende sono la radice, le persone sono globali). */
export const DOMAIN_TABLES_WITHOUT_COMPANY_ID: readonly string[] = ["companies", "users", "schema_migrations"];

// --- Sessioni (0002) -------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["chat", "task", "routine"] }).notNull().default("chat"),
    title: text("title"),
    systemPrompt: text("system_prompt").notNull(),
    systemPromptHash: text("system_prompt_hash").notNull(),
    model: text("model").notNull(),
    fallbackModel: text("fallback_model"),
    status: text("status", { enum: ["attiva", "sospesa", "chiusa"] }).notNull().default("attiva"),
    workdir: text("workdir"),
    lastSeq: integer("last_seq").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("sessions_company_agent_idx").on(t.companyId, t.agentId, t.createdAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["in_corso", "conclusa", "interrotta", "fallita", "in_attesa"] })
      .notNull()
      .default("in_corso"),
    stopReason: text("stop_reason"),
    iterations: integer("iterations").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("runs_session_idx").on(t.sessionId, t.startedAt), index("runs_company_status_idx").on(t.companyId, t.status)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    content: jsonb("content").$type<unknown[]>().notNull(),
    usage: jsonb("usage").$type<Record<string, number>>(),
    ...timestamps,
  },
  (t) => [index("messages_company_idx").on(t.companyId), unique().on(t.sessionId, t.seq)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("run_events_company_idx").on(t.companyId), unique().on(t.runId, t.seq)],
);
