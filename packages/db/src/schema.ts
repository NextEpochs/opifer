/**
 * Drizzle schema: mirrors the SQL migrations in `migrations/` and serves the
 * typed queries. The source of truth for the schema stays in the migrations;
 * the `schema.test.ts` test checks that the two descriptions match.
 */

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  mission: text("mission"),
  status: text("status", { enum: ["active", "suspended", "archived"] }).notNull().default("active"),
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
    role: text("role", { enum: ["owner", "admin", "operator", "observer"] }).notNull(),
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
    status: text("status", { enum: ["active", "paused", "budget_stopped", "archived"] })
      .notNull()
      .default("active"),
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
    authorKind: text("author_kind", { enum: ["person", "agent", "system"] }).notNull(),
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
    actorKind: text("actor_kind", { enum: ["person", "agent", "system"] }).notNull(),
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

/** Domain tables: all of them must carry company_id (companies are the root, people are global). */
export const DOMAIN_TABLES_WITHOUT_COMPANY_ID: readonly string[] = ["companies", "users", "schema_migrations"];

// --- Sessions (0002) --------------------------------------------------------

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
    status: text("status", { enum: ["active", "suspended", "closed"] }).notNull().default("active"),
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
    status: text("status", { enum: ["running", "completed", "interrupted", "failed", "waiting"] })
      .notNull()
      .default("running"),
    stopReason: text("stop_reason"),
    iterations: integer("iterations").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    eventSeq: integer("event_seq").notNull().default(0),
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

// --- Governance (0003) -----------------------------------------------------

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind", { enum: ["company", "project", "agent", "task", "turn"] }).notNull(),
    scopeId: uuid("scope_id"),
    window: text("window", { enum: ["monthly", "daily", "lifetime"] }).notNull().default("monthly"),
    cap: numeric("cap", { precision: 14, scale: 6 }).notNull(),
    currency: text("currency", { enum: ["EUR", "USD"] }).notNull().default("EUR"),
    warnRatio: numeric("warn_ratio", { precision: 4, scale: 3 }).notNull().default("0.8"),
    ...timestamps,
  },
  (t) => [index("budget_policies_company_idx").on(t.companyId), unique().on(t.companyId, t.scopeKind, t.scopeId, t.window)],
);

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),
    taskId: uuid("task_id"),
    kind: text("kind", { enum: ["model", "auxiliary_model", "tool", "sandbox"] }).notNull(),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull().default("0"),
    amountEur: numeric("amount_eur", { precision: 14, scale: 6 }).notNull().default("0"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index("cost_events_company_time_idx").on(t.companyId, t.occurredAt),
    index("cost_events_agent_time_idx").on(t.agentId, t.occurredAt),
    index("cost_events_run_idx").on(t.runId),
  ],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),
    taskId: uuid("task_id"),
    estimatedUsd: numeric("estimated_usd", { precision: 14, scale: 6 }).notNull().default("0"),
    estimatedEur: numeric("estimated_eur", { precision: 14, scale: 6 }).notNull().default("0"),
    status: text("status", { enum: ["open", "settled", "released"] }).notNull().default("open"),
    costEventId: uuid("cost_event_id").references(() => costEvents.id, { onDelete: "set null" }),
    ...timestamps,
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [index("budget_reservations_open_idx").on(t.companyId, t.status)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["tool_use", "dangerous_command", "budget_increase", "agent_hire", "plan", "skill_promotion", "config_change", "secret_access"] }).notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: uuid("task_id"),
    subject: jsonb("subject").$type<Record<string, unknown>>().notNull().default({}),
    reason: text("reason"),
    estimatedCost: numeric("estimated_cost", { precision: 14, scale: 6 }),
    risk: text("risk", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
    status: text("status", { enum: ["pending", "approved", "denied", "expired"] }).notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("approvals_company_status_idx").on(t.companyId, t.status, t.createdAt), index("approvals_session_idx").on(t.sessionId)],
);

export const toolPolicies = pgTable(
  "tool_policies",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: ["company", "role", "agent"] }).notNull(),
    targetId: text("target_id"),
    toolName: text("tool_name").notNull(),
    permission: text("permission", { enum: ["automatic", "approval", "blocked"] }).notNull(),
    ...timestamps,
  },
  (t) => [index("tool_policies_company_idx").on(t.companyId), unique().on(t.companyId, t.targetKind, t.targetId, t.toolName)],
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("secrets_company_name_idx").on(t.companyId, t.name), unique().on(t.companyId, t.name, t.version)],
);

export const secretBindings = pgTable(
  "secret_bindings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    ...timestamps,
  },
  (t) => [index("secret_bindings_company_idx").on(t.companyId), unique().on(t.companyId, t.secretName, t.agentId, t.toolName)],
);

export const secretAccessEvents = pgTable(
  "secret_access_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    toolName: text("tool_name"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("secret_access_events_company_idx").on(t.companyId, t.occurredAt)],
);
