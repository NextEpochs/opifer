/**
 * Runs the background reviews one at a time, outside every turn, and the
 * curator once in a while. Nothing here touches a live session.
 */

import type { Sql } from "postgres";
import type { EventBus } from "@opifer/core";
import type { LearningService } from "@opifer/learning";
import type { FastifyBaseLogger } from "fastify";

export interface LearningWorkerOptions {
  sql: Sql;
  learning: LearningService;
  bus: EventBus;
  log: FastifyBaseLogger;
  tickMs?: number;
  /** How often the curator looks at unused skills. */
  curatorEveryMs?: number;
}

export class LearningWorker {
  private timer: NodeJS.Timeout | null = null;
  private curatorTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  private readonly tickMs: number;
  private readonly curatorEveryMs: number;

  constructor(private readonly options: LearningWorkerOptions) {
    this.tickMs = options.tickMs ?? 3000;
    this.curatorEveryMs = options.curatorEveryMs ?? 12 * 3_600_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    this.curatorTimer = setInterval(
      () => void this.curate(),
      this.curatorEveryMs,
    );
    this.curatorTimer.unref();
    setTimeout(() => void this.curate(), 30_000).unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.curatorTimer) clearInterval(this.curatorTimer);
    this.timer = null;
    this.curatorTimer = null;
  }

  /** One pass: claims and runs pending reviews until none is left. Also used by tests. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let done = 0;
    try {
      for (;;) {
        const review = await this.options.learning.reviewer.claim();
        if (!review) break;
        const result = await this.options.learning.reviewer.run(review);
        done++;
        this.options.bus.publish("learning.reviewed", result.companyId, {
          reviewId: result.id,
          agentId: result.agentId,
          status: result.status,
          memories: result.applied.memoryIds?.length ?? 0,
          skill: result.applied.skill?.name ?? null,
        });
        if (result.status === "failed")
          this.options.log.warn(
            { reviewId: result.id, error: result.error },
            "learning review failed",
          );
        if (this.stopped) break;
      }
    } catch (error) {
      this.options.log.error({ err: error }, "learning worker tick failed");
    } finally {
      this.busy = false;
    }
    return done;
  }

  /** The curator, for every company. */
  async curate(): Promise<void> {
    try {
      const companies = await this.options.sql<
        { id: string }[]
      >`SELECT id FROM companies WHERE status = 'active'`;
      for (const c of companies) {
        const settings = await this.options.learning.settings.get(c.id);
        const result = await this.options.learning.skills.curate(c.id, {
          inactiveAfterDays: settings.inactiveAfterDays,
          archiveAfterDays: settings.archiveAfterDays,
        });
        if (result.archived.length > 0 || result.inactivated.length > 0)
          this.options.bus.publish("learning.curated", c.id, result);
      }
    } catch (error) {
      this.options.log.error({ err: error }, "curator failed");
    }
  }
}
