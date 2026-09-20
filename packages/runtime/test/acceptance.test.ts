/**
 * M1 acceptance criterion: a 50-turn conversation with tools survives a
 * restart and resumes from the saved history, without re-running actions
 * already performed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Script } from "../src/testing.js";
import { createFixture, type Fixture } from "./helpers.js";

/** On every turn the agent appends a line to a ledger with the terminal, then answers. */
function ledgerScript(): Script {
  return (request, _i) => {
    const last = request.messages.at(-1)!;
    if (last.role === "tool") {
      const result = last.content.find((p) => p.type === "tool_result");
      return { kind: "text", text: `line added (${result && result.type === "tool_result" ? result.content.split("\n")[0] : "?"})` };
    }
    const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    return { kind: "tools", calls: [{ name: "terminal", arguments: { command: `echo "${text}" >> ledger.txt && wc -l < ledger.txt` } }] };
  };
}

describe("M1 acceptance: 50 turns with tools survive a restart", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(ledgerScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("25 turns, restart mid-turn, 25 more turns: history intact and no tool re-run", async () => {
    const workdir = path.join(f.workRoot, "acceptance");
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId, workdir });

    for (let i = 1; i <= 25; i++) {
      const result = await f.runtime.runTurn({ sessionId: session.id, text: `turn ${i}` });
      expect(result.run.status, `turn ${i}`).toBe("completed");
    }

    // Simulate a crash mid-turn: the model asked for a tool but the process dies before running it.
    const crashed = await f.runtime.store.createRun(session);
    await f.runtime.store.appendMessage(session, "user", [{ type: "text", text: "turn 26" }], { runId: crashed.id });
    await f.runtime.store.appendMessage(
      session,
      "assistant",
      [{ type: "tool_call", id: "call_crash", name: "terminal", arguments: { command: 'echo "turn 26" >> ledger.txt && wc -l < ledger.txt' } }],
      { runId: crashed.id },
    );
    const linesBeforeRestart = (await readFile(path.join(workdir, "ledger.txt"), "utf8")).trim().split("\n").length;
    expect(linesBeforeRestart).toBe(25);

    // Restart: a new runtime on the same database.
    const restarted = f.restart();
    const stale = await restarted.recoverSession(session.id);
    expect(stale.map((r) => r.status)).toEqual(["interrupted"]);

    // Turn 27 resumes: the hanging call receives an interruption result, without replay.
    const resumed = await restarted.runTurn({ sessionId: session.id, text: "turn 27" });
    expect(resumed.run.status).toBe("completed");
    const linesAfterResume = (await readFile(path.join(workdir, "ledger.txt"), "utf8")).trim().split("\n");
    expect(linesAfterResume).toHaveLength(26);
    expect(linesAfterResume).not.toContain("turn 26");
    expect(linesAfterResume.at(-1)).toBe("turn 27");

    for (let i = 28; i <= 51; i++) {
      const result = await restarted.runTurn({ sessionId: session.id, text: `turn ${i}` });
      expect(result.run.status, `turn ${i}`).toBe("completed");
    }

    const messages = await restarted.store.listMessages(session.id);
    // 50 complete turns (user, call, result, answer) + the interrupted turn (user, call, interruption result)
    expect(messages).toHaveLength(50 * 4 + 3);
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]!.role, `message ${i}`).not.toBe(messages[i - 1]!.role);
    }
    expect(messages.map((m) => m.seq)).toEqual(messages.map((_, i) => i + 1));

    const finalLines = (await readFile(path.join(workdir, "ledger.txt"), "utf8")).trim().split("\n");
    expect(finalLines).toHaveLength(50);

    const runs = await restarted.store.listRuns(session.id);
    expect(runs.filter((r) => r.status === "completed")).toHaveLength(50);
    expect(runs.filter((r) => r.status === "interrupted")).toHaveLength(1);

    const stillSame = await restarted.store.getSession(session.id);
    expect(stillSame?.systemPromptHash).toBe(session.systemPromptHash);
  }, 120_000);
});
