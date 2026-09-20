/**
 * Channels: a bot per company on a messaging platform, and who is who on
 * it. An unknown sender is refused until a person claims it with a pairing
 * code typed in the interface; a chat is bound to an agent and keeps its
 * session. The transport (Telegram…) is a plugin; this is the record.
 */

import { randomInt } from "node:crypto";
import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import { ConnectionError, type Actor, type ChannelBinding, type ChannelKind, type ChannelRecord } from "./types.js";

interface ChannelRow {
  id: string;
  company_id: string;
  kind: ChannelKind;
  name: string;
  secret_name: string;
  default_agent_id: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  status: ChannelRecord["status"];
  status_detail: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

interface BindingRow {
  id: string;
  company_id: string;
  channel_id: string;
  external_sender_id: string;
  external_chat_id: string;
  user_id: string | null;
  display_name: string;
  pairing_code: string | null;
  pairing_expires_at: Date | null;
  agent_id: string | null;
  session_id: string | null;
  notify: boolean;
  last_message_at: Date | null;
  created_at: Date;
}

const toChannel = (r: ChannelRow): ChannelRecord => ({
  id: r.id,
  companyId: r.company_id,
  kind: r.kind,
  name: r.name,
  secretName: r.secret_name,
  defaultAgentId: r.default_agent_id,
  config: r.config,
  enabled: r.enabled,
  status: r.status,
  statusDetail: r.status_detail,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});
const toBinding = (r: BindingRow): ChannelBinding => ({
  id: r.id,
  companyId: r.company_id,
  channelId: r.channel_id,
  externalSenderId: r.external_sender_id,
  externalChatId: r.external_chat_id,
  userId: r.user_id,
  displayName: r.display_name,
  pairingCode: r.pairing_code,
  pairingExpiresAt: r.pairing_expires_at,
  agentId: r.agent_id,
  sessionId: r.session_id,
  notify: r.notify,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
});

export function newPairingCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export class ChannelService {
  constructor(private readonly sql: Sql) {}

  async create(
    input: { companyId: string; kind: ChannelKind; name: string; secretName: string; defaultAgentId?: string | null; config?: Record<string, unknown> },
    actor: Actor,
  ): Promise<ChannelRecord> {
    if (!input.name.trim()) throw new ConnectionError("invalid_input", "a channel needs a name");
    const [existing] = await this.sql<{ id: string }[]>`SELECT id FROM channels WHERE company_id = ${input.companyId} AND name = ${input.name.trim()}`;
    if (existing) throw new ConnectionError("conflict", `a channel named "${input.name.trim()}" already exists`);
    const [row] = await this.sql<ChannelRow[]>`
      INSERT INTO channels (company_id, kind, name, secret_name, default_agent_id, config) VALUES (${input.companyId}, ${input.kind}, ${input.name.trim()}, ${input.secretName}, ${input.defaultAgentId ?? null}, ${(input.config ?? {}) as never}::jsonb) RETURNING *
    `;
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "channel.created",
      subjectKind: "channel",
      subjectId: row!.id,
      after: { kind: input.kind, name: row!.name },
    });
    return toChannel(row!);
  }

  async get(companyId: string, id: string): Promise<ChannelRecord | null> {
    const [row] = await this.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toChannel(row) : null;
  }

  async list(companyId: string): Promise<ChannelRecord[]> {
    return (await this.sql<ChannelRow[]>`SELECT * FROM channels WHERE company_id = ${companyId} ORDER BY name`).map(toChannel);
  }

  /** Every enabled channel of every company: what the hub starts. */
  async listAll(): Promise<ChannelRecord[]> {
    return (await this.sql<ChannelRow[]>`SELECT * FROM channels WHERE enabled ORDER BY company_id, name`).map(toChannel);
  }

  async update(
    companyId: string,
    id: string,
    patch: { name?: string; defaultAgentId?: string | null; config?: Record<string, unknown>; enabled?: boolean; secretName?: string },
    actor: Actor,
  ): Promise<ChannelRecord> {
    const current = await this.get(companyId, id);
    if (!current) throw new ConnectionError("not_found", "channel not found");
    const [row] = await this.sql<ChannelRow[]>`
      UPDATE channels SET name = ${patch.name ?? current.name}, default_agent_id = ${patch.defaultAgentId === undefined ? current.defaultAgentId : patch.defaultAgentId}, config = ${(patch.config ?? current.config) as never}::jsonb, enabled = ${patch.enabled ?? current.enabled}, secret_name = ${patch.secretName ?? current.secretName}
      WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "channel.updated", subjectKind: "channel", subjectId: id, after: patch });
    return toChannel(row!);
  }

  async remove(companyId: string, id: string, actor: Actor): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`DELETE FROM channels WHERE id = ${id} AND company_id = ${companyId} RETURNING id`;
    if (rows.length === 0) throw new ConnectionError("not_found", "channel not found");
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "channel.removed", subjectKind: "channel", subjectId: id });
  }

  async setStatus(id: string, status: ChannelRecord["status"], detail: string | null): Promise<void> {
    await this
      .sql`UPDATE channels SET status = ${status}, status_detail = ${detail}, last_seen_at = CASE WHEN ${status} = 'healthy' THEN now() ELSE last_seen_at END WHERE id = ${id}`;
  }

  async touch(id: string): Promise<void> {
    await this.sql`UPDATE channels SET last_seen_at = now(), status = 'healthy', status_detail = NULL WHERE id = ${id}`;
  }

  // --- Bindings ---------------------------------------------------------------

  async binding(channelId: string, externalChatId: string, externalSenderId: string): Promise<ChannelBinding | null> {
    const [row] = await this.sql<
      BindingRow[]
    >`SELECT * FROM channel_bindings WHERE channel_id = ${channelId} AND external_chat_id = ${externalChatId} AND external_sender_id = ${externalSenderId}`;
    return row ? toBinding(row) : null;
  }

  async bindings(companyId: string, channelId?: string): Promise<ChannelBinding[]> {
    const rows = channelId
      ? await this.sql<BindingRow[]>`SELECT * FROM channel_bindings WHERE company_id = ${companyId} AND channel_id = ${channelId} ORDER BY created_at`
      : await this.sql<BindingRow[]>`SELECT * FROM channel_bindings WHERE company_id = ${companyId} ORDER BY created_at`;
    return rows.map(toBinding);
  }

  /** Bindings that receive notifications (paired people who asked for them). */
  async notifiable(companyId: string): Promise<ChannelBinding[]> {
    const rows = await this.sql<
      BindingRow[]
    >`SELECT b.* FROM channel_bindings b JOIN channels c ON c.id = b.channel_id WHERE b.company_id = ${companyId} AND b.user_id IS NOT NULL AND b.notify AND c.enabled`;
    return rows.map(toBinding);
  }

  /** An unknown sender writes: a binding with a pairing code, valid 15 minutes; the code is what the person types in the interface. */
  async pairingFor(channel: ChannelRecord, externalChatId: string, externalSenderId: string, displayName: string): Promise<ChannelBinding> {
    const existing = await this.binding(channel.id, externalChatId, externalSenderId);
    if (existing?.userId) return existing;
    const code = newPairingCode();
    const expires = new Date(Date.now() + 15 * 60_000);
    const [row] = await this.sql<BindingRow[]>`
      INSERT INTO channel_bindings (company_id, channel_id, external_sender_id, external_chat_id, display_name, pairing_code, pairing_expires_at)
      VALUES (${channel.companyId}, ${channel.id}, ${externalSenderId}, ${externalChatId}, ${displayName}, ${code}, ${expires})
      ON CONFLICT (channel_id, external_chat_id, external_sender_id) DO UPDATE SET pairing_code = EXCLUDED.pairing_code, pairing_expires_at = EXCLUDED.pairing_expires_at, display_name = EXCLUDED.display_name
      RETURNING *
    `;
    return toBinding(row!);
  }

  /** A person claims a sender with the code: from now on the sender is that person. */
  async pair(companyId: string, code: string, userId: string | null, actor: Actor): Promise<ChannelBinding> {
    const [row] = await this.sql<BindingRow[]>`SELECT * FROM channel_bindings WHERE company_id = ${companyId} AND pairing_code = ${code.trim()}`;
    if (!row) throw new ConnectionError("not_found", "no pending pairing with this code");
    if (row.pairing_expires_at && row.pairing_expires_at.getTime() < Date.now())
      throw new ConnectionError("invalid_input", "the code has expired: write to the bot again for a new one");
    let user = userId;
    if (!user) {
      // Local mode has no accounts yet: the owner is the first (or only) user, created on demand.
      const [u] = await this.sql<{ id: string }[]>`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.company_id = ${companyId} ORDER BY m.created_at LIMIT 1`;
      if (u) user = u.id;
      else {
        const [created] = await this.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Owner') RETURNING id`;
        await this.sql`INSERT INTO memberships (company_id, user_id, role) VALUES (${companyId}, ${created!.id}, 'owner')`;
        user = created!.id;
      }
    }
    const [updated] = await this.sql<BindingRow[]>`UPDATE channel_bindings SET user_id = ${user}, pairing_code = NULL, pairing_expires_at = NULL WHERE id = ${row.id} RETURNING *`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "channel.paired",
      subjectKind: "channel_binding",
      subjectId: row.id,
      after: { displayName: row.display_name, userId: user },
    });
    return toBinding(updated!);
  }

  async setAgent(bindingId: string, agentId: string | null): Promise<void> {
    await this.sql`UPDATE channel_bindings SET agent_id = ${agentId}, session_id = NULL WHERE id = ${bindingId}`;
  }

  async setSession(bindingId: string, sessionId: string | null): Promise<void> {
    await this.sql`UPDATE channel_bindings SET session_id = ${sessionId}, last_message_at = now() WHERE id = ${bindingId}`;
  }

  async setNotify(companyId: string, bindingId: string, notify: boolean): Promise<void> {
    await this.sql`UPDATE channel_bindings SET notify = ${notify} WHERE id = ${bindingId} AND company_id = ${companyId}`;
  }

  async unpair(companyId: string, bindingId: string, actor: Actor): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`DELETE FROM channel_bindings WHERE id = ${bindingId} AND company_id = ${companyId} RETURNING id`;
    if (rows.length === 0) throw new ConnectionError("not_found", "binding not found");
    await audit(this.sql, { companyId, actorKind: actor.kind, actorId: actor.id ?? null, action: "channel.unpaired", subjectKind: "channel_binding", subjectId: bindingId });
  }
}
