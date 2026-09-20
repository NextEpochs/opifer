/**
 * Learning (M4): memory and skills at three scopes, a snapshot for the
 * prompt, search, versions, the curator, promotions under governance and
 * the background review that proposes what to keep.
 */

import type { Sql } from "postgres";
import type { Embedder } from "@opifer/sdk";
import type { ApprovalService } from "@opifer/gateway";
import type { BudgetGate, ProviderRegistry, SessionStore } from "@opifer/runtime";
import { MemoryService } from "./memory.js";
import { SkillService } from "./skills.js";
import { LearningSettingsService, PromotionService } from "./promotion.js";
import { Reviewer, type ReviewerOptions } from "./review.js";
import type { LearningSnapshot } from "./types.js";

export { MemoryService, visibleScopes, cosine } from "./memory.js";
export type { RememberInput, MemorySearchHit } from "./memory.js";
export { SkillService, renderSkillMarkdown, parseSkillMarkdown, SKILL_NAME } from "./skills.js";
export type { CreateSkillInput } from "./skills.js";
export { LearningSettingsService, PromotionService } from "./promotion.js";
export { Reviewer, REVIEW_PROMPT, transcriptOf, parseProposals } from "./review.js";
export type { ReviewerOptions } from "./review.js";
export { learningTools, LEARNING_GUIDE } from "./tools.js";
export { LearningError } from "./types.js";
export type * from "./types.js";

export interface LearningOptions {
  embedder?: Embedder | null;
  approvals?: ApprovalService | null;
  budget?: BudgetGate | null;
  /** Model for the background review; the session's model when absent. */
  reviewModel?: string | null;
  reviewMaxChars?: number;
}

/** Everything learning in one place, built on one connection. */
export class LearningService {
  readonly memories: MemoryService;
  readonly skills: SkillService;
  readonly settings: LearningSettingsService;
  promotions: PromotionService;
  reviewer: Reviewer;

  constructor(
    private readonly sql: Sql,
    private readonly store: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly options: LearningOptions = {},
  ) {
    this.memories = new MemoryService(sql, options.embedder ?? null);
    this.skills = new SkillService(sql);
    this.settings = new LearningSettingsService(sql);
    this.promotions = new PromotionService(sql, this.settings, this.skills, this.memories, options.approvals ?? null);
    this.reviewer = new Reviewer(sql, store, providers, this.memories, this.skills, this.settings, this.reviewerOptions(options));
  }

  private reviewerOptions(options: LearningOptions): ReviewerOptions {
    return {
      model: options.reviewModel ?? null,
      budget: options.budget ?? null,
      ...(options.reviewMaxChars ? { maxChars: options.reviewMaxChars } : {}),
    };
  }

  /** Governance is built after the tools that need learning: attach it once it exists. */
  attachGovernance(governance: { approvals?: ApprovalService | null; budget?: BudgetGate | null }): void {
    this.options.approvals = governance.approvals ?? null;
    this.options.budget = governance.budget ?? null;
    this.promotions = new PromotionService(this.sql, this.settings, this.skills, this.memories, this.options.approvals);
    this.reviewer = new Reviewer(this.sql, this.store, this.providers, this.memories, this.skills, this.settings, this.reviewerOptions(this.options));
  }

  /** What enters the prompt at the start of a session. */
  async snapshot(companyId: string, agentId: string): Promise<LearningSnapshot> {
    const settings = await this.settings.get(companyId);
    const memory = await this.memories.snapshot(companyId, agentId, settings.snapshotMaxChars);
    const skills = await this.skills.index(companyId, agentId);
    return {
      memory: memory.text,
      skills,
      memoryCount: memory.count,
      truncated: memory.truncated,
    };
  }

  /** A task closed: skills used in it learn the outcome, and eligible ones are proposed for the company. */
  async onTaskClosed(companyId: string, taskId: string, outcome: "success" | "failure"): Promise<void> {
    await this.skills.settleTask(companyId, taskId, outcome);
    if (outcome === "success") await this.promotions.proposeEligible(companyId, taskId);
  }
}
