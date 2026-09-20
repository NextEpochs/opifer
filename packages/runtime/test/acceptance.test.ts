/**
 * Criterio di accettazione M1: una conversazione di 50 turni con tool
 * sopravvive a un riavvio e riprende dalla cronologia salvata, senza
 * rieseguire azioni già compiute.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Script } from "../src/testing.js";
import { createFixture, type Fixture } from "./helpers.js";

/** A ogni turno l'agente aggiunge una riga a un registro con il terminale, poi risponde. */
function ledgerScript(): Script {
  return (request, _i) => {
    const last = request.messages.at(-1)!;
    if (last.role === "tool") {
      const result = last.content.find((p) => p.type === "tool_result");
      return { kind: "text", text: `riga aggiunta (${result && result.type === "tool_result" ? result.content.split("\n")[0] : "?"})` };
    }
    const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    return { kind: "tools", calls: [{ name: "terminal", arguments: { command: `echo "${text}" >> registro.txt && wc -l < registro.txt` } }] };
  };
}

describe("accettazione M1: 50 turni con tool sopravvivono a un riavvio", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(ledgerScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("25 turni, riavvio a metà di un turno, altri 25 turni: cronologia intatta e nessun tool rieseguito", async () => {
    const workdir = path.join(f.workRoot, "accettazione");
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId, workdir });

    for (let i = 1; i <= 25; i++) {
      const result = await f.runtime.runTurn({ sessionId: session.id, text: `turno ${i}` });
      expect(result.run.status, `turno ${i}`).toBe("conclusa");
    }

    // Simula un crash a metà turno: il modello ha chiesto un tool ma il processo muore prima di eseguirlo.
    const crashed = await f.runtime.store.createRun(session);
    await f.runtime.store.appendMessage(session, "user", [{ type: "text", text: "turno 26" }], { runId: crashed.id });
    await f.runtime.store.appendMessage(
      session,
      "assistant",
      [{ type: "tool_call", id: "call_crash", name: "terminal", arguments: { command: 'echo "turno 26" >> registro.txt && wc -l < registro.txt' } }],
      { runId: crashed.id },
    );
    const linesBeforeRestart = (await readFile(path.join(workdir, "registro.txt"), "utf8")).trim().split("\n").length;
    expect(linesBeforeRestart).toBe(25);

    // Riavvio: nuovo runtime sullo stesso database.
    const restarted = f.restart();
    const stale = await restarted.recoverSession(session.id);
    expect(stale.map((r) => r.status)).toEqual(["interrotta"]);

    // Il turno 27 riprende: la chiamata rimasta appesa riceve un risultato di interruzione, senza replay.
    const resumed = await restarted.runTurn({ sessionId: session.id, text: "turno 27" });
    expect(resumed.run.status).toBe("conclusa");
    const linesAfterResume = (await readFile(path.join(workdir, "registro.txt"), "utf8")).trim().split("\n");
    expect(linesAfterResume).toHaveLength(26);
    expect(linesAfterResume).not.toContain("turno 26");
    expect(linesAfterResume.at(-1)).toBe("turno 27");

    for (let i = 28; i <= 51; i++) {
      const result = await restarted.runTurn({ sessionId: session.id, text: `turno ${i}` });
      expect(result.run.status, `turno ${i}`).toBe("conclusa");
    }

    const messages = await restarted.store.listMessages(session.id);
    // 50 turni completi (utente, chiamata, risultato, risposta) + il turno interrotto (utente, chiamata, risultato di interruzione)
    expect(messages).toHaveLength(50 * 4 + 3);
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]!.role, `messaggio ${i}`).not.toBe(messages[i - 1]!.role);
    }
    expect(messages.map((m) => m.seq)).toEqual(messages.map((_, i) => i + 1));

    const finalLines = (await readFile(path.join(workdir, "registro.txt"), "utf8")).trim().split("\n");
    expect(finalLines).toHaveLength(50);

    const runs = await restarted.store.listRuns(session.id);
    expect(runs.filter((r) => r.status === "conclusa")).toHaveLength(50);
    expect(runs.filter((r) => r.status === "interrotta")).toHaveLength(1);

    const stillSame = await restarted.store.getSession(session.id);
    expect(stillSame?.systemPromptHash).toBe(session.systemPromptHash);
  }, 120_000);
});
