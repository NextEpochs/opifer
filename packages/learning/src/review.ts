/**
 * The background review: after a turn ends, a copy of the conversation is
 * read by the model with one question — what is worth keeping? — and the
 * answer becomes memories and, when a procedure emerged, a skill. It never
 * touches the live session: no message is added, the system prompt is not
 * changed, and what it saves enters play from the next session.
 */

import type { Sql } from "postgres";
import type { Message } from "@opifer/sdk";
import { audit } from "@opifer/db";
import { completeWithRecovery, estimateInputTokens, type BudgetGate, type ProviderRegistry, type SessionStore } from "@opifer/runtime";
import type { MemoryService } from "./memory.js";
import { SKILL_NAME, type SkillService } from "./skills.js";
import type { LearningSettingsService } from "./promotion.js";
import type { LearningReview, ReviewApplied, ReviewProposals } from "./types.js";

interface ReviewRow {
  id: string;
  company_id: string;
  agent_id: string;
  session_id: string;
  run_id: string | null;
  task_id: string | null;
  status: LearningReview["status"];
  proposals: ReviewProposals;
  applied: ReviewApplied;
  cost_eur: string;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

const toReview = (r: ReviewRow): LearningReview => ({
  id: r.id,
  companyId: r.company_id,
  agentId: r.agent_id,
  sessionId: r.session_id,
  runId: r.run_id,
  taskId: r.task_id,
  status: r.status,
  proposals: r.proposals,
  applied: r.applied,
  costEur: Number(r.cost_eur),
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
});

export const REVIEW_PROMPT = `You are the learning reviewer of an AI agent that works inside a company. You read a copy of a finished piece of work and decide what is worth remembering for next time. You never talk to the person: you answer with one JSON object and nothing else.

Keep only what will help the agent do better work later:
- "memories": short notes (one or two sentences each) about how to work here — preferences of the people, facts about the systems, conventions, pitfalls met. Kind "note" for how-to-work facts, "profile" (with a "subject") for facts about a person or a system. Skip anything already in the agent's memory, small talk, and anything that is a secret or a credential.
- "skill": when the work followed a procedure that will be repeated (a sequence of commands, a checklist, a way to produce a deliverable), write it as a skill: a "name" (lowercase, dashes), a one-line "description" that says WHEN to use it, and "content" in Markdown with the exact steps, commands and checks — concrete enough that the agent can follow it without thinking twice. If an existing skill was used and should be improved, put its name in "improves" and give the whole improved content. Otherwise "skill" is null.
- "retire": ids of existing memories the work proved wrong, with a reason.

Answer with exactly this shape: {"memories":[{"kind":"note","subject":"","content":"..."}],"skill":null|{"name":"...","description":"...","content":"...","improves":null|"name"},"retire":[{"id":"...","reason":"..."}],"reason":"one line on why"}
When nothing is worth keeping, answer {"memories":[],"skill":null,"retire":[],"reason":"..."}.`;

export interface ReviewerOptions {
  /** The model used for the review; the session's own model when absent. */
  model?: string | null;
  /** Largest conversation copy sent to the reviewer, in characters. */
  maxChars?: number;
  /** Budget gate: the review is charged to the agent like any other model call. */
  budget?: BudgetGate | null;
}

/** The conversation as text for the reviewer, with tool results kept short. */
export function transcriptOf(messages: Array<{ role: string; content: Message["content"] }>, maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text" && part.text.trim()) lines.push(`${m.role === "assistant" ? "AGENT" : m.role === "user" ? "PERSON" : m.role.toUpperCase()}: ${part.text.trim()}`);
      else if (part.type === "tool_call") lines.push(`AGENT calls ${part.name}(${JSON.stringify(part.arguments).slice(0, 400)})`);
      else if (part.type === "tool_result") lines.push(`RESULT (${part.isError ? "error" : "ok"}): ${part.content.slice(0, 600)}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `[... earlier part of the conversation omitted ...]\n${text.slice(text.length - maxChars)}`;
  return text;
}

/** Pulls the first JSON object out of a model answer. */
export function parseProposals(text: string): ReviewProposals | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const memories = Array.isArray(raw["memories"])
      ? (raw["memories"] as Array<Record<string, unknown>>)
          .filter((m) => typeof m["content"] === "string" && (m["content"] as string).trim())
          .map((m) => ({
            kind: m["kind"] === "profile" ? ("profile" as const) : ("note" as const),
            subject: typeof m["subject"] === "string" ? m["subject"] : "",
            content: (m["content"] as string).trim(),
          }))
      : [];
    const s = raw["skill"];
    const skill =
      s && typeof s === "object" && typeof (s as Record<string, unknown>)["name"] === "string" && typeof (s as Record<string, unknown>)["content"] === "string"
        ? {
            name: String((s as Record<string, unknown>)["name"])
              .trim()
              .toLowerCase(),
            description: String((s as Record<string, unknown>)["description"] ?? "").trim(),
            content: String((s as Record<string, unknown>)["content"]).trim(),
            improves: typeof (s as Record<string, unknown>)["improves"] === "string" ? String((s as Record<string, unknown>)["improves"]) : null,
          }
        : null;
    const retire = Array.isArray(raw["retire"])
      ? (raw["retire"] as Array<Record<string, unknown>>)
          .filter((r) => typeof r["id"] === "string")
          .map((r) => ({
            id: r["id"] as string,
            reason: String(r["reason"] ?? ""),
          }))
      : [];
    return {
      memories,
      skill,
      retire,
      reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    };
  } catch {
    return null;
  }
}

export class Reviewer {
  constructor(
    private readonly sql: Sql,
    private readonly store: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly memories: MemoryService,
    private readonly skills: SkillService,
    private readonly settings: LearningSettingsService,
    private readonly options: ReviewerOptions = {},
  ) {}

  /** Queues a review of a finished run; the worker runs it later. */
  async enqueue(input: { companyId: string; agentId: string; sessionId: string; runId?: string | null; taskId?: string | null }): Promise<LearningReview | null> {
    const settings = await this.settings.get(input.companyId);
    if (!settings.reviewEnabled) return null;
    const [row] = await this.sql<ReviewRow[]>`
      INSERT INTO learning_reviews (company_id, agent_id, session_id, run_id, task_id) VALUES (${input.companyId}, ${input.agentId}, ${input.sessionId}, ${input.runId ?? null}, ${input.taskId ?? null}) RETURNING *
    `;
    return toReview(row!);
  }

  async get(companyId: string, id: string): Promise<LearningReview | null> {
    const [row] = await this.sql<ReviewRow[]>`SELECT * FROM learning_reviews WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toReview(row) : null;
  }

  async list(companyId: string, filter: { agentId?: string; limit?: number } = {}): Promise<LearningReview[]> {
    const rows = filter.agentId
      ? await this.sql<
          ReviewRow[]
        >`SELECT * FROM learning_reviews WHERE company_id = ${companyId} AND agent_id = ${filter.agentId} ORDER BY created_at DESC LIMIT ${filter.limit ?? 50}`
      : await this.sql<ReviewRow[]>`SELECT * FROM learning_reviews WHERE company_id = ${companyId} ORDER BY created_at DESC LIMIT ${filter.limit ?? 50}`;
    return rows.map(toReview);
  }

  /** Claims one pending review, oldest first; null when there is none. */
  async claim(): Promise<LearningReview | null> {
    const [row] = await this.sql<ReviewRow[]>`
      UPDATE learning_reviews SET status = 'running', started_at = now()
      WHERE id = (SELECT id FROM learning_reviews WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *
    `;
    return row ? toReview(row) : null;
  }

  /** Runs one review to the end. Safe to call on a claimed row only. */
  async run(review: LearningReview, signal?: AbortSignal): Promise<LearningReview> {
    try {
      const session = await this.store.getSession(review.sessionId);
      if (!session) return this.finish(review.id, "skipped", { error: "session gone" });
      const messages = await this.store.listMessages(review.sessionId);
      const copy = messages.map((m) => ({ role: m.role, content: m.content }));
      const transcript = transcriptOf(copy, this.options.maxChars ?? 60_000);
      if (transcript.length < 80)
        return this.finish(review.id, "skipped", {
          error: "nothing to review",
        });

      const existing = await this.memories.list(review.companyId, {
        agentView: review.agentId,
        limit: 100,
      });
      const skillIndex = await this.skills.index(review.companyId, review.agentId);
      const context = [
        existing.length > 0
          ? `The agent already remembers (id · text):\n${existing.map((m) => `- ${m.id} · ${m.subject ? `${m.subject}: ` : ""}${m.content}`).join("\n")}`
          : "The agent remembers nothing yet.",
        skillIndex.length > 0 ? `Skills the agent already has:\n${skillIndex.map((s) => `- ${s.name}: ${s.description}`).join("\n")}` : "The agent has no skills yet.",
        `The conversation:\n${transcript}`,
      ].join("\n\n");

      const modelId = this.options.model ?? session.model;
      const primary = this.providers.resolve(modelId);
      const request = {
        system: REVIEW_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: context }],
          },
        ],
        maxOutputTokens: 2000,
        temperature: 0,
        ...(signal ? { signal } : {}),
      };

      let reservationId: string | null = null;
      if (this.options.budget && review.runId) {
        const decision = await this.options.budget.reserve(
          {
            companyId: review.companyId,
            agentId: review.agentId,
            sessionId: review.sessionId,
            runId: review.runId,
            taskId: review.taskId,
          },
          {
            modelId,
            inputTokens: estimateInputTokens(REVIEW_PROMPT, request.messages),
            maxOutputTokens: 2000,
          },
        );
        if (!decision.allowed)
          return this.finish(review.id, "skipped", {
            error: `budget: ${decision.reason}`,
          });
        reservationId = decision.reservationId;
      }
      let outcome;
      try {
        outcome = await completeWithRecovery(primary, null, request, () => {});
      } catch (error) {
        if (reservationId) await this.options.budget!.release(reservationId);
        throw error;
      }
      let costEur = 0;
      if (reservationId) {
        const settled = await this.options.budget!.settle(reservationId, outcome.modelId, outcome.usage, "auxiliary_model");
        if (settled) costEur = settled.eur;
      }
      const proposals = parseProposals(outcome.text);
      if (!proposals)
        return this.finish(review.id, "failed", {
          error: "the reviewer did not answer with JSON",
          costEur,
          proposals: { reason: outcome.text.slice(0, 500) },
        });
      const applied = await this.apply(
        review,
        proposals,
        existing.map((m) => m.id),
      );
      return this.finish(review.id, "done", { proposals, applied, costEur });
    } catch (error) {
      return this.finish(review.id, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async apply(review: LearningReview, proposals: ReviewProposals, knownIds: string[]): Promise<ReviewApplied> {
    const actor = { kind: "agent" as const, id: review.agentId };
    const source = {
      sessionId: review.sessionId,
      runId: review.runId,
      taskId: review.taskId,
    };
    const applied: ReviewApplied = {
      memoryIds: [],
      retiredIds: [],
      skill: null,
    };
    for (const m of (proposals.memories ?? []).slice(0, 8)) {
      const saved = await this.memories.remember(
        {
          companyId: review.companyId,
          scope: "agent",
          scopeAgentId: review.agentId,
          kind: m.kind,
          subject: m.subject ?? "",
          content: m.content,
          source,
        },
        actor,
      );
      applied.memoryIds!.push(saved.id);
    }
    for (const r of (proposals.retire ?? []).slice(0, 8)) {
      if (!knownIds.includes(r.id)) continue;
      await this.memories.retire(review.companyId, r.id, r.reason || "found wrong by the review", actor);
      applied.retiredIds!.push(r.id);
    }
    const s = proposals.skill;
    if (s && SKILL_NAME.test(s.name) && s.content.length > 40) {
      const target = s.improves ? await this.skills.resolve(review.companyId, review.agentId, s.improves) : await this.skills.resolve(review.companyId, review.agentId, s.name);
      if (target && target.scope === "agent" && target.scopeAgentId === review.agentId && !target.pinned) {
        const { skill, version } = await this.skills.update(
          review.companyId,
          target.id,
          {
            description: s.description || target.description,
            content: s.content,
            note: "improved by the background review",
          },
          actor,
        );
        applied.skill = {
          id: skill.id,
          name: skill.name,
          version: version.version,
        };
      } else if (!target) {
        const skill = await this.skills.create(
          {
            companyId: review.companyId,
            scope: "agent",
            scopeAgentId: review.agentId,
            name: s.name,
            description: s.description || s.name,
            content: s.content,
            origin: "agent",
            note: "learned by the background review",
          },
          actor,
        );
        applied.skill = { id: skill.id, name: skill.name, version: 1 };
      }
      // A skill that exists at a higher scope or is pinned is left alone: a person decides.
    }
    return applied;
  }

  private async finish(
    id: string,
    status: LearningReview["status"],
    patch: {
      error?: string;
      proposals?: ReviewProposals;
      applied?: ReviewApplied;
      costEur?: number;
    },
  ): Promise<LearningReview> {
    const [row] = await this.sql<ReviewRow[]>`
      UPDATE learning_reviews SET status = ${status}, error = ${patch.error ?? null}, proposals = ${(patch.proposals ?? {}) as never}::jsonb, applied = ${(patch.applied ?? {}) as never}::jsonb, cost_eur = ${patch.costEur ?? 0}, finished_at = now()
      WHERE id = ${id} RETURNING *
    `;
    const review = toReview(row!);
    if (status === "done") {
      await audit(this.sql, {
        companyId: review.companyId,
        actorKind: "system",
        action: "learning.reviewed",
        subjectKind: "learning_review",
        subjectId: review.id,
        taskId: review.taskId,
        after: {
          agentId: review.agentId,
          memories: review.applied.memoryIds?.length ?? 0,
          retired: review.applied.retiredIds?.length ?? 0,
          skill: review.applied.skill?.name ?? null,
          costEur: review.costEur,
        },
      });
    }
    return review;
  }
}
