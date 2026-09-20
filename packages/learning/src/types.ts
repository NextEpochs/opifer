export type ActorKind = "person" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  id?: string | null;
}

/** Where an entry applies: one agent, the sub-tree under an agent, or the whole company. */
export type Scope = "agent" | "team" | "company";

export type MemoryKind = "note" | "profile";
export type MemoryStatus = "active" | "retired" | "superseded";

export interface Memory {
  id: string;
  companyId: string;
  scope: Scope;
  scopeAgentId: string | null;
  kind: MemoryKind;
  subject: string;
  content: string;
  status: MemoryStatus;
  supersedesId: string | null;
  pinned: boolean;
  sourceSessionId: string | null;
  sourceRunId: string | null;
  sourceTaskId: string | null;
  authorKind: ActorKind;
  authorId: string | null;
  hasEmbedding: boolean;
  retiredReason: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SkillOrigin = "agent" | "person" | "imported";
export type SkillStatus = "active" | "inactive" | "archived";

export interface Skill {
  id: string;
  companyId: string;
  scope: Scope;
  scopeAgentId: string | null;
  name: string;
  description: string;
  tags: string[];
  origin: SkillOrigin;
  status: SkillStatus;
  pinned: boolean;
  currentVersion: number;
  uses: number;
  lastUsedAt: Date | null;
  promotedFromId: string | null;
  createdByKind: ActorKind;
  createdById: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  description: string;
  content: string;
  files: Record<string, string>;
  note: string;
  createdByKind: ActorKind;
  createdById: string | null;
  createdAt: Date;
}

export type UsageOutcome = "unknown" | "success" | "failure";

export interface SkillUse {
  id: string;
  skillId: string;
  version: number;
  agentId: string;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  outcome: UsageOutcome;
  createdAt: Date;
}

export type PromotionPolicy = "automatic" | "review" | "forbidden";

export interface LearningSettings {
  companyId: string;
  reviewEnabled: boolean;
  promotion: PromotionPolicy;
  promotionThreshold: number;
  snapshotMaxChars: number;
  inactiveAfterDays: number;
  archiveAfterDays: number;
}

export type PromotionStatus =
  "proposed" | "approved" | "denied" | "applied" | "forbidden";

export interface Promotion {
  id: string;
  companyId: string;
  kind: "skill" | "memory";
  subjectId: string;
  fromScope: "agent" | "team";
  toScope: "team" | "company";
  status: PromotionStatus;
  approvalId: string | null;
  evidence: Record<string, unknown>;
  resultId: string | null;
  proposedByKind: ActorKind;
  proposedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export type ReviewStatus =
  "pending" | "running" | "done" | "failed" | "skipped";

export interface LearningReview {
  id: string;
  companyId: string;
  agentId: string;
  sessionId: string;
  runId: string | null;
  taskId: string | null;
  status: ReviewStatus;
  proposals: ReviewProposals;
  applied: ReviewApplied;
  costEur: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** What the reviewing model proposes, after a turn. */
export interface ReviewProposals {
  memories?: Array<{ kind: MemoryKind; subject?: string; content: string }>;
  skill?: {
    name: string;
    description: string;
    content: string;
    improves?: string | null;
  } | null;
  /** Memories the review found wrong, by id, with the reason. */
  retire?: Array<{ id: string; reason: string }>;
  reason?: string;
}

export interface ReviewApplied {
  memoryIds?: string[];
  retiredIds?: string[];
  skill?: { id: string; name: string; version: number } | null;
}

/** The snapshot that enters the prompt at the start of a session. */
export interface LearningSnapshot {
  memory: string;
  skills: Array<{ name: string; description: string }>;
  memoryCount: number;
  truncated: boolean;
}

export class LearningError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "LearningError";
  }
}
