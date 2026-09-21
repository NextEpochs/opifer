/**
 * Email as a connection: one mailbox per connection (SMTP to send, IMAP to
 * read and search), the password a company secret. The tools it exposes are
 * `<name>__send`, `<name>__list`, `<name>__read`, `<name>__search`; sending is
 * high risk (it asks unless allowed), reading is low.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter, type TransportOptions } from "nodemailer";
import type { DiscoveredTool, Risk, ToolConnection } from "./types.js";

export interface EmailConfig {
  smtpHost: string;
  smtpPort?: number;
  /** TLS from the first byte (465); otherwise STARTTLS is tried on 587. */
  smtpSecure?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  user: string;
  /** The address (and name) messages are sent from, e.g. "Opifer <agents@example.com>". */
  from: string;
  /** The secret holding the password; EMAIL_PASSWORD by default. */
  passwordSecret?: string;
}

export const EMAIL_TOOL_RISK: Record<string, Risk> = { send: "high", list: "low", read: "low", search: "low" };

export const EMAIL_TOOLS: DiscoveredTool[] = [
  {
    name: "send",
    description:
      "Sends an email from this mailbox. Plain text; a person approves it unless the policy allows sending. Say to whom, the subject and the body; cc and bcc are optional; reply_to_id answers a message read before.",
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Addresses, comma-separated" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text" },
        cc: { type: "string" },
        bcc: { type: "string" },
        reply_to_id: { type: "string", description: "The Message-ID being answered" },
      },
    },
  },
  {
    name: "list",
    description: "The latest messages of a folder (INBOX by default): number, date, from, subject, whether read. Use read for the body.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "INBOX by default" },
        count: { type: "integer", minimum: 1, maximum: 50, description: "How many (default 20)" },
        unread_only: { type: "boolean" },
      },
    },
  },
  {
    name: "read",
    description: "Reads one message by its number in the folder: headers, the text body (HTML converted), the attachment names.",
    inputSchema: {
      type: "object",
      required: ["number"],
      properties: { number: { type: "integer", minimum: 1, description: "The message number from list or search" }, folder: { type: "string" } },
    },
  },
  {
    name: "search",
    description: "Searches a folder by sender, subject text, body text or date; returns numbers to read.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string" },
        from: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        since: { type: "string", description: "Date, e.g. 2026-09-01" },
        unread_only: { type: "boolean" },
        count: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
];

export function emailConfigOf(connection: ToolConnection): EmailConfig {
  return connection.config as unknown as EmailConfig;
}

/** What is missing from an email configuration, or null when it is complete. */
export function validateEmailConfig(config: Partial<EmailConfig>): string | null {
  if (!config.smtpHost) return "an email connection needs smtpHost";
  if (!config.user) return "an email connection needs the mailbox user";
  if (!config.from) return "an email connection needs the from address";
  return null;
}

export interface EmailDeps {
  transport?: (options: TransportOptions & Record<string, unknown>) => Pick<Transporter, "sendMail" | "verify">;
  imap?: (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow;
}

const defaultDeps: Required<EmailDeps> = {
  transport: (options) => nodemailer.createTransport(options as never),
  imap: (options) => new ImapFlow(options),
};

function smtpOptions(config: EmailConfig, password: string) {
  const port = config.smtpPort ?? (config.smtpSecure ? 465 : 587);
  return {
    host: config.smtpHost,
    port,
    secure: config.smtpSecure ?? port === 465,
    auth: { user: config.user, pass: password },
    connectionTimeout: 15_000,
  } as TransportOptions & Record<string, unknown>;
}

function imapOptions(config: EmailConfig, password: string): ConstructorParameters<typeof ImapFlow>[0] {
  const host = config.imapHost ?? config.smtpHost.replace(/^smtp\./, "imap.");
  const port = config.imapPort ?? 993;
  return { host, port, secure: config.imapSecure ?? port === 993, auth: { user: config.user, pass: password }, logger: false, connectionTimeout: 15_000 };
}

/** Both sides answer: SMTP verify and an IMAP login. */
export async function checkEmail(config: EmailConfig, password: string, deps: EmailDeps = {}): Promise<{ ok: boolean; detail: string }> {
  const d = { ...defaultDeps, ...deps };
  const notes: string[] = [];
  try {
    await d.transport(smtpOptions(config, password)).verify();
    notes.push("SMTP ok");
  } catch (error) {
    return { ok: false, detail: `SMTP: ${error instanceof Error ? error.message : String(error)}` };
  }
  const client = d.imap(imapOptions(config, password));
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    notes.push(`IMAP ok, ${box.exists} messages in INBOX`);
  } catch (error) {
    return { ok: false, detail: `${notes.join(", ")}; IMAP: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await client.logout().catch(() => {});
  }
  return { ok: true, detail: notes.join(", ") };
}

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

function fmtDate(d: Date | string | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "";
}

/** Runs one email tool. */
export async function callEmail(
  config: EmailConfig,
  tool: string,
  args: Record<string, unknown>,
  password: string,
  deps: EmailDeps = {},
): Promise<{ content: string; isError: boolean }> {
  const d = { ...defaultDeps, ...deps };
  if (tool === "send") {
    const to = asText(args["to"]).trim();
    const subject = asText(args["subject"]).trim();
    const body = asText(args["body"]);
    if (!to || !subject || !body) return { content: "send needs to, subject and body", isError: true };
    const info = await d.transport(smtpOptions(config, password)).sendMail({
      from: config.from,
      to,
      subject,
      text: body,
      ...(asText(args["cc"]) ? { cc: asText(args["cc"]) } : {}),
      ...(asText(args["bcc"]) ? { bcc: asText(args["bcc"]) } : {}),
      ...(asText(args["reply_to_id"]) ? { inReplyTo: asText(args["reply_to_id"]), references: asText(args["reply_to_id"]) } : {}),
    });
    const id = (info as { messageId?: string }).messageId ?? "";
    return { content: `Sent to ${to}${id ? ` (Message-ID ${id})` : ""}.`, isError: false };
  }
  const folder = asText(args["folder"]) || "INBOX";
  const client = d.imap(imapOptions(config, password));
  await client.connect();
  try {
    await client.mailboxOpen(folder, { readOnly: tool !== "read" });
    if (tool === "list" || tool === "search") {
      const count = typeof args["count"] === "number" ? Math.min(50, args["count"]) : 20;
      const query: Record<string, unknown> = {};
      if (args["unread_only"]) query["seen"] = false;
      if (tool === "search") {
        if (asText(args["from"])) query["from"] = asText(args["from"]);
        if (asText(args["subject"])) query["subject"] = asText(args["subject"]);
        if (asText(args["text"])) query["body"] = asText(args["text"]);
        if (asText(args["since"])) query["since"] = new Date(asText(args["since"]));
      }
      const found = Object.keys(query).length > 0 ? await client.search(query as never, { uid: true }) : null;
      const uids: number[] | null = found === null ? null : Array.isArray(found) ? found : [];
      const sequence = uids === null ? `${Math.max(1, (client.mailbox as { exists: number }).exists - count + 1)}:*` : uids.slice(-count).join(",");
      if (uids !== null && uids.length === 0) return { content: `No messages match in ${folder}.`, isError: false };
      const lines: string[] = [];
      for await (const message of client.fetch(sequence, { envelope: true, flags: true, uid: true }, uids !== null ? { uid: true } : {})) {
        const env = message.envelope;
        const from = env?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") ?? "";
        lines.push(
          `#${message.uid}  ${fmtDate(env?.date as Date | string | undefined)}  ${message.flags?.has("\\Seen") ? "   " : "NEW"}  ${from}  —  ${env?.subject ?? "(no subject)"}`,
        );
      }
      lines.reverse();
      return { content: lines.length > 0 ? `${folder}, newest first (number, date, new, from, subject):\n${lines.join("\n")}` : `${folder} is empty.`, isError: false };
    }
    if (tool === "read") {
      const uid = Number(args["number"]);
      if (!Number.isInteger(uid) || uid < 1) return { content: "read needs the message number", isError: true };
      const message = await client.fetchOne(String(uid), { source: true, envelope: true, flags: true, uid: true }, { uid: true });
      if (!message || !message.source) return { content: `No message #${uid} in ${folder}.`, isError: true };
      const parsed = await simpleParser(message.source);
      const env = message.envelope;
      const from = env?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") ?? "";
      const to = env?.to?.map((a) => a.address).join(", ") ?? "";
      const text = (parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "")).replace(/\r/g, "").trim();
      const attachments = parsed.attachments.map((a) => `${a.filename ?? "file"} (${a.contentType}, ${a.size} bytes)`);
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});
      return {
        content: [
          `From: ${from}`,
          `To: ${to}`,
          `Date: ${fmtDate(env?.date as Date | string | undefined)}`,
          `Subject: ${env?.subject ?? ""}`,
          `Message-ID: ${env?.messageId ?? ""}`,
          attachments.length > 0 ? `Attachments: ${attachments.join("; ")}` : "",
          "",
          text.slice(0, 40_000),
        ]
          .filter((l, i) => l !== "" || i === 6)
          .join("\n"),
        isError: false,
      };
    }
    return { content: `Unknown email tool ${tool}`, isError: true };
  } finally {
    await client.logout().catch(() => {});
  }
}
