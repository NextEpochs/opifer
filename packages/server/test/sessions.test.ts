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

describe("API sessioni", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let baseURL: string;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const provider = new FakeProvider((request) => {
      const last = request.messages.at(-1)!;
      if (last.role === "tool") return { kind: "text", text: "elencato" };
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text.startsWith("elenca")) return { kind: "tools", calls: [{ name: "list_files", arguments: {} }] };
      return { kind: "text", text: `eco: ${text}` };
    });
    app = await buildApp({
      db,
      mode: "locale",
      providers: { providers: new ProviderRegistry().register(provider), defaultModel: "finto/eco", fallbackModel: null, report: [] },
      workRoot: await mkdtemp(path.join(tmpdir(), "opifer-work-")),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    baseURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Sessioni" } })).json() as { id: string };
    companyId = company.id;
    const agent = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/agents`, payload: { name: "Chat", role: "risponde" } })).json() as { id: string };
    agentId = agent.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  function waitForEvent(socket: WebSocket, predicate: (e: { type: string; payload: unknown }) => boolean, timeoutMs = 10_000): Promise<{ type: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("evento non arrivato")), timeoutMs);
      socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as { type: string; payload: unknown };
        if (predicate(event)) {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }

  it("crea una sessione, invia un messaggio e riceve lo streaming via WebSocket", async () => {
    const created = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId, title: "Prova" } });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; model: string; systemPrompt: string };
    expect(session.model).toBe("finto/eco");
    expect(session.systemPrompt).toContain("Sei Chat");

    const socket = new WebSocket(`${baseURL.replace("http", "ws")}/v1/events`);
    await new Promise<void>((r) => socket.on("open", () => r()));
    const finished = waitForEvent(socket, (e) => e.type === "sessione.evento" && (e.payload as { event: { type: string } }).event.type === "fine");
    const texts: string[] = [];
    socket.on("message", (data) => {
      const e = JSON.parse(String(data)) as { type: string; payload: { event: { type: string; text?: string } } };
      if (e.type === "sessione.evento" && e.payload.event.type === "testo") texts.push(e.payload.event.text!);
    });

    const sent = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "ciao" } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({ accepted: "turno_avviato" });

    const fine = await finished;
    expect((fine.payload as { event: { run: { status: string } } }).event.run.status).toBe("conclusa");
    expect(texts.join("")).toBe("eco: ciao");
    socket.close();

    const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}` })).json() as { messages: Array<{ role: string }>; runs: unknown[]; running: boolean };
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.runs).toHaveLength(1);
    expect(detail.running).toBe(false);
  });

  it("esegue i tool e li espone negli eventi dell'esecuzione", async () => {
    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    const socket = new WebSocket(`${baseURL.replace("http", "ws")}/v1/events`);
    await new Promise<void>((r) => socket.on("open", () => r()));
    const finished = waitForEvent(socket, (e) => e.type === "sessione.evento" && (e.payload as { sessionId: string; event: { type: string } }).sessionId === session.id && (e.payload as { event: { type: string } }).event.type === "fine");
    await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "elenca i file" } });
    await finished;
    socket.close();
    const runs = (await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/runs` })).json() as Array<{ events: Array<{ type: string }> }>;
    expect(runs[0]!.events.map((e) => e.type)).toContain("tool_chiamata");
    expect(runs[0]!.events.map((e) => e.type)).toContain("tool_risultato");
  });

  it("rifiuta agenti di altre aziende e sessioni chiuse", async () => {
    const other = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Altra" } })).json() as { id: string };
    const wrong = await app.inject({ method: "POST", url: `/v1/companies/${other.id}/sessions`, payload: { agentId } });
    expect(wrong.statusCode).toBe(400);

    const session = (await app.inject({ method: "POST", url: `/v1/companies/${companyId}/sessions`, payload: { agentId } })).json() as { id: string };
    const closed = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/close` });
    expect(closed.json()).toMatchObject({ status: "chiusa" });
    const refused = await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/messages`, payload: { text: "ciao" } });
    expect(refused.statusCode).toBe(409);
  });

  it("elenca i modelli disponibili con il modello di default", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.json()).toMatchObject({ default: "finto/eco", models: [{ id: "finto/eco", provider: "finto" }] });
  });
});
