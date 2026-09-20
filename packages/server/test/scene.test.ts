/**
 * Scene 16.1 — the story the MVP must hold, end to end, through the API the
 * interface uses and with a scripted model:
 *
 *  1. init: a company, two agents in the org chart, a goal.
 *  2. An agent takes a task, works in the sandbox and uses an MCP tool.
 *  3. A risky action opens an approval; the operator approves from Telegram.
 *  4. The task's budget runs out: the agent stops before the next call and asks.
 *  5. When the work is done the background review saves a skill.
 *  6. "The next day" a routine repeats the work: the skill is used, cost drops.
 *  7. An n8n workflow creates a task via webhook and receives the events.
 *  8. Every step is in the audit and in the costs view.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { REVIEW_PROMPT } from "@opifer/learning";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { Channel, InboundMessage, OutboundMessage } from "@opifer/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

class FakeTelegram implements Channel {
  readonly sent: OutboundMessage[] = [];
  handler: ((m: InboundMessage) => Promise<void>) | null = null;
  constructor(readonly id: string) {}
  async me() {
    return { username: "opifer_scene_bot" };
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
  say(text: string) {
    return this.handler!({ channelId: this.id, externalChatId: "chat-1", externalSenderId: "mike", senderName: "Mike", text });
  }
  tap(actionId: string) {
    return this.handler!({ channelId: this.id, externalChatId: "chat-1", externalSenderId: "mike", senderName: "Mike", text: "", actionId });
  }
  last() {
    return this.sent.at(-1)!;
  }
}

const ECHO_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "connections", "test", "fixtures", "mcp-echo-server.mjs");

describe("Scene 16.1: the story the MVP holds", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let http: Server;
  let port: number;
  let companyId: string;
  let philip: string;
  let dev: string;
  let telegram: FakeTelegram | null = null;
  let modelCalls = 0;
  const received: Array<{ event: string; signature: string; body: string }> = [];

  const runScheduler = async (rounds = 6) => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < rounds; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };
  const until = async (check: () => boolean, ms = 5000) => {
    const started = Date.now();
    while (!check() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 50));
    return check();
  };
  const pendingApprovals = async () =>
    (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/approvals?status=pending` })).json() as Array<{ id: string; kind: string; agentId: string }>;
  const task = async (id: string) =>
    (await app.inject({ method: "GET", url: `/v1/tasks/${id}` })).json() as { id: string; status: string; result: { summary: string } | null; cost: { eur: number } };

  beforeAll(async () => {
    db = await createTestDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-scene-"));
    const workdir = path.join(dir, "repo");
    await mkdir(path.join(workdir, "build"), { recursive: true });
    await writeFile(path.join(workdir, "CHANGELOG.md"), "## 1.0\n- first release\n");
    await writeFile(path.join(workdir, "build", "old.js"), "old");

    // The scripted model: a small worker that follows its task text.
    const provider = new FakeProvider((request) => {
      modelCalls++;
      if (request.system === REVIEW_PROMPT)
        return {
          kind: "text",
          text: JSON.stringify({
            memories: [{ kind: "note", content: "Release notes are written from CHANGELOG.md." }],
            skill: {
              name: "release-notes",
              description: "Write the release notes from the changelog",
              content: "1. Read CHANGELOG.md.\n2. Write three lines.\n3. Deliver with task_deliver.",
            },
            retire: [],
            reason: "the job repeats",
          }),
        };
      const last = request.messages.at(-1)!;
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      const results = request.messages.flatMap((m) => m.content.filter((p) => p.type === "tool_result"));
      const step = results.length;
      const toolResult = last.content.find((p) => p.type === "tool_result");
      const job = request.messages.map((m) => m.content.map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.content : "")).join("\n")).join("\n");
      const deliver = (summary: string) => ({ kind: "tools" as const, calls: [{ name: "task_deliver", arguments: { summary, verification: "see the tool results" } }] });
      if (text.startsWith("You have been assigned") || text.startsWith("The subtask")) return { kind: "tools", calls: [{ name: "task_status", arguments: {} }] };
      if (/Ask the echo tool/.test(job)) {
        if (step === 1) return { kind: "tools", calls: [{ name: "echo__echo", arguments: { text: "ready" } }] };
        return deliver(`Echo answered: ${toolResult && toolResult.type === "tool_result" ? toolResult.content.slice(0, 40) : "?"}`);
      }
      if (/Clean the build folder/.test(job)) {
        if (step === 1) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "rm -r build && echo cleaned" } }] };
        return deliver("Build folder removed");
      }
      if (/Write the release notes|release-notes/.test(job)) {
        const knowsSkill = request.system.includes("- release-notes:");
        if (knowsSkill) {
          if (step === 1) return { kind: "tools", calls: [{ name: "skill_load", arguments: { name: "release-notes" } }] };
          if (step === 2) return { kind: "tools", calls: [{ name: "read_file", arguments: { path: "CHANGELOG.md" } }] };
          return deliver("Release notes: 1.0 — first release (with the skill)");
        }
        if (step === 1) return { kind: "tools", calls: [{ name: "list_files", arguments: { path: "." } }] };
        if (step === 2) return { kind: "tools", calls: [{ name: "search_files", arguments: { pattern: "release", path: "." } }] };
        if (step === 3) return { kind: "tools", calls: [{ name: "read_file", arguments: { path: "CHANGELOG.md" } }] };
        if (step === 4) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "wc -l CHANGELOG.md" } }] };
        return deliver("Release notes: 1.0 — first release");
      }
      if (/Count the words/.test(job)) {
        if (step === 1) return { kind: "tools", calls: [{ name: "terminal", arguments: { command: "wc -w CHANGELOG.md" } }] };
        return deliver("CHANGELOG.md has 4 words");
      }
      return { kind: "text", text: `Philip: ${text.slice(0, 40)}` };
    });

    http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ event: String(req.headers["x-opifer-event"] ?? ""), signature: String(req.headers["x-opifer-signature"] ?? ""), body });
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
      connections: { start: false, sandbox: "local", transport: (channel) => (telegram = new FakeTelegram(channel.id)) },
    });
    app.opifer.governance!.prices.set("fake/echo", { inputPerMillion: 3, outputPerMillion: 15, currency: "USD" });
    await app.ready();

    // 1. init: the company, two agents in the org chart, a goal and a project whose folder is the repository.
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Scene Co", mission: "Ship the site" } })).json() as { id: string }).id;
    philip = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Philip", role: "CEO" } })).json() as { id: string }).id;
    dev = (
      (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Dev", role: "Developer", reportsToAgentId: philip } })).json() as {
        id: string;
      }
    ).id;
    const goal = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/goals`, payload: { title: "Release 1.0", measure: "notes published" } })).json() as {
      id: string;
    };
    const project = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/projects`, payload: { name: "Site", goalId: goal.id, workdir } })).json() as {
      id: string;
    };
    (globalThis as { sceneProject?: string }).sceneProject = project.id;
    // Dev runs ordinary commands alone; dangerous ones (rm -r, sudo, force push…) always ask, whatever the policy.
    await app.inject({
      method: "PUT",
      url: `/v1/companies/${companyId}/tool-policies`,
      payload: { targetKind: "agent", targetId: dev, toolName: "terminal", permission: "automatic" },
    });
  }, 120_000);

  afterAll(async () => {
    http?.close();
    await app?.close();
    await db?.destroy();
  });

  it("2. an agent takes a task, works in the sandbox and uses an MCP tool", async () => {
    const health = (await app.inject({ method: "GET", url: "/v1/health" })).json() as { sandbox: { kind: string } };
    expect(["docker", "local"]).toContain(health.sandbox.kind);
    const conn = await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/connections`,
      payload: { kind: "mcp_stdio", name: "echo", description: "An echo service", config: { command: process.execPath, args: [ECHO_SERVER] }, risk: "low" },
    });
    expect(conn.statusCode).toBe(201);
    expect((conn.json() as { status: string; tools: unknown[] }).status).toBe("healthy");
    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/tasks`,
        payload: {
          title: "Ask the echo tool to say ready",
          description: "Ask the echo tool to echo the word ready and deliver what it answered.",
          assigneeAgentId: dev,
          projectId: (globalThis as { sceneProject?: string }).sceneProject,
        },
      })
    ).json() as { id: string };
    await runScheduler();
    const done = await task(created.id);
    expect(done.status).toBe("in_review");
    expect(done.result?.summary).toContain("ready");
    expect(done.cost.eur).toBeGreaterThan(0);
    expect(
      (await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/complete`, payload: { summary: "Verified: the echo tool answered", verification: "read it" } })).statusCode,
    ).toBe(200);
  });

  it("3. a risky action opens an approval; the operator approves from Telegram in one tap", async () => {
    await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/secrets`, payload: { name: "TELEGRAM_BOT_TOKEN", value: "123:abc" } });
    const channel = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/channels`,
        payload: { kind: "telegram", name: "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId: philip },
      })
    ).json() as { id: string; status: string };
    expect(channel.status).toBe("healthy");
    await telegram!.say("hello");
    const code = /\*\*(\d{6})\*\*/.exec(telegram!.last().text)![1]!;
    expect((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/channel-bindings/pair`, payload: { code } })).statusCode).toBe(200);

    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/tasks`,
        payload: {
          title: "Clean the build folder",
          description: "Clean the build folder of the repository, then say what you removed.",
          assigneeAgentId: dev,
          projectId: (globalThis as { sceneProject?: string }).sceneProject,
        },
      })
    ).json() as { id: string };
    await runScheduler();
    const [approval] = await pendingApprovals();
    expect(approval.agentId).toBe(dev);
    expect(["dangerous_command", "tool_use"]).toContain(approval.kind);
    // The phone got the request with two buttons; one tap approves, the scheduler resumes the task.
    const arrived = await until(() => telegram!.sent.some((m) => /needs your approval|wants to run a risky command/.test(m.text) && m.actions?.length === 2));
    expect(arrived).toBe(true);
    const notice = telegram!.sent.find((m) => /needs your approval|wants to run a risky command/.test(m.text) && m.actions?.length === 2)!;
    await telegram!.tap(notice.actions![0]!.id);
    expect(telegram!.last().text).toMatch(/^Approved/);
    await runScheduler();
    const done = await task(created.id);
    expect(done.status).toBe("in_review");
    expect(done.result?.summary).toContain("Build folder removed");
    await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/complete`, payload: { summary: "Verified: build folder gone", verification: "ls" } });
  });

  it("4. the task's budget runs out: the agent stops before the next call and asks for a decision", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/tasks`,
        payload: {
          title: "Count the words",
          description: "Count the words of CHANGELOG.md and deliver the number.",
          assigneeAgentId: dev,
          projectId: (globalThis as { sceneProject?: string }).sceneProject,
        },
      })
    ).json() as { id: string };
    // A cap on this task that one call already exceeds.
    await app.inject({ method: "PUT", url: `/v1/companies/${companyId}/budgets`, payload: { scopeKind: "task", scopeId: created.id, cap: 0.00001 } });
    const before = modelCalls;
    await runScheduler();
    const agents = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/agents` })).json() as Array<{ id: string; status: string }>;
    expect(agents.find((a) => a.id === dev)?.status).toBe("budget_stopped");
    const [approval] = await pendingApprovals();
    expect(approval.kind).toBe("budget_increase");
    // At most one call slipped through before the stop (the reservation is refused before the next one).
    expect(modelCalls - before).toBeLessThanOrEqual(2);
    // The person raises the cap: the agent resumes exactly where it stopped and delivers.
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${approval.id}/decide`, payload: { status: "approved", newCap: 1 } })).statusCode).toBe(200);
    await runScheduler();
    const done = await task(created.id);
    expect(done.status).toBe("in_review");
    expect(done.result?.summary).toContain("4 words");
    await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/complete`, payload: { summary: "Verified: four words", verification: "wc" } });
    await app.inject({
      method: "DELETE",
      url: `/v1/companies/${companyId}/budgets/${((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/budgets` })).json() as Array<{ id: string; scopeKind: string }>).find((p) => p.scopeKind === "task")!.id}`,
    });
  });

  let firstRunCalls = 0;
  let firstRunTokens = 0;

  it("5. when the work is done the background review saves a skill", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/tasks`,
        payload: {
          title: "Write the release notes",
          description: "Write the release notes of 1.0 from the changelog.",
          assigneeAgentId: dev,
          projectId: (globalThis as { sceneProject?: string }).sceneProject,
        },
      })
    ).json() as { id: string };
    const before = modelCalls;
    await runScheduler();
    firstRunCalls = modelCalls - before;
    const done = await task(created.id);
    expect(done.status).toBe("in_review");
    const detail = (await app.inject({ method: "GET", url: `/v1/tasks/${created.id}` })).json() as { sessions: Array<{ id: string }> };
    const runs = (await app.inject({ method: "GET", url: `/v1/sessions/${detail.sessions[0]!.id}/runs` })).json() as Array<{ inputTokens: number; outputTokens: number }>;
    firstRunTokens = runs.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    await app.inject({ method: "POST", url: `/v1/tasks/${created.id}/complete`, payload: { summary: "Verified: notes match the changelog", verification: "read them" } });
    // The review runs in the background (here: on demand), on a copy of the conversation.
    const review = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/learning/reviews/run` });
    expect(review.statusCode).toBe(200);
    const skills = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/skills?agent=${dev}` })).json() as Array<{ name: string; origin: string }>;
    expect(skills.find((s) => s.name === "release-notes")?.origin).toBe("agent");
  });

  it("6. the next day a routine repeats the work: the skill is used, calls and tokens drop measurably", async () => {
    const routine = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/routines`,
        payload: {
          agentId: dev,
          name: "Release notes",
          prompt: "Write the release notes of 1.0 from the changelog.",
          scheduleKind: "cron",
          schedule: "0 9 * * *",
          timezone: "Europe/Rome",
          mode: "task",
          skills: ["release-notes"],
        },
      })
    ).json() as { id: string };
    await app.inject({ method: "POST", url: `/v1/companies/${companyId}/routines/${routine.id}/run` });
    const before = modelCalls;
    await runScheduler();
    const secondRunCalls = modelCalls - before;
    const [run] = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{ status: string; taskId: string }>;
    expect(run!.status).toBe("running");
    const repeated = await task(run!.taskId);
    expect(repeated.status).toBe("in_review");
    expect(repeated.result?.summary).toContain("with the skill");
    const detail = (await app.inject({ method: "GET", url: `/v1/tasks/${run!.taskId}` })).json() as { sessions: Array<{ id: string }> };
    const runs = (await app.inject({ method: "GET", url: `/v1/sessions/${detail.sessions[0]!.id}/runs` })).json() as Array<{ inputTokens: number; outputTokens: number }>;
    const secondRunTokens = runs.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    expect(secondRunCalls).toBeLessThan(firstRunCalls);
    expect(secondRunTokens).toBeLessThan(firstRunTokens * 0.75);
    const skill = ((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/skills?agent=${dev}` })).json() as Array<{ name: string; uses: number }>).find(
      (s) => s.name === "release-notes",
    );
    expect(skill?.uses).toBeGreaterThanOrEqual(1);
    await app.inject({ method: "POST", url: `/v1/tasks/${run!.taskId}/complete`, payload: { summary: "Verified again", verification: "read" } });
    expect(((await app.inject({ method: "GET", url: `/v1/companies/${companyId}/routines/${routine.id}/runs` })).json() as Array<{ status: string }>)[0]!.status).toBe("done");
  });

  it("7. an n8n workflow creates a task via webhook and receives the completion event, signed", async () => {
    const sub = (
      await app.inject({ method: "POST", url: `/v1/companies/${companyId}/subscriptions`, payload: { name: "n8n", url: `http://127.0.0.1:${port}/opifer`, events: ["task.*"] } })
    ).json() as { secret: string };
    const hook = (
      await app.inject({ method: "POST", url: `/v1/companies/${companyId}/webhooks`, payload: { name: "n8n", action: "create_task", defaults: { agentId: dev } } })
    ).json() as { id: string; token: string };
    const call = await app.inject({
      method: "POST",
      url: `/v1/hooks/${hook.id}`,
      headers: { authorization: `Bearer ${hook.token}` },
      payload: {
        title: "Count the words",
        description: "Count the words of CHANGELOG.md and deliver the number.",
        projectId: (globalThis as { sceneProject?: string }).sceneProject,
      },
    });
    expect(call.statusCode).toBe(200);
    const { id } = call.json() as { id: string };
    await runScheduler();
    expect((await task(id)).status).toBe("in_review");
    await app.inject({ method: "POST", url: `/v1/tasks/${id}/complete`, payload: { summary: "Verified", verification: "wc" } });
    await new Promise((r) => setTimeout(r, 200));
    await app.opifer.events.flush(fetch, new Date(Date.now() + 5000));
    const doneEvent = received.find((r) => r.event === "task.updated" && r.body.includes(id) && r.body.includes('"done"'));
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(sub.secret.startsWith("whsec_")).toBe(true);
  });

  it("8. every step is in the audit and in the costs view", async () => {
    const audit = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/audit?limit=500` })).json() as Array<{ action: string }>;
    const actions = new Set(audit.map((a) => a.action));
    for (const expected of [
      "company.created",
      "agent.created",
      "task.created",
      "task.checked_out",
      "tool.executed",
      "approval.requested",
      "approval.decided",
      "budget.blocked",
      "task.review_requested",
      "task.done",
      "skill.created",
      "routine.created",
      "routine.triggered",
      "connection.created",
      "webhook.created",
      "channel.paired",
    ])
      expect(actions, expected).toContain(expected);
    const costs = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/costs` })).json() as {
      total: { eur: number };
      byAgent: Array<{ agentName: string | null; eur: number }>;
    };
    expect(costs.total.eur).toBeGreaterThan(0);
    expect(costs.byAgent.find((a) => a.agentName === "Dev")!.eur).toBeGreaterThan(0);
  });
});
