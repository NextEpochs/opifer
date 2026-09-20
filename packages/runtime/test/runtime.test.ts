import { ProviderError } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/index.js";
import { echoScript, type Script } from "../src/testing.js";
import { createFixture, type Fixture } from "./helpers.js";

describe("runtime: basic turn", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(echoScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("creates a session with the system prompt assembled in the fixed order", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    expect(session.model).toBe("fake/echo");
    const order = ["# Identity", "# Org chart", "# Memory", "# Available skills", "# Governance rules", "# Work context"];
    let last = -1;
    for (const heading of order) {
      const idx = session.systemPrompt.indexOf(heading);
      expect(idx, heading).toBeGreaterThan(last);
      last = idx;
    }
    expect(session.systemPrompt).toContain("You are Assistant, an agent of the company Test company.");
  });

  it("runs a turn with streaming and persists user and assistant", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const events: RuntimeEvent[] = [];
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "ciao", onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("final_answer");
    expect(result.assistantText).toBe("echo: ciao");
    expect(result.run.status).toBe("completed");
    expect(result.run.inputTokens).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("echo: ciao");
    expect(events.filter((e) => e.type === "phase").map((e) => (e as { phase: string }).phase)).toEqual(["preflight", "assemble", "call", "read", "close"]);

    const messages = await f.runtime.store.listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const updated = await f.runtime.store.getSession(session.id);
    expect(updated?.title).toBe("ciao");
    const runEvents = await f.runtime.store.listRunEvents(result.run.id);
    expect(runEvents.map((e) => e.type)).toContain("model");
  });

  it("run events written concurrently get distinct sequence numbers", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    const run = await f.runtime.store.createRun(session);
    await Promise.all(Array.from({ length: 25 }, (_, i) => f.runtime.store.appendRunEvent(run, "test", { i })));
    const events = await f.runtime.store.listRunEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    await f.runtime.store.finishRun(run.id, { status: "completed", stopReason: "test" });
  });

  it("refuses a second turn without a new message", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId });
    await f.runtime.runTurn({ sessionId: session.id, text: "one" });
    const result = await f.runtime.runTurn({ sessionId: session.id });
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/no new message/);
  });
});

describe("runtime: tools and resumption", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(toolScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("runs the native tools in the working directory and closes with the final answer", async () => {
    const session = await f.runtime.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s1` });
    const events: RuntimeEvent[] = [];
    const result = await f.runtime.runTurn({ sessionId: session.id, text: "write and read", onEvent: (e) => events.push(e) });
    expect(result.stopReason).toBe("final_answer");
    expect(result.assistantText).toContain("content: hello world");
    const toolEvents = events.filter((e) => e.type === "tool_result") as Array<{ name: string; isError: boolean }>;
    expect(toolEvents.map((e) => e.name)).toEqual(["write_file", "read_file", "terminal"]);
    expect(toolEvents.every((e) => !e.isError)).toBe(true);
    const roles = (await f.runtime.store.listMessages(session.id)).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });

  it("refuses always-forbidden commands without running them", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "tools", calls: [{ name: "terminal", arguments: { command: "rm -rf / --no-preserve-root" } }] } : { kind: "text", text: "understood" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s2` });
    const events: RuntimeEvent[] = [];
    await rt.runTurn({ sessionId: session.id, text: "destroy everything", onEvent: (e) => events.push(e) });
    const result = events.find((e) => e.type === "tool_result") as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/always forbidden/);
  });

  it("ask_user stops the turn waiting for the person", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "tools", calls: [{ name: "ask_user", arguments: { question: "which file?" } }] } : { kind: "text", text: "thanks" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "do something" });
    expect(result.stopReason).toBe("clarification_requested");
    expect(result.run.status).toBe("waiting");
    const next = await rt.runTurn({ sessionId: session.id, text: "the file a.txt" });
    expect(next.assistantText).toBe("thanks");
    const roles = (await rt.store.listMessages(session.id)).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  });

  it("an interruption stops the turn and the session resumes afterwards", async () => {
    const script: Script = (_r, i) => (i === 0 ? { kind: "hang" } : { kind: "text", text: "resumed" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const pending = rt.runTurn({ sessionId: session.id, text: "wait" });
    await new Promise((r) => setTimeout(r, 50));
    expect(rt.interrupt(session.id)).toBe(true);
    const result = await pending;
    expect(result.run.status).toBe("interrupted");
    expect(result.stopReason).toBe("interrupted");
    const next = await rt.runTurn({ sessionId: session.id, text: "go" });
    expect(next.assistantText).toBe("resumed");
    const messages = await rt.store.listMessages(session.id);
    // the "go" message was appended to "wait": role alternation is respected
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content.map((p) => (p.type === "text" ? p.text : ""))).toEqual(["wait", "go"]);
  });

  it("an operator message mid-turn enters a tool result", async () => {
    const script: Script = (_r, i) =>
      i === 0 ? { kind: "tools", calls: [{ name: "terminal", arguments: { command: "sleep 0.3; echo done" } }] } : { kind: "text", text: "ok" };
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, workdir: `${f.workRoot}/s3` });
    const pending = rt.runTurn({ sessionId: session.id, text: "work" });
    await new Promise((r) => setTimeout(r, 100));
    expect(rt.inject(session.id, "hurry up")).toBe(true);
    await pending;
    const messages = await rt.store.listMessages(session.id);
    const toolMessage = messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content.some((p) => p.type === "text" && p.text.includes("[operator message] hurry up"))).toBe(true);
    const updated = await rt.store.getSession(session.id);
    expect(updated?.systemPrompt).toBe(session.systemPrompt);
  });
});

describe("runtime: error recovery", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture(echoScript());
  }, 120_000);

  afterAll(async () => {
    await f?.destroy();
  });

  it("retries transient errors with increasing delays", async () => {
    let calls = 0;
    const script: Script = () => (++calls < 3 ? { kind: "error", error: new ProviderError("overloaded", "transient", 529) } : { kind: "text", text: "made it" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const events: RuntimeEvent[] = [];
    const result = await rt.runTurn({ sessionId: session.id, text: "test", onEvent: (e) => events.push(e) });
    expect(result.assistantText).toBe("made it");
    const retries = events.filter((e) => e.type === "retry") as Array<{ delayMs: number }>;
    expect(retries.map((r) => r.delayMs)).toEqual([1, 2]);
  });

  it("does not retry authentication errors: the turn fails", async () => {
    const script: Script = () => ({ kind: "error", error: new ProviderError("invalid key", "auth", 401) });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "test" });
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/invalid key/);
  });

  it("switches to the fallback model when the primary is exhausted", async () => {
    const script: Script = (request) =>
      request.model === "echo" ? { kind: "error", error: new ProviderError("down", "transient", 503) } : { kind: "text", text: `answer from ${request.model}` };
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId, fallbackModel: "fake/backup" });
    const events: RuntimeEvent[] = [];
    const result = await rt.runTurn({ sessionId: session.id, text: "test", onEvent: (e) => events.push(e) });
    expect(result.assistantText).toBe("answer from backup");
    expect(events.some((e) => e.type === "fallback")).toBe(true);
  });

  it("an empty response is retried only once", async () => {
    let calls = 0;
    const script: Script = () => (++calls === 1 ? { kind: "empty" } : { kind: "text", text: "here I am" });
    const rt = f.restart(script);
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "test" });
    expect(result.assistantText).toBe("here I am");
    expect(calls).toBe(2);
  });

  it("respects the iteration limit", async () => {
    const script: Script = () => ({ kind: "tools", calls: [{ name: "list_files", arguments: {} }] });
    const rt = f.restart(script, { limits: { maxIterations: 3 } });
    const session = await rt.startSession({ companyId: f.companyId, agentId: f.agentId });
    const result = await rt.runTurn({ sessionId: session.id, text: "loop" });
    expect(result.stopReason).toBe("iteration_limit");
    expect(result.run.iterations).toBe(3);
    expect(rt.isRunning(session.id)).toBe(false);
  });
});

/** Script with tools: writes a file, reads it, runs a command, then answers. */
function toolScript(): Script {
  return (_request, i) => {
    if (i === 0) return { kind: "tools", text: "writing", calls: [{ name: "write_file", arguments: { path: "notes/hello.txt", content: "hello world" } }] };
    if (i === 1) return { kind: "tools", calls: [{ name: "read_file", arguments: { path: "notes/hello.txt" } }, { name: "terminal", arguments: { command: "cat notes/hello.txt | wc -c" } }] };
    return { kind: "text", text: "content: hello world" };
  };
}
