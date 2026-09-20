/**
 * Inbound webhooks: an external system (n8n, Zapier, Make, a script) calls
 * one URL with a bearer token and Opifer creates a task, wakes an agent,
 * comments on a task or decides an approval. The token is shown once and
 * stored hashed.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import { ConnectionError, type Actor, type Webhook, type WebhookAction } from "./types.js";

interface Row {
  id: string;
  company_id: string;
  name: string;
  action: WebhookAction;
  token_hash: string;
  defaults: Record<string, unknown>;
  enabled: boolean;
  calls: number;
  last_called_at: Date | null;
  created_at: Date;
}

const toWebhook = (r: Row): Webhook => ({
  id: r.id,
  companyId: r.company_id,
  name: r.name,
  action: r.action,
  defaults: r.defaults,
  enabled: r.enabled,
  calls: r.calls,
  lastCalledAt: r.last_called_at,
  createdAt: r.created_at,
});

export function newToken(): string {
  return `opw_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What a webhook does once authenticated; the server wires these to work and governance. */
export interface WebhookHandlers {
  createTask(companyId: string, input: Record<string, unknown>): Promise<{ id: string; status: string }>;
  wakeAgent(companyId: string, agentId: string, text: string, options: { sessionTitle?: string }): Promise<{ sessionId: string }>;
  comment(companyId: string, taskId: string, body: string): Promise<{ id: string }>;
  decideApproval(companyId: string, approvalId: string, status: "approved" | "denied", note?: string): Promise<{ id: string; status: string }>;
}

export class WebhookService {
  constructor(private readonly sql: Sql) {}

  /** Creates the webhook and returns the token once. */
  async create(input: { companyId: string; name: string; action: WebhookAction; defaults?: Record<string, unknown> }, actor: Actor): Promise<{ webhook: Webhook; token: string }> {
    if (!input.name.trim()) throw new ConnectionError("invalid_input", "a webhook needs a name");
    const [existing] = await this.sql<{ id: string }[]>`SELECT id FROM webhooks WHERE company_id = ${input.companyId} AND name = ${input.name.trim()}`;
    if (existing) throw new ConnectionError("conflict", `a webhook named "${input.name.trim()}" already exists`);
    const token = newToken();
    const [row] = await this.sql<Row[]>`
      INSERT INTO webhooks (company_id, name, action, token_hash, defaults) VALUES (${input.companyId}, ${input.name.trim()}, ${input.action}, ${hashToken(token)}, ${(input.defaults ?? {}) as never}::jsonb) RETURNING *
    `;
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "webhook.created",
      subjectKind: "webhook",
      subjectId: row!.id,
      after: { name: row!.name, action: row!.action },
    });
    return { webhook: toWebhook(row!), token };
  }

  async list(companyId: string): Promise<Webhook[]> {
    return (await this.sql<Row[]>`SELECT * FROM webhooks WHERE company_id = ${companyId} ORDER BY name`).map(toWebhook);
  }

  async get(companyId: string, id: string): Promise<Webhook | null> {
    const [row] = await this.sql<Row[]>`SELECT * FROM webhooks WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toWebhook(row) : null;
  }

  async update(companyId: string, id: string, patch: { enabled?: boolean; defaults?: Record<string, unknown> }, actor: Actor): Promise<Webhook> {
    const current = await this.get(companyId, id);
    if (!current) throw new ConnectionError("not_found", "webhook not found");
    const [row] = await this.sql<
      Row[]
    >`UPDATE webhooks SET enabled = ${patch.enabled ?? current.enabled}, defaults = ${(patch.defaults ?? current.defaults) as never}::jsonb WHERE id = ${id} RETURNING *`;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "webhook.updated", subjectKind: "webhook", subjectId: id, after: patch });
    return toWebhook(row!);
  }

  /** A new token; the old one stops working at once. */
  async rotate(companyId: string, id: string, actor: Actor): Promise<{ webhook: Webhook; token: string }> {
    const token = newToken();
    const [row] = await this.sql<Row[]>`UPDATE webhooks SET token_hash = ${hashToken(token)} WHERE id = ${id} AND company_id = ${companyId} RETURNING *`;
    if (!row) throw new ConnectionError("not_found", "webhook not found");
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "webhook.rotated", subjectKind: "webhook", subjectId: id });
    return { webhook: toWebhook(row), token };
  }

  async remove(companyId: string, id: string, actor: Actor): Promise<void> {
    const current = await this.get(companyId, id);
    if (!current) throw new ConnectionError("not_found", "webhook not found");
    await this.sql`DELETE FROM webhooks WHERE id = ${id}`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "webhook.removed",
      subjectKind: "webhook",
      subjectId: id,
      before: { name: current.name },
    });
  }

  /** Authenticates a call by id and bearer token. */
  async authenticate(id: string, token: string | null): Promise<Webhook | null> {
    if (!token) return null;
    const [row] = await this.sql<Row[]>`SELECT * FROM webhooks WHERE id = ${id}`;
    if (!row || !row.enabled) return null;
    const given = Buffer.from(hashToken(token));
    const stored = Buffer.from(row.token_hash);
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
    return toWebhook(row);
  }

  /** Runs the webhook's action with the call's body over its defaults. */
  async handle(webhook: Webhook, body: Record<string, unknown>, handlers: WebhookHandlers): Promise<Record<string, unknown>> {
    const input = { ...webhook.defaults, ...body };
    const str = (k: string): string | undefined => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : undefined);
    let result: Record<string, unknown>;
    switch (webhook.action) {
      case "create_task": {
        const title = str("title");
        if (!title) throw new ConnectionError("invalid_input", "the body needs a title");
        result = await handlers.createTask(webhook.companyId, {
          title,
          description: str("description") ?? "",
          acceptance: str("acceptance") ?? "",
          priority: str("priority") ?? "normal",
          assigneeAgentId: str("agentId") ?? null,
          projectId: str("projectId") ?? null,
        });
        break;
      }
      case "wake_agent": {
        const agentId = str("agentId");
        const text = str("text") ?? str("message");
        if (!agentId || !text) throw new ConnectionError("invalid_input", "the body needs agentId (or a default) and text");
        result = await handlers.wakeAgent(webhook.companyId, agentId, text, { ...(str("sessionTitle") ? { sessionTitle: str("sessionTitle")! } : {}) });
        break;
      }
      case "comment": {
        const taskId = str("taskId");
        const text = str("text") ?? str("body");
        if (!taskId || !text) throw new ConnectionError("invalid_input", "the body needs taskId and text");
        result = await handlers.comment(webhook.companyId, taskId, text);
        break;
      }
      case "decide_approval": {
        const approvalId = str("approvalId");
        const status = str("status");
        if (!approvalId || (status !== "approved" && status !== "denied")) throw new ConnectionError("invalid_input", "the body needs approvalId and status approved|denied");
        result = await handlers.decideApproval(webhook.companyId, approvalId, status, str("note"));
        break;
      }
    }
    await this.sql`UPDATE webhooks SET calls = calls + 1, last_called_at = now() WHERE id = ${webhook.id}`;
    await audit(this.sql, {
      companyId: webhook.companyId,
      actorKind: "system",
      action: "webhook.called",
      subjectKind: "webhook",
      subjectId: webhook.id,
      after: { action: webhook.action, result },
    });
    return result;
  }
}
