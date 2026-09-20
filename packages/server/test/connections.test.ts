import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { signPayload } from "@opifer/connections";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { Channel, InboundMessage, OutboundMessage } from "@opifer/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

/** A channel transport in memory: the test plays the person on Telegram. */
class FakeTransport implements Channel {
  readonly id: string;
  readonly sent: OutboundMessage[] = [];
  handler: ((m: InboundMessage) => Promise<void>) | null = null;
  constructor(id: string) {
    this.id = id;
  }
  async me() {
    return { username: "opifer_test_bot" };
  }
  async start(onMessage: (m: InboundMessage) => Promise<void>) {
    this.handler = onMessage;
  }
  async send(message: OutboundMessage) {
    this.sent.push(message);
  }
  async stop() {
    this.handler = null;
  }
  async say(text: string, chat = "chat-1", sender = "user-1") {
    await this.handler!({ channelId: this.id, externalChatId: chat, externalSenderId: sender, senderName: "Mike", text });
  }
  async tap(actionId: string, chat = "chat-1", sender = "user-1") {
    await this.handler!({ channelId: this.id, externalChatId: chat, externalSenderId: sender, senderName: "Mike", text: "", actionId });
  }
  last() {
    return this.sent.at(-1)!;
  }
}

describe("Connections: webhooks in, signed events out, approvals from Telegram in one tap", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let philip: string;
  let http: Server;
  let port: number;
  const received: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const transports: FakeTransport[] = [];

  const runScheduler = async () => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < 4; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1)!;
      const toolResult = last.content.find((p) => p.type === "tool_result");
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (toolResult && toolResult.type === "tool_result") return { kind: "text", text: `Done: ${toolResult.content.split("\n")[0]}` };
      if (/count|lines/i.test(text)) return { kind: "tools", text: "Counting.", calls: [{ name: "terminal", arguments: { command: "echo 42" } }] };
      return { kind: "text", text: `Philip says: ${text.slice(0, 30)}` };
    });
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-conn-"));
    http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body, headers: req.headers });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    port = (http.address() as { port: number }).port;
    app = await buildApp({
      db,
      mode: "local",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
      work: { scheduler: false },
      learning: { worker: false },
      connections: {
        start: false,
        sandbox: "local",
        transport: (channel) => {
          const t = new FakeTransport(channel.id);
          transports.push(t);
          return t;
        },
      },
    });
    await app.ready();
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Conn Co", mission: "Connect everything" } })).json() as { id: string }).id;
    philip = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Philip", role: "CEO" } })).json() as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    http?.close();
    await app?.close();
    await db?.destroy();
  });

  it("n8n round trip: a webhook creates a task, the agent works it, and the subscriber receives signed events", async () => {
    const sub = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/subscriptions`,
        payload: { name: "n8n", url: `http://127.0.0.1:${port}/n8n`, events: ["task.*", "approval.*"] },
      })
    ).json() as { id: string; secret: string };
    const hook = (
      await app.inject({ method: "POST", url: `/v1/companies/${companyId}/webhooks`, payload: { name: "n8n-tasks", action: "create_task", defaults: { agentId: philip } } })
    ).json() as { id: string; token: string; url: string };
    expect(hook.url).toBe(`/v1/hooks/${hook.id}`);

    // Without the token: refused. With it: a task for Philip.
    expect((await app.inject({ method: "POST", url: hook.url, payload: { title: "Count the lines" } })).statusCode).toBe(401);
    const called = await app.inject({
      method: "POST",
      url: hook.url,
      headers: { authorization: `Bearer ${hook.token}` },
      payload: { title: "Count the lines", description: "Count the lines of the README." },
    });
    expect(called.statusCode).toBe(200);
    const body = called.json() as { ok: boolean; action: string; id: string; status: string };
    expect(body).toMatchObject({ ok: true, action: "create_task", status: "todo" });

    await runScheduler();
    // The terminal needs approval: the event went out signed.
    const [approval] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string }>;
    expect(approval).toBeDefined();
    await app.opifer.events.flush(fetch, new Date(Date.now() + 5000));
    const types = received.filter((r) => r.path === "/n8n").map((r) => r.headers["x-opifer-event"]);
    expect(types).toContain("task.created");
    expect(types).toContain("task.updated");
    expect(types).toContain("approval.requested");
    const one = received.find((r) => r.headers["x-opifer-event"] === "approval.requested")!;
    const signature = one.headers["x-opifer-signature"] as string;
    const timestamp = signature.split(",")[0]!.slice(2);
    expect(signature).toBe(signPayload(sub.secret, one.body, timestamp));
    expect(JSON.parse(one.body)).toMatchObject({ type: "approval.requested", payload: { approvalId: approval!.id } });

    // n8n decides through a second webhook; the task session resumes and delivers.
    const decider = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/webhooks`, payload: { name: "n8n-decide", action: "decide_approval" } })).json() as {
      id: string;
      token: string;
    };
    const decided = await app.inject({
      method: "POST",
      url: `/v1/hooks/${decider.id}`,
      headers: { authorization: `Bearer ${decider.token}` },
      payload: { approvalId: approval!.id, status: "approved" },
    });
    expect(decided.json()).toMatchObject({ ok: true, status: "approved" });
    await runScheduler();
    const task = (await app.inject({ method: "GET", url: `/v1/tasks/${body.id}` })).json() as { status: string };
    expect(["in_review", "done", "todo"]).toContain(task.status);
    await app.opifer.events.flush(fetch, new Date(Date.now() + 5000));
    expect(received.filter((r) => r.path === "/n8n").map((r) => r.headers["x-opifer-event"])).toContain("approval.decided");
  });

  it("Telegram: an unknown sender is paired with a code, then chats with the agent and approves in one tap", async () => {
    await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/secrets`, payload: { name: "TELEGRAM_BOT_TOKEN", value: "123:abc" } });
    const created = await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/channels`,
      payload: { kind: "telegram", name: "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId: philip },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as { id: string; status: string; live: boolean; config: { botUsername?: string } };
    expect(channel.status).toBe("healthy");
    expect(channel.live).toBe(true);
    expect(channel.config.botUsername).toBe("opifer_test_bot");
    const t = transports.find((x) => x.id === channel.id)!;

    // Unknown sender: a pairing code, nothing else.
    await t.say("hello?");
    expect(t.last().text).toMatch(/enter the code \*\*\d{6}\*\*/);
    const code = /\*\*(\d{6})\*\*/.exec(t.last().text)![1]!;
    const bindings = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/channel-bindings` })).json() as Array<{
      id: string;
      userId: string | null;
      pairingCode: string | null;
    }>;
    expect(bindings[0]!.userId).toBeNull();
    // A wrong code is refused; the right one links the chat to the owner.
    expect((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/channel-bindings/pair`, payload: { code: "000000" } })).statusCode).toBe(404);
    const paired = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/channel-bindings/pair`, payload: { code } })).json() as { userId: string | null };
    expect(paired.userId).not.toBeNull();

    // A message becomes a turn with the default agent; the answer comes back.
    await t.say("Hi Philip, how are things?");
    expect(t.last().text).toContain("Philip says: Hi Philip");
    // A tool that needs approval: the buttons arrive in the chat; one tap decides and the session resumes.
    await t.say("Please count the lines of the README");
    expect(t.last().text).toContain("Philip needs your approval");
    expect(t.last().actions?.map((a) => a.label)).toEqual(["Approve", "Deny"]);
    const approveId = t.last().actions![0]!.id;
    await t.tap(approveId);
    expect(t.last().text).toMatch(/^Approved/);
    // The session resumed in the background: wait for the answer through the session.
    const sessions = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/sessions?agentId=${philip}` })).json() as Array<{ id: string; title: string | null }>;
    const chat = sessions.find((s) => s.title?.startsWith("Telegram"))!;
    let messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];
    const answered = () => messages.some((m) => m.role === "assistant" && m.content.some((p) => p.type === "text" && p.text?.startsWith("Done: 42")));
    for (let i = 0; i < 50 && !answered(); i++) {
      await new Promise((r) => setTimeout(r, 100));
      messages = (await app.inject({ method: "GET", url: `/v1/sessions/${chat.id}/messages` })).json() as typeof messages;
    }
    expect(answered()).toBe(true);

    // Control commands.
    await t.say("/status");
    expect(t.sent.some((m) => /1 agents \(Philip\)/.test(m.text))).toBe(true);
    await t.say("/agent Nobody");
    expect(t.last().text).toContain("No agent named");
    await t.say("/notify off");
    expect(t.last().text).toContain("off");
    // A second, unknown sender in another chat is refused with its own code, never routed to an agent.
    await t.say("hello", "chat-2", "user-2");
    expect(t.last().text).toContain("not linked to a person yet");
  });

  it("a paired chat is told about work that needs a person, with buttons for approvals", async () => {
    const t = transports.at(-1)!;
    await app.inject({ method: "POST", url: `/v1/companies/${companyId}/channel-bindings/pair`, payload: { code: "000000" } }); // no-op
    const bindings = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/channel-bindings` })).json() as Array<{ id: string; userId: string | null }>;
    const mine = bindings.find((b) => b.userId)!;
    await app.inject({ method: "PATCH", url: `/v1/companies/${companyId}/channel-bindings/${mine.id}`, payload: { notify: true } });
    const before = t.sent.length;
    // A task delivered for review → a notification.
    const task = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "Write the FAQ", assigneeAgentId: philip } })).json() as {
      id: string;
    };
    await app.inject({ method: "POST", url: `/v1/tasks/${task.id}/block`, payload: { reason: "need the FAQ source" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.sent.slice(before).some((m) => m.text.includes("is blocked") && m.text.includes("Write the FAQ"))).toBe(true);
    // A skill promotion proposed from the interface → buttons in the chat.
    await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/skills`,
      payload: { scope: "agent", scopeAgentId: philip, name: "write-faq", description: "Write an FAQ", content: "steps" },
    });
    const skills = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/skills?agent=${philip}` })).json() as Array<{ id: string; name: string }>;
    await app.inject({ method: "POST", url: `/v1/companies/${companyId}/skills/${skills.find((s) => s.name === "write-faq")!.id}/promote`, payload: { toScope: "company" } });
    await new Promise((r) => setTimeout(r, 200));
    const promo = t.sent.slice(before).find((m) => m.text.includes("write-faq"))!;
    expect(promo.actions?.map((a) => a.label)).toEqual(["Approve", "Deny"]);
    await t.tap(promo.actions![0]!.id);
    expect(t.last().text).toContain("promotion applied");
    expect(
      ((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/skills?scope=company` })).json() as Array<{ name: string }>).some((s) => s.name === "write-faq"),
    ).toBe(true);
  });

  it("health reports the sandbox in use", async () => {
    const health = (await app.inject({ method: "GET", url: "/v1/health" })).json() as { sandbox: { kind: string } };
    expect(health.sandbox.kind).toBe("local");
  });
});
