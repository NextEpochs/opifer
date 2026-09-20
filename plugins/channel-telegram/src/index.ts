/**
 * Telegram channel: a bot per company, long polling (no public URL needed),
 * messages to and from people, inline buttons for approvals and controls.
 * Implemented from the public Bot API over fetch; no dependency.
 */

import type { Channel, InboundMessage, OutboundMessage } from "@opifer/sdk";

export interface TelegramChannelOptions {
  /** Identifier of the channel record in Opifer. */
  id: string;
  token: string;
  /** Bot API base, overridable for tests. */
  apiBase?: string;
  /** Long-poll timeout in seconds. */
  pollSeconds?: number;
  onError?: (error: unknown) => void;
}

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

/** Telegram's MarkdownV2 wants most punctuation escaped; plain text with a few bold lines is safer. */
export function toTelegramHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/```([\s\S]*?)```/g, (_, code: string) => `<pre>${code.trim()}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
}

export class TelegramChannel implements Channel {
  readonly id: string;
  private readonly apiBase: string;
  private readonly pollSeconds: number;
  private running = false;
  private offset = 0;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly options: TelegramChannelOptions) {
    this.id = options.id;
    this.apiBase = `${options.apiBase ?? "https://api.telegram.org"}/bot${options.token}`;
    this.pollSeconds = options.pollSeconds ?? 25;
  }

  /** The bot's identity: a sign of life and its @username. */
  async me(): Promise<{ id: number; username: string }> {
    const result = (await this.call("getMe", {})) as { id: number; username: string };
    return { id: result.id, username: result.username };
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.loop = this.poll(onMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  async send(message: OutboundMessage): Promise<void> {
    const chunks = split(message.text, 3800);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      await this.call("sendMessage", {
        chat_id: message.externalChatId,
        text: message.markdown === false ? chunk : toTelegramHtml(chunk),
        parse_mode: message.markdown === false ? undefined : "HTML",
        ...(last && message.actions && message.actions.length > 0
          ? { reply_markup: { inline_keyboard: [message.actions.map((a) => ({ text: a.label, callback_data: a.id.slice(0, 64) }))] } }
          : {}),
      }).catch(async (error) => {
        // A formatting refusal falls back to plain text rather than losing the message.
        if (String(error).includes("parse")) await this.call("sendMessage", { chat_id: message.externalChatId, text: chunk });
        else throw error;
      });
    }
  }

  /** One long poll after another, until stopped. Each update is acknowledged by the next offset. */
  private async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        const updates = (await this.call(
          "getUpdates",
          { offset: this.offset, timeout: this.pollSeconds, allowed_updates: ["message", "callback_query"] },
          this.controller?.signal,
        )) as TgUpdate[];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const inbound = this.toInbound(update);
          if (inbound) {
            try {
              await onMessage(inbound);
            } catch (error) {
              this.options.onError?.(error);
            }
          }
          if (update.callback_query) await this.call("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
        }
      } catch (error) {
        if (!this.running) return;
        this.options.onError?.(error);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private toInbound(update: TgUpdate): InboundMessage | null {
    if (update.callback_query) {
      const q = update.callback_query;
      if (!q.message || !q.data) return null;
      return { channelId: this.id, externalChatId: String(q.message.chat.id), externalSenderId: String(q.from.id), senderName: nameOf(q.from), text: "", actionId: q.data };
    }
    const m = update.message;
    if (!m || !m.from || !m.text) return null;
    return { channelId: this.id, externalChatId: String(m.chat.id), externalSenderId: String(m.from.id), senderName: nameOf(m.from), text: m.text };
  }

  private async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!response.ok || !body.ok) throw new Error(`Telegram ${method}: ${body.description ?? response.status}`);
    return body.result;
  }
}

function nameOf(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : String(u.id));
}

function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
