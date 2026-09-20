import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { DockerEnvironment, NATIVE_TOOLS, NativeToolExecutor } from "@opifer/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService, ConnectionError, ConnectionService, ConnectionToolExecutor, EventService, WebhookService, signPayload } from "../src/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");
const person = { kind: "person" as const };

describe("tool connections: MCP servers and workflow tools behind one executor", () => {
  let db: TestDatabase;
  let companyId: string;
  let agentId: string;
  let http: Server;
  let port: number;
  const received: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const secrets: Record<string, string> = { ECHO_API_KEY: "abcd1234", N8N_TOKEN: "tok-42" };
  let connections: ConnectionService;

  beforeAll(async () => {
    db = await createTestDatabase();
    const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Conn Co') RETURNING id`;
    const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Dev', 'Developer') RETURNING id`;
    companyId = company!.id;
    agentId = agent!.id;
    connections = new ConnectionService(db.sql, async (_c, name) => secrets[name] ?? null);
    http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body, headers: req.headers });
        if (req.url?.startsWith("/workflow")) {
          if (req.headers["authorization"] !== "Bearer tok-42") {
            res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "no" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, summary: `n8n did: ${JSON.parse(body || "{}").what ?? "?"}` }));
        } else if (req.url?.startsWith("/events")) {
          res.writeHead(req.url.includes("fail") ? 500 : 200).end("ok");
        } else res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    port = (http.address() as { port: number }).port;
  }, 120_000);

  afterAll(async () => {
    http?.close();
    await db?.destroy();
  });

  it("an MCP stdio server is checked, its tools discovered, and called with the secret in its environment", async () => {
    const c = await connections.create(
      { companyId, kind: "mcp_stdio", name: "echo", config: { command: process.execPath, args: [FIXTURE] }, secretNames: ["ECHO_API_KEY"], risk: "low" },
      person,
    );
    expect(c.status).toBe("unknown");
    const checked = await connections.check(companyId, c.id);
    expect(checked.status).toBe("healthy");
    expect(checked.tools.map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
    const defs = await connections.definitionsFor(companyId);
    expect(defs.map((d) => d.name)).toEqual(["echo__echo", "echo__whoami"]);
    expect(defs[0]!.risk).toBe("low");
    expect(await connections.call(companyId, "echo__echo", { text: "hi" })).toEqual({ content: "echo: hi", isError: false });
    expect((await connections.call(companyId, "echo__whoami", {})).content).toBe("key abcd…");
  });

  it("a missing secret marks the connection and refuses the call without guessing", async () => {
    const c = await connections.create(
      { companyId, kind: "mcp_stdio", name: "locked", config: { command: process.execPath, args: [FIXTURE] }, secretNames: ["MISSING_KEY"] },
      person,
    );
    expect((await connections.check(companyId, c.id)).status).toBe("missing_secret");
    const result = await connections.call(companyId, "locked__echo", { text: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("MISSING_KEY");
    expect((await connections.definitionsFor(companyId)).some((d) => d.name.startsWith("locked__"))).toBe(false);
  });

  it("a workflow (n8n-style) endpoint is a tool with its own schema, signed with a secret header", async () => {
    const c = await connections.create(
      {
        companyId,
        kind: "workflow",
        name: "n8n_report",
        description: "Sends the numbers to the reporting workflow",
        config: {
          url: `http://127.0.0.1:${port}/workflow`,
          headers: { authorization: "Bearer ${N8N_TOKEN}" },
          inputSchema: { type: "object", required: ["what"], properties: { what: { type: "string" } } },
          resultField: "summary",
        },
        secretNames: ["N8N_TOKEN"],
        risk: "medium",
      },
      person,
    );
    expect(c.tools).toEqual([
      { name: "run", description: "Sends the numbers to the reporting workflow", inputSchema: { type: "object", required: ["what"], properties: { what: { type: "string" } } } },
    ]);
    const result = await connections.call(companyId, "n8n_report__run", { what: "monthly numbers" });
    expect(result).toEqual({ content: "n8n did: monthly numbers", isError: false });
    expect(received.at(-1)!.headers["authorization"]).toBe("Bearer tok-42");
    expect((await connections.get(companyId, c.id))?.status).toBe("healthy");
  });

  it("the composed executor lists native and connection tools per company and routes calls", async () => {
    const executor = new ConnectionToolExecutor(new NativeToolExecutor(NATIVE_TOOLS), connections, 0);
    const defs = await executor.definitionsFor({ companyId, agentId });
    expect(defs.map((d) => d.name)).toContain("terminal");
    expect(defs.map((d) => d.name)).toContain("echo__echo");
    expect(defs.map((d) => d.name)).toContain("n8n_report__run");
    expect(executor.riskOf("echo__echo")).toBe("low");
    expect(executor.riskOf("n8n_report__run")).toBe("medium");
    expect(executor.riskOf("terminal")).toBe("high");
    const ctx = { sessionId: "s", companyId, agentId, runId: "r", callId: "c", agentRole: "dev", workdir: tmpdir(), signal: new AbortController().signal };
    expect((await executor.execute("echo__echo", { text: "via executor" }, ctx)).content).toBe("echo: via executor");
    const [other] = await db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Other Co') RETURNING id`;
    expect((await executor.definitionsFor({ companyId: other!.id, agentId })).some((d) => d.name.includes("__"))).toBe(false);
    await expect(connections.create({ companyId, kind: "mcp_stdio", name: "Bad Name", config: { command: "x" } }, person)).rejects.toBeInstanceOf(ConnectionError);
  });

  it("inbound webhooks: bearer token, actions, hashed storage, rotation", async () => {
    const webhooks = new WebhookService(db.sql);
    const { webhook, token } = await webhooks.create({ companyId, name: "n8n-tasks", action: "create_task", defaults: { agentId, priority: "high" } }, person);
    expect(token.startsWith("opw_")).toBe(true);
    const [row] = await db.sql<{ token_hash: string }[]>`SELECT token_hash FROM webhooks WHERE id = ${webhook.id}`;
    expect(row!.token_hash).not.toContain(token);
    expect(await webhooks.authenticate(webhook.id, "wrong")).toBeNull();
    expect(await webhooks.authenticate(webhook.id, null)).toBeNull();
    const authed = await webhooks.authenticate(webhook.id, token);
    expect(authed?.id).toBe(webhook.id);
    const calls: unknown[] = [];
    const handlers = {
      createTask: async (c: string, input: Record<string, unknown>) => {
        calls.push({ c, input });
        return { id: "t1", status: "todo" };
      },
      wakeAgent: async () => ({ sessionId: "s" }),
      comment: async () => ({ id: "c" }),
      decideApproval: async () => ({ id: "a", status: "approved" }),
    };
    const result = await webhooks.handle(authed!, { title: "From n8n", description: "do it" }, handlers);
    expect(result).toEqual({ id: "t1", status: "todo" });
    expect(calls[0]).toMatchObject({ c: companyId, input: { title: "From n8n", assigneeAgentId: agentId, priority: "high" } });
    await expect(webhooks.handle(authed!, {}, handlers)).rejects.toBeInstanceOf(ConnectionError);
    expect((await webhooks.get(companyId, webhook.id))?.calls).toBe(1);
    const rotated = await webhooks.rotate(companyId, webhook.id, person);
    expect(await webhooks.authenticate(webhook.id, token)).toBeNull();
    expect(await webhooks.authenticate(webhook.id, rotated.token)).not.toBeNull();
    await webhooks.update(companyId, webhook.id, { enabled: false }, person);
    expect(await webhooks.authenticate(webhook.id, rotated.token)).toBeNull();
  });

  it("outbound events: filtered, signed, retried with backoff, failed after the last attempt", async () => {
    const events = new EventService(db.sql);
    const sub = await events.create({ companyId, name: "n8n-listener", url: `http://127.0.0.1:${port}/events`, events: ["task.*", "approval.requested"] }, person);
    const broken = await events.create({ companyId, name: "broken", url: `http://127.0.0.1:${port}/events-fail`, events: ["*"] }, person);
    const now = new Date();
    expect(await events.enqueue({ type: "task.updated", companyId, occurredAt: now.toISOString(), payload: { taskId: "t1", status: "done" } })).toBe(2);
    expect(await events.enqueue({ type: "session.event", companyId, occurredAt: now.toISOString(), payload: {} })).toBe(0);
    expect(await events.enqueue({ type: "memory.saved", companyId, occurredAt: now.toISOString(), payload: {} })).toBe(1);
    const first = await events.flush(fetch, new Date(now.getTime() + 2000));
    expect(first.delivered).toBe(1);
    const call = received.find((r) => r.path === "/events")!;
    const signature = call.headers["x-opifer-signature"] as string;
    const timestamp = signature.split(",")[0]!.slice(2);
    expect(signature).toBe(signPayload(sub.secret, call.body, timestamp));
    expect(signature).toBe(`t=${timestamp},v1=${createHmac("sha256", sub.secret).update(`${timestamp}.${call.body}`).digest("hex")}`);
    expect(JSON.parse(call.body)).toMatchObject({ type: "task.updated", payload: { taskId: "t1" } });
    expect(call.headers["x-opifer-event"]).toBe("task.updated");
    // The broken endpoint: pending with a later attempt, then failed after the last one.
    let deliveries = await events.deliveries(companyId);
    const failing = deliveries.filter((d) => d.subscriptionId === broken.id);
    expect(failing.every((d) => d.status === "pending" && d.attempts === 1 && d.nextAttemptAt.getTime() > now.getTime() + 2000)).toBe(true);
    let at = now;
    for (let i = 0; i < 6; i++) {
      at = new Date(at.getTime() + 3 * 3_600_000);
      await events.flush(fetch, at);
    }
    deliveries = await events.deliveries(companyId);
    expect(deliveries.filter((d) => d.subscriptionId === broken.id).every((d) => d.status === "failed")).toBe(true);
    expect((await events.list(companyId)).find((s) => s.id === broken.id)?.failures).toBe(2);
  });

  it("channels: unknown senders get a pairing code, a person claims it, the chat keeps its agent and session", async () => {
    const channels = new ChannelService(db.sql);
    const channel = await channels.create({ companyId, kind: "telegram", name: "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId: agentId }, person);
    const pending = await channels.pairingFor(channel, "chat-1", "user-1", "Mike");
    expect(pending.userId).toBeNull();
    expect(pending.pairingCode).toMatch(/^\d{6}$/);
    await expect(channels.pair(companyId, "000000", null, person)).rejects.toMatchObject({ code: "not_found" });
    const paired = await channels.pair(companyId, pending.pairingCode!, null, person);
    expect(paired.userId).not.toBeNull();
    expect(paired.pairingCode).toBeNull();
    // Writing again does not reset a paired sender.
    expect((await channels.pairingFor(channel, "chat-1", "user-1", "Mike")).userId).toBe(paired.userId);
    await channels.setAgent(paired.id, agentId);
    await channels.setSession(paired.id, null);
    expect((await channels.notifiable(companyId)).map((b) => b.id)).toEqual([paired.id]);
    await channels.setNotify(companyId, paired.id, false);
    expect(await channels.notifiable(companyId)).toEqual([]);
    expect((await channels.listAll()).some((c) => c.id === channel.id)).toBe(true);
  });

  it("the Docker environment runs commands through docker with the workdir mounted and no network", async () => {
    // A docker shim: records the arguments and runs the command locally, so the test needs no daemon.
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-docker-"));
    const shim = path.join(dir, "docker");
    await writeFile(shim, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\nwhile [ "$1" != "node:22-bookworm-slim" ]; do shift; done; shift\nexec "$@"\n`);
    await chmod(shim, 0o755);
    const env = new DockerEnvironment({ binary: shim });
    const workdir = path.join(dir, "work");
    await env.prepare(workdir);
    const result = await env.run(["sh", "-c", "echo inside"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("inside");
    const { readFile } = await import("node:fs/promises");
    const args = await readFile(path.join(dir, "args.txt"), "utf8");
    expect(args).toContain("run --rm --network none -v");
    expect(args).toContain(`${workdir}:/work -w /work`);
    expect(env.id).toBe("docker");
  });
});
