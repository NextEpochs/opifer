export type ActorKind = "person" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  id?: string | null;
}

export type GoalStatus = "active" | "reached" | "dropped";

export interface Goal {
  id: string;
  companyId: string;
  parentId: string | null;
  title: string;
  description: string;
  measure: string;
  status: GoalStatus;
  dueAt: Date | null;
  createdAt: Date;
}

export type ProjectStatus = "active" | "paused" | "done" | "archived";

export interface Project {
  id: string;
  companyId: string;
  goalId: string | null;
  name: string;
  description: string;
  status: ProjectStatus;
  workdir: string | null;
  /** A git repository the project works on; cloned into the working folder. */
  repoUrl: string | null;
  branch: string | null;
  repoStatus: "none" | "cloned" | "failed";
  repoDetail: string;
  createdAt: Date;
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskResult {
  summary: string;
  /** Free-form verification note: what was checked and how. */
  verification?: string;
}

export interface Task {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  title: string;
  description: string;
  acceptance: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerAgentId: string | null;
  createdByKind: ActorKind;
  createdById: string | null;
  dueAt: Date | null;
  leaseRunId: string | null;
  leaseSessionId: string | null;
  leaseExpiresAt: Date | null;
  checkedOutAt: Date | null;
  failures: number;
  blockedReason: string | null;
  result: TaskResult | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The chain a task carries: mission → goals (root first) → project → parents. */
export interface WhyChain {
  mission: string | null;
  companyName: string;
  goals: Goal[];
  project: Project | null;
  parents: Array<{ id: string; title: string }>;
}

export interface TaskComment {
  id: string;
  companyId: string;
  taskId: string;
  authorKind: ActorKind;
  authorId: string | null;
  body: string;
  mentions: string[];
  createdAt: Date;
}

export type WorkProductKind = "file" | "link" | "diff" | "document" | "decision" | "note";

export interface WorkProduct {
  id: string;
  companyId: string;
  taskId: string;
  runId: string | null;
  kind: WorkProductKind;
  title: string;
  ref: string;
  summary: string;
  createdByKind: ActorKind;
  createdById: string | null;
  createdAt: Date;
}

export type WakeupReason = "assignment" | "mention" | "heartbeat" | "routine" | "external" | "decision" | "retry";
export type WakeupStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface Wakeup {
  id: string;
  companyId: string;
  agentId: string;
  reason: WakeupReason;
  taskId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  status: WakeupStatus;
  scheduledAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  attempts: number;
  error: string | null;
}

export type CheckoutOutcome = { ok: true; task: Task } | { ok: false; reason: "taken" | "not_available" | "not_assignee" | "not_found" };
