/**
 * Drizzle schema: mirrors the SQL migrations in `migrations/` and serves the
 * typed queries. The source of truth for the schema stays in the migrations;
 * the `schema.test.ts` test checks that the two descriptions match.
 */

import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, numeric, pgTable, primaryKey, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  mission: text("mission"),
  status: text("status", { enum: ["active", "suspended", "archived"] })
    .notNull()
    .default("active"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["chat", "task", "routine"] })
      .notNull()
      .default("chat"),
    title: text("title"),
    systemPrompt: text("system_prompt").notNull(),
    systemPromptHash: text("system_prompt_hash").notNull(),
    model: text("model").notNull(),
    fallbackModel: text("fallback_model"),
    status: text("status", { enum: ["active", "suspended", "closed"] })
      .notNull()
      .default("active"),
    workdir: text("workdir"),
    lastSeq: integer("last_seq").notNull().default(0),
    // 0004: a session can belong to a task
    taskId: uuid("task_id"),
    ...timestamps,
  },
  (t) => [index("sessions_company_agent_idx").on(t.companyId, t.agentId, t.createdAt), index("sessions_task_idx").on(t.taskId)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind", { enum: ["company", "project", "agent", "task", "turn"] }).notNull(),
    scopeId: uuid("scope_id"),
    window: text("window", { enum: ["monthly", "daily", "lifetime"] })
      .notNull()
      .default("monthly"),
    cap: numeric("cap", { precision: 14, scale: 6 }).notNull(),
    currency: text("currency", { enum: ["EUR", "USD"] })
      .notNull()
      .default("EUR"),
    warnRatio: numeric("warn_ratio", { precision: 4, scale: 3 }).notNull().default("0.8"),
    ...timestamps,
  },
  (t) => [index("budget_policies_company_idx").on(t.companyId), unique().on(t.companyId, t.scopeKind, t.scopeId, t.window)],
);

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    status: text("status", { enum: ["open", "settled", "released"] })
      .notNull()
      .default("open"),
    costEventId: uuid("cost_event_id").references(() => costEvents.id, { onDelete: "set null" }),
    ...timestamps,
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [index("budget_reservations_open_idx").on(t.companyId, t.status)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    risk: text("risk", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    status: text("status", { enum: ["pending", "approved", "denied", "expired"] })
      .notNull()
      .default("pending"),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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

// --- Work (0004) ----------------------------------------------------------

export const goals = pgTable(
  "goals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    measure: text("measure").notNull().default(""),
    status: text("status", { enum: ["active", "reached", "dropped"] })
      .notNull()
      .default("active"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("goals_company_idx").on(t.companyId, t.parentId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["active", "paused", "done", "archived"] })
      .notNull()
      .default("active"),
    workdir: text("workdir"),
    ...timestamps,
  },
  (t) => [index("projects_company_idx").on(t.companyId), unique().on(t.companyId, t.name)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptance: text("acceptance").notNull().default(""),
    status: text("status", { enum: ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"] })
      .notNull()
      .default("todo"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] })
      .notNull()
      .default("normal"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByKind: text("created_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("person"),
    createdById: uuid("created_by_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    leaseRunId: uuid("lease_run_id").references(() => runs.id, { onDelete: "set null" }),
    leaseSessionId: uuid("lease_session_id").references(() => sessions.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    failures: integer("failures").notNull().default(0),
    blockedReason: text("blocked_reason"),
    result: jsonb("result"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("tasks_company_status_idx").on(t.companyId, t.status, t.priority),
    index("tasks_assignee_idx").on(t.assigneeAgentId, t.status),
    index("tasks_parent_idx").on(t.parentId),
    index("tasks_project_idx").on(t.projectId),
  ],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ["person", "agent", "system"] }).notNull(),
    authorId: uuid("author_id"),
    body: text("body").notNull(),
    mentions: jsonb("mentions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (t) => [index("task_comments_task_idx").on(t.taskId, t.createdAt)],
);

export const taskRelations = pgTable(
  "task_relations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    relatedId: uuid("related_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["depends_on", "blocks", "relates_to"] }).notNull(),
    ...timestamps,
  },
  (t) => [index("task_relations_company_idx").on(t.companyId), unique().on(t.taskId, t.relatedId, t.kind)],
);

export const workProducts = pgTable(
  "work_products",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["file", "link", "diff", "document", "decision", "note"] }).notNull(),
    title: text("title").notNull(),
    ref: text("ref").notNull().default(""),
    summary: text("summary").notNull().default(""),
    createdByKind: text("created_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("agent"),
    createdById: uuid("created_by_id"),
    ...timestamps,
  },
  (t) => [index("work_products_task_idx").on(t.taskId, t.createdAt)],
);

export const wakeups = pgTable(
  "wakeups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: ["assignment", "mention", "heartbeat", "routine", "external", "decision", "retry"] }).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    dedupeKey: text("dedupe_key"),
    status: text("status", { enum: ["pending", "running", "done", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("wakeups_pending_idx").on(t.scheduledAt)],
);

// ---------------------------------------------------------------------------
// Learning (M4): memories, skills, reviews, promotions.
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const learningSettings = pgTable("learning_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  reviewEnabled: boolean("review_enabled").notNull().default(true),
  promotion: text("promotion", { enum: ["automatic", "review", "forbidden"] })
    .notNull()
    .default("review"),
  promotionThreshold: integer("promotion_threshold").notNull().default(3),
  snapshotMaxChars: integer("snapshot_max_chars").notNull().default(6000),
  inactiveAfterDays: integer("inactive_after_days").notNull().default(30),
  archiveAfterDays: integer("archive_after_days").notNull().default(90),
  ...timestamps,
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["agent", "team", "company"] }).notNull(),
    scopeAgentId: uuid("scope_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["note", "profile"] })
      .notNull()
      .default("note"),
    subject: text("subject").notNull().default(""),
    content: text("content").notNull(),
    status: text("status", { enum: ["active", "retired", "superseded"] })
      .notNull()
      .default("active"),
    supersedesId: uuid("supersedes_id"),
    pinned: boolean("pinned").notNull().default(false),
    sourceSessionId: uuid("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => runs.id, { onDelete: "set null" }),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    authorKind: text("author_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("agent"),
    authorId: uuid("author_id"),
    embedding: real("embedding").array(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(subject, '') || ' ' || content)`),
    retiredReason: text("retired_reason"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("memories_scope_idx").on(t.companyId, t.scope, t.scopeAgentId, t.status)],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["agent", "team", "company"] }).notNull(),
    scopeAgentId: uuid("scope_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    origin: text("origin", { enum: ["agent", "person", "imported"] }).notNull(),
    status: text("status", { enum: ["active", "inactive", "archived"] })
      .notNull()
      .default("active"),
    pinned: boolean("pinned").notNull().default(false),
    currentVersion: integer("current_version").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    promotedFromId: uuid("promoted_from_id"),
    createdByKind: text("created_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("agent"),
    createdById: uuid("created_by_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("skills_scope_idx").on(t.companyId, t.scope, t.scopeAgentId, t.status)],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull(),
    files: jsonb("files").$type<Record<string, string>>().notNull().default({}),
    note: text("note").notNull().default(""),
    createdByKind: text("created_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("agent"),
    createdById: uuid("created_by_id"),
    ...timestamps,
  },
  (t) => [unique("skill_versions_skill_id_version_key").on(t.skillId, t.version)],
);

export const skillUsage = pgTable(
  "skill_usage",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    outcome: text("outcome", { enum: ["unknown", "success", "failure"] })
      .notNull()
      .default("unknown"),
    ...timestamps,
  },
  (t) => [index("skill_usage_skill_idx").on(t.skillId, t.outcome)],
);

export const learningReviews = pgTable(
  "learning_reviews",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "running", "done", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    proposals: jsonb("proposals").$type<Record<string, unknown>>().notNull().default({}),
    applied: jsonb("applied").$type<Record<string, unknown>>().notNull().default({}),
    costEur: numeric("cost_eur", { precision: 12, scale: 6 }).notNull().default("0"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("learning_reviews_company_idx").on(t.companyId, t.status, t.createdAt)],
);

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["skill", "memory"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    fromScope: text("from_scope", { enum: ["agent", "team"] }).notNull(),
    toScope: text("to_scope", { enum: ["team", "company"] }).notNull(),
    status: text("status", { enum: ["proposed", "approved", "denied", "applied", "forbidden"] })
      .notNull()
      .default("proposed"),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    resultId: uuid("result_id"),
    proposedByKind: text("proposed_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("system"),
    proposedById: uuid("proposed_by_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("promotions_company_idx").on(t.companyId, t.status)],
);

export const learningBackups = pgTable(
  "learning_backups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["curator"] }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (t) => [index("learning_backups_company_idx").on(t.companyId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Connections (M5): routines, tool connections, webhooks, events, channels.
// ---------------------------------------------------------------------------

export const routines = pgTable(
  "routines",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    scheduleKind: text("schedule_kind", { enum: ["interval", "cron", "once"] }).notNull(),
    schedule: text("schedule").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    skills: text("skills")
      .array()
      .notNull()
      .default(sql`'{}'`),
    model: text("model"),
    deliverTo: jsonb("deliver_to").$type<string[]>().notNull().default([]),
    catchUpSeconds: integer("catch_up_seconds").notNull().default(3600),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull().default(600),
    learn: boolean("learn").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdByKind: text("created_by_kind", { enum: ["person", "agent", "system"] })
      .notNull()
      .default("person"),
    createdById: uuid("created_by_id"),
    ...timestamps,
  },
  (t) => [unique("routines_company_id_name_key").on(t.companyId, t.name), index("routines_due_idx").on(t.enabled, t.nextDueAt)],
);

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    status: text("status", { enum: ["claimed", "running", "done", "failed", "skipped", "interrupted"] })
      .notNull()
      .default("claimed"),
    result: text("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("routine_runs_routine_id_due_at_key").on(t.routineId, t.dueAt)],
);

export const toolConnections = pgTable(
  "tool_connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["mcp_stdio", "mcp_http", "workflow"] }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    risk: text("risk", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    secretNames: text("secret_names")
      .array()
      .notNull()
      .default(sql`'{}'`),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status", { enum: ["unknown", "healthy", "degraded", "failed", "missing_secret"] })
      .notNull()
      .default("unknown"),
    statusDetail: text("status_detail"),
    tools: jsonb("tools").$type<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>().notNull().default([]),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("tool_connections_company_id_name_key").on(t.companyId, t.name)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    action: text("action", { enum: ["create_task", "wake_agent", "comment", "decide_approval"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    defaults: jsonb("defaults").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    calls: integer("calls").notNull().default(0),
    lastCalledAt: timestamp("last_called_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("webhooks_company_id_name_key").on(t.companyId, t.name)],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: text("events")
      .array()
      .notNull()
      .default(sql`'{*}'`),
    secret: text("secret").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    failures: integer("failures").notNull().default(0),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("event_subscriptions_company_id_name_key").on(t.companyId, t.name)],
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => eventSubscriptions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    responseStatus: integer("response_status"),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("event_deliveries_pending_idx").on(t.status, t.nextAttemptAt)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["telegram"] }).notNull(),
    name: text("name").notNull(),
    secretName: text("secret_name").notNull(),
    defaultAgentId: uuid("default_agent_id").references(() => agents.id, { onDelete: "set null" }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status", { enum: ["unknown", "healthy", "failed", "missing_secret"] })
      .notNull()
      .default("unknown"),
    statusDetail: text("status_detail"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("channels_company_id_name_key").on(t.companyId, t.name)],
);

export const channelBindings = pgTable(
  "channel_bindings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    externalSenderId: text("external_sender_id").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull().default(""),
    pairingCode: text("pairing_code"),
    pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    notify: boolean("notify").notNull().default(true),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("channel_bindings_channel_id_external_chat_id_external_sender_id_key").on(t.channelId, t.externalChatId, t.externalSenderId)],
);
