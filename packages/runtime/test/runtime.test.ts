import { ProviderError } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/index.js";
import { echoScript, type Script } from "../src/testing.js";
import { createFixture, type Fixture } from "./helpers.js";

describe("runtime: turno base", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(echoScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("crea una sessione con il prompt di sistema assemblato nell'ordine fisso", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    expect(session.model).toBe("finto/eco");
    const order = ["# Identità", "# Organigramma", "# Memoria", "# Skill disponibili", "# Regole di governo", "# Contesto del lavoro"];
    let last = -1;
    for (const heading of order) {
      const idx = session.systemPrompt.indexOf(heading);
      expect(idx, heading).toBeGreaterThan(last);
      last = idx;
    }
    expect(session.systemPrompt).toContain("Sei Assistente, un agente dell'azienda Azienda di prova.");
  });

  it("esegue un turno con streaming e persiste utente e assistente", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const events: RuntimeEvent[] = [];
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "ciao", onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("risposta_finale");
    expect(result.assistantText).toBe("eco: ciao");
    expect(result.run.status).toBe("conclusa");
    expect(result.run.inputTokens).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "testo").map((e) => (e as { text: string }).text).join("")).toBe("eco: ciao");
    expect(events.filter((e) => e.type === "fase").map((e) => (e as { phase: string }).phase)).toEqual(["preflight", "assemblaggio", "chiamata", "lettura", "chiusura"]);

    const messages = await f.runtime.store.listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const updated = await f.runtime.store.getSession(session.id);
    expect(updated?.title).toBe("ciao");
    const runEvents = await f.runtime.store.listRunEvents(result.run.id);
    expect(runEvents.map((e) => e.type)).toContain("modello");
  });

  it("gli eventi di un'esecuzione scritti in concorrenza hanno sequenze distinte", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const run = await f.runtime.store.createRun(session);
    await Promise.all(Array.from({ length: 25 }, (_, i) => f.runtime.store.appendRunEvent(run, "prova", { i })));
    const events = await f.runtime.store.listRunEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    await f.runtime.store.finishRun(run.id, { status: "conclusa", stopReason: "prova" });
  });

  it("rifiuta un secondo turno senza un nuovo messaggio", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    await f.runtime.runTurn({ sessionId: session.id, text: "uno" });
    const result = await f.runtime.runTurn({ sessionId: session.id });
    expect(result.run.status).toBe("fallita");
    expect(result.run.error).toMatch(/nessun nuovo messaggio/);
  });
});

describe("runtime: tool e ripresa", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(toolScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("esegue i tool nativi nella cartella di lavoro e chiude con la risposta finale", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s1` });
    const events: RuntimeEvent[] = [];
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "scrivi e leggi", onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("risposta_finale");
    expect(result.assistantText).toContain("contenuto: ciao mondo");
    const toolEvents = events.filter((e) => e.type === "tool_risultato") as Array<{ name: string; isError: boolean }>;
    expect(toolEvents.map((e) => e.name)).toEqual(["write_file", "read_file", "terminal"]);
    expect(toolEvents.every((e) => !e.isError)).toBe(true);
    const roles = (await f.runtime.store.listMessages(session.id)).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });

  it("rifiuta i comandi sempre vietati senza eseguirli", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "tools", calls: [{ name: "terminal", arguments: { command: "rm -rf / --no-preserve-root" } }] } : { kind: "text", text: "capito" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s2` });
    const events: RuntimeEvent[] = [];
    await rt.runTurn({ sessionId: session.id, text: "distruggi tutto", onEvent: (e) => events.push(e) });
    const result = events.find((e) => e.type === "tool_risultato") as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/sempre vietato/);
  });

  it("ask_user ferma il turno in attesa della persona", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "tools", calls: [{ name: "ask_user", arguments: { question: "quale file?" } }] } : { kind: "text", text: "grazie" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "fai una cosa" });
    expect(result.stopReason).toBe("chiarimento_richiesto");
    expect(result.run.status).toBe("in_attesa");
    const next = await rt.runTurn({ sessionId: session.id, text: "il file a.txt" });
    expect(next.assistantText).toBe("grazie");
    const roles = (await rt.store.listMessages(session.id)).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  });

  it("l'interruzione ferma il turno e la sessione riprende dopo", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "hang" } : { kind: "text", text: "ripreso" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const pending = rt.runTurn({ sessionId: session.id, text: "aspetta" });
    await new Promise((r) => setTimeout(r, 50));
    expect(rt.interrupt(session.id)).toBe(true);
    const result = await pending;
    expect(result.run.status).toBe("interrotta");
    expect(result.stopReason).toBe("interruzione");
    const next = await rt.runTurn({ sessionId: session.id, text: "vai" });
    expect(next.assistantText).toBe("ripreso");
    const messages = await rt.store.listMessages(session.id);
    // il messaggio "vai" si è accodato ad "aspetta": l'alternanza è rispettata
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content.map((p) => (p.type === "text" ? p.text : ""))).toEqual(["aspetta", "vai"]);
  });

  it("un messaggio dell'operatore a metà turno entra in un risultato di tool", async () => {
    const script: Script = (_r, i) =>
      i === 0 ? { kind: "tools", calls: [{ name: "terminal", arguments: { command: "sleep 0.3; echo fatto" } }] } : { kind: "text", text: "ok" };
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s3` });
    const pending = rt.runTurn({ sessionId: session.id, text: "lavora" });
    await new Promise((r) => setTimeout(r, 100));
    expect(rt.inject(session.id, "fai in fretta")).toBe(true);
    await pending;
    const messages = await rt.store.listMessages(session.id);
    const toolMessage = messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content.some((p) => p.type === "text" && p.text.includes("[messaggio dell'operatore] fai in fretta"))).toBe(true);
    const updated = await rt.store.getSession(session.id);
    expect(updated?.systemPrompt).toBe(session.systemPrompt);
  });
});

describe("runtime: recupero dagli errori", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(echoScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("ritenta gli errori transitori a intervalli crescenti", async () => {
    let calls = 0;
    const script: Script = () => (++calls < 3 ? { kind: "error", error: new ProviderError("overloaded", "transitorio", 529) } : { kind: "text", text: "ce l'ho fatta" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const events: RuntimeEvent[] = [];
    const result = await rt.runTurn({ sessionId: session.id, text: "prova", onEvent: (e) => events.push(e) });
    expect(result.assistantText).toBe("ce l'ho fatta");
    const retries = events.filter((e) => e.type === "ritentativo") as Array<{ delayMs: number }>;
    expect(retries.map((r) => r.delayMs)).toEqual([1, 2]);
  });

  it("non ritenta gli errori di autenticazione: il turno fallisce", async () => {
    const script: Script = () => ({ kind: "error", error: new ProviderError("chiave non valida", "autenticazione", 401) });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "prova" });
    expect(result.run.status).toBe("fallita");
    expect(result.run.error).toMatch(/chiave non valida/);
  });

  it("passa al modello di riserva quando il principale è esaurito", async () => {
    const script: Script = (request) =>
      request.model === "eco" ? { kind: "error", error: new ProviderError("giù", "transitorio", 503) } : { kind: "text", text: `risposta da ${request.model}` };
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, fallbackModel: "finto/riserva" });
    const events: RuntimeEvent[] = [];
    const result = await rt.runTurn({ sessionId: session.id, text: "prova", onEvent: (e) => events.push(e) });
    expect(result.assistantText).toBe("risposta da riserva");
    expect(events.some((e) => e.type === "riserva")).toBe(true);
  });

  it("una risposta vuota si ritenta una sola volta", async () => {
    let calls = 0;
    const script: Script = () => (++calls === 1 ? { kind: "empty" } : { kind: "text", text: "eccomi" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "prova" });
    expect(result.assistantText).toBe("eccomi");
    expect(calls).toBe(2);
  });

  it("rispetta il limite di iterazioni", async () => {
    const script: Script = () => ({ kind: "tools", calls: [{ name: "list_files", arguments: {} }] });
    const rt = f.restart(script, { limits: { maxIterations: 3 } });
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "gira" });
    expect(result.stopReason).toBe("limite_iterazioni");
    expect(result.run.iterations).toBe(3);
    expect(rt.isRunning(session.id)).toBe(false);
  });
});

/** Copione con tool: scrive un file, lo legge, lancia un comando, poi risponde. */
function toolScript(): Script {
  return (_request, i) => {
    if (i === 0) return { kind: "tools", text: "scrivo", calls: [{ name: "write_file", arguments: { path: "note/ciao.txt", content: "ciao mondo" } }] };
    if (i === 1) return { kind: "tools", calls: [{ name: "read_file", arguments: { path: "note/ciao.txt" } }, { name: "terminal", arguments: { command: "cat note/ciao.txt | wc -c" } }] };
    return { kind: "text", text: "contenuto: ciao mondo" };
  };
}
