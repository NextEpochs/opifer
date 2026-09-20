import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("Sessions API", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let baseURL: string;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1)!;
      if (last.role === "tool") return { kind: "text", text: "listed" };
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text.startsWith("list")) return { kind: "tools", calls: [{ name: "list_files", arguments: {} }] };
      return { kind: "text", text: `echo: ${text}` };
    });
    app = await buildApp({
      db,
      mode: "local",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
      workRoot: await mkdtemp(path.join(tmpdir(), "opifer-work-")),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    baseURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Sessions" } })).json() as { id: string };
    companyId = company.id;
    const agent = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Chat", role: "answers" } })).json() as { id: string };
    agentId = agent.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  function waitForEvent(socket: WebSocket, predicate: (e: { type: string; payload: unknown }) => boolean, timeoutMs = 10_000): Promise<{ type: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event did not arrive")), timeoutMs);
      socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as { type: string; payload: unknown };
        if (predicate(event)) {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }

  it("creates a session, sends a message and receives the stream over WebSocket", async () => {
    const created = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId, title: "Test" } });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; model: string; systemPrompt: string };
    expect(session.model).toBe("fake/echo");
    expect(session.systemPrompt).toContain("You are Chat");

    const socket = new WebSocket(`${baseURL.replace("http", "ws")}/v1/events`);
    await new Promise<void>((r) => socket.on("open", () => r()));
    const finished = waitForEvent(socket, (e) => e.type === "session.event" && (e.payload as { event: { type: string } }).event.type === "done");
    const texts: string[] = [];
    socket.on("message", (data) => {
      const e = JSON.parse(String(data)) as { type: string; payload: { event: { type: string; text?: string } } };
      if (e.type === "session.event" && e.payload.event.type === "text") texts.push(e.payload.event.text!);
    });

    const sent = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "hello" } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({ accepted: "turn_started" });

    const done = await finished;
    expect((done.payload as { event: { run: { status: string } } }).event.run.status).toBe("completed");
    expect(texts.join("")).toBe("echo: hello");
    socket.close();

    const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}` })).json() as { messages: Array<{ role: string }>; runs: unknown[]; running: boolean };
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.runs).toHaveLength(1);
    expect(detail.running).toBe(false);
  });

  it("executes the tools and exposes them in the run events", async () => {
    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    const socket = new WebSocket(`${baseURL.replace("http", "ws")}/v1/events`);
    await new Promise<void>((r) => socket.on("open", () => r()));
    const finished = waitForEvent(
      socket,
      (e) =>
        e.type === "session.event" &&
        (e.payload as { sessionId: string; event: { type: string } }).sessionId === session.id &&
        (e.payload as { event: { type: string } }).event.type === "done",
    );
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "list the files" } });
    await finished;
    socket.close();
    const runs = (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/runs` })).json() as Array<{ events: Array<{ type: string }> }>;
    expect(runs[0]!.events.map((e) => e.type)).toContain("tool_call");
    expect(runs[0]!.events.map((e) => e.type)).toContain("tool_result");
  });

  it("rejects agents of other companies and closed sessions", async () => {
    const other = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Other" } })).json() as { id: string };
    const wrong = await app.inject({ method: "POST", url: `/v1/companies/${other.id}/sessions`, payload: { agentId } });
    expect(wrong.statusCode).toBe(400);

    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    const closed = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/close` });
    expect(closed.json()).toMatchObject({ status: "closed" });
    const refused = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "hello" } });
    expect(refused.statusCode).toBe(409);
  });

  it("lists the available models with the default model", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.json()).toMatchObject({ default: "fake/echo", models: [{ id: "fake/echo", provider: "fake" }] });
  });
});
