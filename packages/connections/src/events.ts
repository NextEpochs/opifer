/**
 * Outbound events: the company's bus events, delivered to subscribed URLs
 * as signed JSON (HMAC-SHA256 over the body in `X-Opifer-Signature`), with
 * retries and a record of every attempt.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { DomainEvent } from "@opifer/core";
import { audit } from "@opifer/db";
import { ConnectionError, type Actor, type EventDelivery, type EventSubscription } from "./types.js";

interface SubRow {
  id: string;
  company_id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  failures: number;
  last_delivered_at: Date | null;
  created_at: Date;
}

interface DeliveryRow {
  id: string;
  company_id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: EventDelivery["status"];
  attempts: number;
  next_attempt_at: Date;
  response_status: number | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

const toSub = (r: SubRow): EventSubscription => ({
  id: r.id,
  companyId: r.company_id,
  name: r.name,
  url: r.url,
  events: r.events,
  enabled: r.enabled,
  failures: r.failures,
  lastDeliveredAt: r.last_delivered_at,
  createdAt: r.created_at,
});
const toDelivery = (r: DeliveryRow): EventDelivery => ({
  id: r.id,
  companyId: r.company_id,
  subscriptionId: r.subscription_id,
  eventType: r.event_type,
  payload: r.payload,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  responseStatus: r.response_status,
  error: r.error,
  deliveredAt: r.delivered_at,
  createdAt: r.created_at,
});

export function signPayload(secret: string, body: string, timestamp: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
/** Events that are internal chatter and never leave the server. */
const NEVER_SENT = new Set(["session.event", "connected"]);

export class EventService {
  constructor(private readonly sql: Sql) {}

  async create(input: { companyId: string; name: string; url: string; events?: string[] }, actor: Actor): Promise<EventSubscription & { secret: string }> {
    if (!input.name.trim()) throw new ConnectionError("invalid_input", "a subscription needs a name");
    try {
      const url = new URL(input.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new ConnectionError("invalid_input", "the url must be http(s)");
    }
    const [existing] = await this.sql<{ id: string }[]>`SELECT id FROM event_subscriptions WHERE company_id = ${input.companyId} AND name = ${input.name.trim()}`;
    if (existing) throw new ConnectionError("conflict", `a subscription named "${input.name.trim()}" already exists`);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const [row] = await this.sql<SubRow[]>`
      INSERT INTO event_subscriptions (company_id, name, url, events, secret) VALUES (${input.companyId}, ${input.name.trim()}, ${input.url}, ${input.events && input.events.length > 0 ? input.events : ["*"]}, ${secret}) RETURNING *
    `;
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "subscription.created",
      subjectKind: "event_subscription",
      subjectId: row!.id,
      after: { name: row!.name, url: row!.url, events: row!.events },
    });
    return { ...toSub(row!), secret };
  }

  async list(companyId: string): Promise<EventSubscription[]> {
    return (await this.sql<SubRow[]>`SELECT * FROM event_subscriptions WHERE company_id = ${companyId} ORDER BY name`).map(toSub);
  }

  async update(companyId: string, id: string, patch: { url?: string; events?: string[]; enabled?: boolean }, actor: Actor): Promise<EventSubscription> {
    const [current] = await this.sql<SubRow[]>`SELECT * FROM event_subscriptions WHERE id = ${id} AND company_id = ${companyId}`;
    if (!current) throw new ConnectionError("not_found", "subscription not found");
    const [row] = await this.sql<
      SubRow[]
    >`UPDATE event_subscriptions SET url = ${patch.url ?? current.url}, events = ${patch.events ?? current.events}, enabled = ${patch.enabled ?? current.enabled}, failures = CASE WHEN ${patch.enabled ?? current.enabled} THEN 0 ELSE failures END WHERE id = ${id} RETURNING *`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "subscription.updated",
      subjectKind: "event_subscription",
      subjectId: id,
      after: patch,
    });
    return toSub(row!);
  }

  async remove(companyId: string, id: string, actor: Actor): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`DELETE FROM event_subscriptions WHERE id = ${id} AND company_id = ${companyId} RETURNING id`;
    if (rows.length === 0) throw new ConnectionError("not_found", "subscription not found");
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "subscription.removed", subjectKind: "event_subscription", subjectId: id });
  }

  /** Queues a bus event for every matching subscription of its company. */
  async enqueue(event: DomainEvent): Promise<number> {
    if (!event.companyId || NEVER_SENT.has(event.type)) return 0;
    const subs = await this.sql<SubRow[]>`SELECT * FROM event_subscriptions WHERE company_id = ${event.companyId} AND enabled`;
    let queued = 0;
    for (const s of subs) {
      if (!s.events.includes("*") && !s.events.includes(event.type) && !s.events.some((e) => e.endsWith(".*") && event.type.startsWith(e.slice(0, -1)))) continue;
      await this
        .sql`INSERT INTO event_deliveries (company_id, subscription_id, event_type, payload) VALUES (${event.companyId}, ${s.id}, ${event.type}, ${{ type: event.type, companyId: event.companyId, occurredAt: event.occurredAt, payload: event.payload } as never}::jsonb)`;
      queued++;
    }
    return queued;
  }

  async deliveries(companyId: string, limit = 50): Promise<EventDelivery[]> {
    return (await this.sql<DeliveryRow[]>`SELECT * FROM event_deliveries WHERE company_id = ${companyId} ORDER BY created_at DESC LIMIT ${limit}`).map(toDelivery);
  }

  /** Sends what is due, one attempt each; returns how many were delivered. */
  async flush(fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<{ delivered: number; failed: number }> {
    const due = await this.sql<(DeliveryRow & { url: string; secret: string; sub_enabled: boolean })[]>`
      SELECT d.*, s.url, s.secret, s.enabled AS sub_enabled FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ${now} ORDER BY d.created_at LIMIT 50
    `;
    let delivered = 0;
    let failed = 0;
    for (const d of due) {
      if (!d.sub_enabled) {
        await this.sql`UPDATE event_deliveries SET status = 'failed', error = 'subscription disabled' WHERE id = ${d.id}`;
        failed++;
        continue;
      }
      const body = JSON.stringify(d.payload);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      let status: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetchImpl(d.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opifer-event": d.event_type, "x-opifer-delivery": d.id, "x-opifer-signature": signPayload(d.secret, body, timestamp) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
        if (!response.ok) error = `HTTP ${response.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const attempts = d.attempts + 1;
      if (!error) {
        await this.sql`UPDATE event_deliveries SET status = 'delivered', attempts = ${attempts}, response_status = ${status}, delivered_at = now() WHERE id = ${d.id}`;
        await this.sql`UPDATE event_subscriptions SET failures = 0, last_delivered_at = now() WHERE id = ${d.subscription_id}`;
        delivered++;
      } else if (attempts >= BACKOFF_MS.length) {
        await this.sql`UPDATE event_deliveries SET status = 'failed', attempts = ${attempts}, response_status = ${status}, error = ${error} WHERE id = ${d.id}`;
        await this.sql`UPDATE event_subscriptions SET failures = failures + 1 WHERE id = ${d.subscription_id}`;
        failed++;
      } else {
        await this
          .sql`UPDATE event_deliveries SET attempts = ${attempts}, response_status = ${status}, error = ${error}, next_attempt_at = ${new Date(now.getTime() + BACKOFF_MS[attempts - 1]!)} WHERE id = ${d.id}`;
      }
    }
    return { delivered, failed };
  }
}
