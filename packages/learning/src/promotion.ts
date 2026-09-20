/**
 * Knowledge rises a level only with governance. A skill or memory of agent
 * scope can be proposed for the company; the company policy decides: it
 * happens by itself, after a person's review (an approval of kind
 * skill_promotion), or never. Conflicts are flagged, never merged by
 * themselves.
 */

import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import type { ApprovalService } from "@opifer/gateway";
import {
  LearningError,
  type Actor,
  type LearningSettings,
  type Promotion,
  type PromotionPolicy,
  type Scope,
} from "./types.js";
import type { MemoryService } from "./memory.js";
import type { SkillService } from "./skills.js";

interface SettingsRow {
  company_id: string;
  review_enabled: boolean;
  promotion: PromotionPolicy;
  promotion_threshold: number;
  snapshot_max_chars: number;
  inactive_after_days: number;
  archive_after_days: number;
}

interface PromotionRow {
  id: string;
  company_id: string;
  kind: "skill" | "memory";
  subject_id: string;
  from_scope: "agent" | "team";
  to_scope: "team" | "company";
  status: Promotion["status"];
  approval_id: string | null;
  evidence: Record<string, unknown>;
  result_id: string | null;
  proposed_by_kind: Actor["kind"];
  proposed_by_id: string | null;
  decided_at: Date | null;
  created_at: Date;
}

const toSettings = (r: SettingsRow): LearningSettings => ({
  companyId: r.company_id,
  reviewEnabled: r.review_enabled,
  promotion: r.promotion,
  promotionThreshold: r.promotion_threshold,
  snapshotMaxChars: r.snapshot_max_chars,
  inactiveAfterDays: r.inactive_after_days,
  archiveAfterDays: r.archive_after_days,
});

const toPromotion = (r: PromotionRow): Promotion => ({
  id: r.id,
  companyId: r.company_id,
  kind: r.kind,
  subjectId: r.subject_id,
  fromScope: r.from_scope,
  toScope: r.to_scope,
  status: r.status,
  approvalId: r.approval_id,
  evidence: r.evidence,
  resultId: r.result_id,
  proposedByKind: r.proposed_by_kind,
  proposedById: r.proposed_by_id,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});

export class LearningSettingsService {
  constructor(private readonly sql: Sql) {}

  async get(companyId: string): Promise<LearningSettings> {
    const [row] = await this.sql<SettingsRow[]>`
      INSERT INTO learning_settings (company_id) VALUES (${companyId}) ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id RETURNING *
    `;
    return toSettings(row!);
  }

  async update(
    companyId: string,
    patch: Partial<Omit<LearningSettings, "companyId">>,
    actor: Actor,
  ): Promise<LearningSettings> {
    const before = await this.get(companyId);
    const next = { ...before, ...patch };
    const [row] = await this.sql<SettingsRow[]>`
      UPDATE learning_settings SET review_enabled = ${next.reviewEnabled}, promotion = ${next.promotion}, promotion_threshold = ${next.promotionThreshold}, snapshot_max_chars = ${next.snapshotMaxChars},
        inactive_after_days = ${next.inactiveAfterDays}, archive_after_days = ${next.archiveAfterDays}
      WHERE company_id = ${companyId} RETURNING *
    `;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "learning.settings_changed",
      subjectKind: "company",
      subjectId: companyId,
      before,
      after: patch,
    });
    return toSettings(row!);
  }
}

export class PromotionService {
  constructor(
    private readonly sql: Sql,
    private readonly settings: LearningSettingsService,
    private readonly skills: SkillService,
    private readonly memories: MemoryService,
    private readonly approvals: ApprovalService | null,
  ) {}

  async get(companyId: string, id: string): Promise<Promotion | null> {
    const [row] = await this.sql<
      PromotionRow[]
    >`SELECT * FROM promotions WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toPromotion(row) : null;
  }

  async byApproval(
    companyId: string,
    approvalId: string,
  ): Promise<Promotion | null> {
    const [row] = await this.sql<
      PromotionRow[]
    >`SELECT * FROM promotions WHERE approval_id = ${approvalId} AND company_id = ${companyId}`;
    return row ? toPromotion(row) : null;
  }

  async list(
    companyId: string,
    status?: Promotion["status"][],
  ): Promise<Promotion[]> {
    const rows = status
      ? await this.sql<
          PromotionRow[]
        >`SELECT * FROM promotions WHERE company_id = ${companyId} AND status = ANY(${status}) ORDER BY created_at DESC LIMIT 200`
      : await this.sql<
          PromotionRow[]
        >`SELECT * FROM promotions WHERE company_id = ${companyId} ORDER BY created_at DESC LIMIT 200`;
    return rows.map(toPromotion);
  }

  /**
   * Proposes a promotion. Returns the promotion in its state after the
   * policy: applied (automatic), proposed with an approval (review), or
   * throws forbidden (and records the attempt).
   */
  async propose(
    companyId: string,
    kind: "skill" | "memory",
    subjectId: string,
    toScope: "team" | "company",
    actor: Actor,
    evidence: Record<string, unknown> = {},
  ): Promise<Promotion> {
    const policy = (await this.settings.get(companyId)).promotion;
    const subject =
      kind === "skill"
        ? await this.skills.get(companyId, subjectId)
        : await this.memories.get(companyId, subjectId);
    if (!subject) throw new LearningError("not_found", `${kind} not found`);
    if (subject.scope === "company")
      throw new LearningError(
        "invalid_input",
        `the ${kind} is already company-wide`,
      );
    if (subject.scope === toScope)
      throw new LearningError(
        "invalid_input",
        `the ${kind} is already at scope ${toScope}`,
      );
    const [open] = await this.sql<
      PromotionRow[]
    >`SELECT * FROM promotions WHERE company_id = ${companyId} AND subject_id = ${subjectId} AND to_scope = ${toScope} AND status IN ('proposed', 'applied')`;
    if (open) return toPromotion(open);
    const fromScope = subject.scope as "agent" | "team";
    const usage =
      kind === "skill" ? await this.skills.usage(companyId, subjectId) : null;
    const fullEvidence = {
      successes: usage?.successes ?? 0,
      failures: usage?.failures ?? 0,
      ...evidence,
      name: kind === "skill" ? (subject as { name: string }).name : undefined,
      preview:
        kind === "memory"
          ? (subject as { content: string }).content.slice(0, 200)
          : (subject as { description: string }).description,
    };

    if (policy === "forbidden") {
      const [row] = await this.sql<PromotionRow[]>`
        INSERT INTO promotions (company_id, kind, subject_id, from_scope, to_scope, status, evidence, proposed_by_kind, proposed_by_id, decided_at)
        VALUES (${companyId}, ${kind}, ${subjectId}, ${fromScope}, ${toScope}, 'forbidden', ${fullEvidence as never}::jsonb, ${actor.kind}, ${actor.id ?? null}, now()) RETURNING *
      `;
      await audit(this.sql, {
        companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "promotion.forbidden",
        subjectKind: "promotion",
        subjectId: row!.id,
        after: { kind, subjectId, toScope },
      });
      throw new LearningError(
        "forbidden",
        "the company policy forbids promotions",
      );
    }

    const [row] = await this.sql<PromotionRow[]>`
      INSERT INTO promotions (company_id, kind, subject_id, from_scope, to_scope, status, evidence, proposed_by_kind, proposed_by_id)
      VALUES (${companyId}, ${kind}, ${subjectId}, ${fromScope}, ${toScope}, 'proposed', ${fullEvidence as never}::jsonb, ${actor.kind}, ${actor.id ?? null}) RETURNING *
    `;
    let promotion = toPromotion(row!);
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "promotion.proposed",
      subjectKind: "promotion",
      subjectId: promotion.id,
      after: { kind, subjectId, fromScope, toScope, policy },
    });

    if (policy === "automatic")
      return this.apply(companyId, promotion.id, { kind: "system" });

    if (!this.approvals)
      throw new LearningError(
        "invalid_input",
        "promotions need a person's review but approvals are not configured",
      );
    const agentId = subject.scopeAgentId;
    const approval = await this.approvals.request({
      companyId,
      kind: "skill_promotion",
      agentId,
      subject: {
        promotionId: promotion.id,
        kind,
        subjectId,
        name: fullEvidence.name ?? null,
        preview: fullEvidence.preview ?? null,
        fromScope,
        toScope,
        evidence: fullEvidence,
      },
      reason:
        kind === "skill"
          ? `Share the skill "${fullEvidence.name}" with the whole company`
          : `Share a memory with the whole company`,
      risk: "medium",
    });
    await this
      .sql`UPDATE promotions SET approval_id = ${approval.id} WHERE id = ${promotion.id}`;
    promotion = { ...promotion, approvalId: approval.id };
    return promotion;
  }

  /** A person decided (through the approval): apply or deny. */
  async decide(
    companyId: string,
    promotionId: string,
    approved: boolean,
    actor: Actor,
  ): Promise<Promotion> {
    const promotion = await this.get(companyId, promotionId);
    if (!promotion) throw new LearningError("not_found", "promotion not found");
    if (promotion.status !== "proposed") return promotion;
    if (!approved) {
      const [row] = await this.sql<
        PromotionRow[]
      >`UPDATE promotions SET status = 'denied', decided_at = now() WHERE id = ${promotionId} RETURNING *`;
      await audit(this.sql, {
        companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "promotion.denied",
        subjectKind: "promotion",
        subjectId: promotionId,
      });
      return toPromotion(row!);
    }
    return this.apply(companyId, promotionId, actor);
  }

  /** Writes the promoted copy at the target scope. The original stays where it was. */
  private async apply(
    companyId: string,
    promotionId: string,
    actor: Actor,
  ): Promise<Promotion> {
    const promotion = await this.get(companyId, promotionId);
    if (!promotion) throw new LearningError("not_found", "promotion not found");
    const toScope: Scope = promotion.toScope;
    let resultId: string;
    if (promotion.kind === "skill") {
      const skill = await this.skills.get(companyId, promotion.subjectId);
      const version = skill
        ? await this.skills.version(companyId, skill.id)
        : null;
      if (!skill || !version)
        throw new LearningError("not_found", "skill not found");
      const clash = (
        await this.skills.list(companyId, {
          scope: toScope,
          scopeAgentId: null,
          status: ["active", "inactive", "archived"],
        })
      ).find((s) => s.name === skill.name);
      if (clash) {
        await this
          .sql`UPDATE promotions SET status = 'denied', decided_at = now(), evidence = evidence || ${{ conflict: clash.id } as never}::jsonb WHERE id = ${promotionId}`;
        throw new LearningError(
          "conflict",
          `a ${toScope} skill named "${skill.name}" already exists: merge them by hand`,
        );
      }
      const created = await this.skills.create(
        {
          companyId,
          scope: toScope,
          scopeAgentId: null,
          name: skill.name,
          description: skill.description,
          content: version.content,
          files: version.files,
          tags: skill.tags,
          origin: skill.origin,
          note: `promoted from ${promotion.fromScope} scope`,
        },
        actor,
      );
      await this
        .sql`UPDATE skills SET promoted_from_id = ${skill.id} WHERE id = ${created.id}`;
      resultId = created.id;
    } else {
      const memory = await this.memories.get(companyId, promotion.subjectId);
      if (!memory) throw new LearningError("not_found", "memory not found");
      const copy = await this.memories.remember(
        {
          companyId,
          scope: toScope,
          scopeAgentId: null,
          kind: memory.kind,
          subject: memory.subject,
          content: memory.content,
          source: {
            sessionId: memory.sourceSessionId,
            runId: memory.sourceRunId,
            taskId: memory.sourceTaskId,
          },
        },
        actor,
      );
      resultId = copy.id;
    }
    const [row] = await this.sql<
      PromotionRow[]
    >`UPDATE promotions SET status = 'applied', result_id = ${resultId}, decided_at = now() WHERE id = ${promotionId} RETURNING *`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "promotion.applied",
      subjectKind: "promotion",
      subjectId: promotionId,
      after: {
        kind: promotion.kind,
        subjectId: promotion.subjectId,
        toScope,
        resultId,
      },
    });
    return toPromotion(row!);
  }

  /** After a successful task: agent skills past the threshold get proposed for the company. */
  async proposeEligible(
    companyId: string,
    taskId: string,
  ): Promise<Promotion[]> {
    const settings = await this.settings.get(companyId);
    const rows = await this.sql<{ skill_id: string; successes: string }[]>`
      SELECT u.skill_id, count(*) FILTER (WHERE u.outcome = 'success')::text AS successes
      FROM skill_usage u JOIN skills s ON s.id = u.skill_id
      WHERE u.company_id = ${companyId} AND s.scope = 'agent' AND s.status = 'active' AND s.origin = 'agent'
        AND u.skill_id IN (SELECT skill_id FROM skill_usage WHERE task_id = ${taskId})
      GROUP BY u.skill_id
    `;
    const out: Promotion[] = [];
    for (const r of rows) {
      if (Number(r.successes) < settings.promotionThreshold) continue;
      try {
        out.push(
          await this.propose(
            companyId,
            "skill",
            r.skill_id,
            "company",
            { kind: "system" },
            {
              successes: Number(r.successes),
              threshold: settings.promotionThreshold,
            },
          ),
        );
      } catch (error) {
        if (!(error instanceof LearningError)) throw error;
      }
    }
    return out;
  }
}
