import { describe, expect, it } from "vitest";
import { EMAIL_TOOLS, EMAIL_TOOL_RISK, callEmail, checkEmail, validateEmailConfig, type EmailConfig, type EmailDeps } from "../src/email.js";

const config: EmailConfig = { smtpHost: "smtp.example.com", smtpPort: 587, imapHost: "imap.example.com", user: "agents@example.com", from: "Opifer <agents@example.com>" };

/** A mailbox in memory that answers like ImapFlow for the calls the tools make. */
function fakeImap(messages: Array<{ uid: number; from: string; subject: string; date: string; seen?: boolean; source: string }>) {
  const flags = new Map(messages.map((m) => [m.uid, new Set(m.seen ? ["\\Seen"] : [])]));
  const opened: string[] = [];
  const client = {
    mailbox: { exists: messages.length },
    async connect() {},
    async logout() {},
    async mailboxOpen(name: string) {
      opened.push(name);
      return { exists: messages.length };
    },
    async search(query: Record<string, unknown>) {
      return messages
        .filter((m) => (query["from"] ? m.from.includes(String(query["from"])) : true))
        .filter((m) => (query["subject"] ? m.subject.includes(String(query["subject"])) : true))
        .filter((m) => (query["seen"] === false ? !flags.get(m.uid)!.has("\\Seen") : true))
        .map((m) => m.uid);
    },
    async *fetch(range: string, _fields: unknown, options?: { uid?: boolean }) {
      const wanted = options?.uid ? range.split(",").map(Number) : messages.slice(Number(range.split(":")[0]) - 1).map((m) => m.uid);
      for (const m of messages.filter((x) => wanted.includes(x.uid))) {
        yield { uid: m.uid, flags: flags.get(m.uid), envelope: { from: [{ name: "", address: m.from }], subject: m.subject, date: new Date(m.date), messageId: `<${m.uid}@x>` } };
      }
    },
    async fetchOne(uid: string) {
      const m = messages.find((x) => x.uid === Number(uid));
      return m
        ? {
            uid: m.uid,
            source: Buffer.from(m.source),
            flags: flags.get(m.uid),
            envelope: { from: [{ name: "", address: m.from }], to: [{ address: "agents@example.com" }], subject: m.subject, date: new Date(m.date), messageId: `<${m.uid}@x>` },
          }
        : null;
    },
    async messageFlagsAdd(uid: string, add: string[]) {
      for (const f of add) flags.get(Number(uid))?.add(f);
      return true;
    },
  };
  return { client: client as never, opened, flags };
}

describe("email connection", () => {
  it("exposes four tools with sending as the only high-risk one, and validates the configuration", () => {
    expect(EMAIL_TOOLS.map((t) => t.name)).toEqual(["send", "list", "read", "search"]);
    expect(EMAIL_TOOL_RISK).toEqual({ send: "high", list: "low", read: "low", search: "low" });
    expect(validateEmailConfig({})).toContain("smtpHost");
    expect(validateEmailConfig({ smtpHost: "s", user: "u" })).toContain("from");
    expect(validateEmailConfig(config)).toBeNull();
  });

  it("sends through SMTP with the mailbox identity and reports the message id", async () => {
    const sent: unknown[] = [];
    const deps: EmailDeps = { transport: () => ({ sendMail: async (m: unknown) => (sent.push(m), { messageId: "<abc@x>" }) as never, verify: async () => true }) as never };
    const out = await callEmail(config, "send", { to: "someone@example.org", subject: "Hi", body: "Hello there", cc: "boss@example.org", reply_to_id: "<prev@x>" }, "pw", deps);
    expect(out).toEqual({ content: "Sent to someone@example.org (Message-ID <abc@x>).", isError: false });
    expect(sent[0]).toMatchObject({ from: config.from, to: "someone@example.org", subject: "Hi", text: "Hello there", cc: "boss@example.org", inReplyTo: "<prev@x>" });
    expect((await callEmail(config, "send", { to: "x" }, "pw", deps)).isError).toBe(true);
  });

  it("lists, searches and reads a mailbox, marking a read message as seen", async () => {
    const box = fakeImap([
      {
        uid: 1,
        from: "alice@example.org",
        subject: "Invoice",
        date: "2026-09-01T10:00:00Z",
        seen: true,
        source: "From: alice@example.org\r\nSubject: Invoice\r\n\r\nPlease pay.\r\n",
      },
      {
        uid: 2,
        from: "bob@example.org",
        subject: "Hello",
        date: "2026-09-02T10:00:00Z",
        source: "From: bob@example.org\r\nSubject: Hello\r\nContent-Type: text/html\r\n\r\n<p>Hi <b>there</b></p>\r\n",
      },
    ]);
    const deps: EmailDeps = { imap: () => box.client };
    const list = await callEmail(config, "list", {}, "pw", deps);
    expect(list.content).toContain("#2");
    expect(list.content).toContain("NEW");
    expect(list.content.indexOf("#2")).toBeLessThan(list.content.indexOf("#1"));
    const unread = await callEmail(config, "list", { unread_only: true }, "pw", deps);
    expect(unread.content).toContain("#2");
    expect(unread.content).not.toContain("#1");
    const search = await callEmail(config, "search", { from: "alice" }, "pw", deps);
    expect(search.content).toContain("Invoice");
    expect(search.content).not.toContain("Hello");
    const read = await callEmail(config, "read", { number: 2 }, "pw", deps);
    expect(read.content).toContain("From: bob@example.org");
    expect(read.content).toContain("Hi there");
    expect(box.flags.get(2)!.has("\\Seen")).toBe(true);
    expect((await callEmail(config, "read", { number: 9 }, "pw", deps)).isError).toBe(true);
    expect(box.opened).toContain("INBOX");
  });

  it("checks both sides and says which one failed", async () => {
    const good: EmailDeps = { transport: () => ({ verify: async () => true, sendMail: async () => ({}) }) as never, imap: () => fakeImap([]).client };
    expect(await checkEmail(config, "pw", good)).toEqual({ ok: true, detail: "SMTP ok, IMAP ok, 0 messages in INBOX" });
    const badSmtp: EmailDeps = {
      transport: () =>
        ({
          verify: async () => {
            throw new Error("535 bad credentials");
          },
          sendMail: async () => ({}),
        }) as never,
    };
    expect((await checkEmail(config, "pw", badSmtp)).detail).toContain("SMTP: 535");
  });
});
