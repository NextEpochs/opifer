import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutPoint, foldSummary, pruneToolResults, summariseDeterministically } from "../src/index.js";
import type { StoredMessage } from "../src/types.js";
import { createFixture, type Fixture } from "./helpers.js";

const msg = (seq: number, role: StoredMessage["role"], content: StoredMessage["content"]): StoredMessage => ({
  id: `m${seq}`,
  sessionId: "s",
  runId: null,
  seq,
  role,
  content,
  usage: null,
  createdAt: new Date().toISOString(),
});

describe("context: the two lines, in isolation", () => {
  it("prunes only old, long tool results and leaves the recent ones whole", () => {
    const long = "x".repeat(2000);
    const history: StoredMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(msg(i * 2 + 1, "assistant", [{ type: "tool_call", id: `c${i}`, name: "terminal", arguments: {} }]));
      history.push(msg(i * 2 + 2, "tool", [{ type: "tool_result", toolCallId: `c${i}`, content: long }]));
    }
    const { messages, prunedChars } = pruneToolResults(history, { compressAt: 0.5, pruneAfterMessages: 4, pruneKeepChars: 100, keepRecent: 4 });
    expect(prunedChars).toBeGreaterThan(0);
    const last = messages.at(-1)!.content[0] as { content: string };
    expect(last.content.length).toBe(2000);
    const first = messages[1]!.content[0] as { content: string };
    expect(first.content).toContain("characters pruned");
    expect(first.content.length).toBeLessThan(300);
    // The stored history is untouched.
    expect((history[1]!.content[0] as { content: string }).content.length).toBe(2000);
  });

  it("cuts at a user message so the summary folds in and alternation holds", () => {
    const history = [
      msg(1, "user", [{ type: "text", text: "a" }]),
      msg(2, "assistant", [{ type: "text", text: "b" }]),
      msg(3, "user", [{ type: "text", text: "c" }]),
      msg(4, "assistant", [{ type: "text", text: "d" }]),
      msg(5, "user", [{ type: "text", text: "e" }]),
      msg(6, "assistant", [{ type: "text", text: "f" }]),
    ];
    const cut = cutPoint(history, 2);
    expect(cut).toBe(4);
    const folded = foldSummary(
      history.slice(cut).map((m) => ({ role: m.role, content: m.content })),
      "Summary here",
    );
    expect(folded[0]!.role).toBe("user");
    expect((folded[0]!.content[0] as { text: string }).text).toContain("Summary here");
    expect((folded[0]!.content[1] as { text: string }).text).toBe("e");
    expect(cutPoint(history, 10)).toBe(-1);
  });

  it("the deterministic outline keeps asks, tool calls and results in order", () => {
    const outline = summariseDeterministically("earlier facts", [
      msg(1, "user", [{ type: "text", text: "Count the files" }]),
      msg(2, "assistant", [{ type: "tool_call", id: "c1", name: "terminal", arguments: { command: "ls | wc -l" } }]),
      msg(3, "tool", [{ type: "tool_result", toolCallId: "c1", content: "42" }]),
      msg(4, "assistant", [{ type: "text", text: "There are 42 files." }]),
    ]);
    expect(outline).toContain("Earlier: earlier facts");
    expect(outline).toContain("Person: Count the files");
    expect(outline).toContain("Agent called terminal");
    expect(outline).toContain("Result: 42");
    expect(outline).toContain("Agent: There are 42 files.");
  });
});

describe("context: compression inside a turn", () => {
  let fx: Fixture;
  let summaries = 0;
  let failSummary = false;

  beforeAll(async () => {
    fx = await createFixture(
      (request) => {
        if (request.system.startsWith("You compress")) {
          if (failSummary) throw new Error("summary model down");
          summaries++;
          return { kind: "text", text: `Goal: keep counting.\nDone so far: ${request.messages[0]!.content.length > 0 ? "several counts" : ""}.` };
        }
        const last = request.messages.at(-1)!;
        const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        return { kind: "text", text: `ok ${text.slice(-20)} ${"y".repeat(3000)}` };
      },
      // A tiny window: three long exchanges are enough to pass the threshold.
      { context: { compressAt: 0.5, keepRecent: 2, pruneAfterMessages: 4, pruneKeepChars: 100 } },
    );
    // The fake model reports a 200k window; shrink it for the test.
    (fx.runtime as unknown as { options: { providers: { contextWindow: () => Promise<number> } } }).options.providers.contextWindow = async () => 6000;
  }, 60_000);

  afterAll(async () => {
    await fx?.destroy();
  });

  it("past the threshold the older messages become a traced summary; the messages stay; the session id does not change", async () => {
    const session = await fx.runtime.startSession({ companyId: fx.companyId, agentId: fx.agentId });
    for (let i = 1; i <= 6; i++) await fx.runtime.runTurn({ sessionId: session.id, text: `message ${i} ${"z".repeat(1500)}` });
    expect(summaries).toBeGreaterThanOrEqual(1);
    const compressions = await fx.runtime.store.listCompressions(session.id);
    expect(compressions.length).toBeGreaterThanOrEqual(1);
    expect(compressions[0]!.method).toBe("model");
    expect(compressions[0]!.charsAfter).toBeLessThan(compressions[0]!.charsBefore);
    const after = await fx.runtime.store.getSession(session.id);
    expect(after!.contextFromSeq).toBe(compressions.at(-1)!.toSeq);
    expect(after!.contextSummary).toContain("Goal: keep counting");
    // Every message is still stored, in order.
    const all = await fx.runtime.store.listMessages(session.id);
    expect(all.length).toBe(12);
    expect(all.map((m) => m.seq)).toEqual(all.map((_, i) => i + 1));
    // The last request the model saw starts with the summary folded into a user message and holds far fewer characters.
    const lastRequest = fx.provider.requests.filter((r) => !r.system.startsWith("You compress")).at(-1)!;
    expect(lastRequest.messages[0]!.role).toBe("user");
    expect((lastRequest.messages[0]!.content[0] as { text: string }).text).toContain("[Summary of the earlier conversation");
    expect(JSON.stringify(lastRequest.messages).length).toBeLessThan(JSON.stringify(all.map((m) => m.content)).length);
    // Traced in the audit and in the run events.
    const [audit] = await fx.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE action = 'session.compressed' AND subject_id = ${session.id}`;
    expect(Number(audit!.n)).toBe(compressions.length);
  });

  it("when the summary model fails, the deterministic outline takes over and the turn still completes", async () => {
    failSummary = true;
    try {
      const session = await fx.runtime.startSession({ companyId: fx.companyId, agentId: fx.agentId });
      for (let i = 1; i <= 6; i++) {
        const result = await fx.runtime.runTurn({ sessionId: session.id, text: `count ${i} ${"w".repeat(1500)}` });
        expect(result.run.status).toBe("completed");
      }
      const compressions = await fx.runtime.store.listCompressions(session.id);
      expect(compressions.length).toBeGreaterThanOrEqual(1);
      expect(compressions.every((c) => c.method === "deterministic")).toBe(true);
      expect(compressions[0]!.summary).toContain("Person: count 1");
    } finally {
      failSummary = false;
    }
  });
});
