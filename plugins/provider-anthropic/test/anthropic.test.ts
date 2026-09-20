/**
 * Anthropic provider tests against a fake server speaking the streaming
 * Messages protocol (SSE): message and tool block mapping, prefix cache,
 * stream reading, usage and errors.
 */

import { createServer, type Server } from "node:http";
import { ProviderError, type CompletionRequest } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/index.js";

let server: Server;
let baseURL: string;
const captured: Array<Record<string, unknown>> = [];
let mode: "text" | "tools" | "overloaded" = "text";

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }
      captured.push(body);
      if (mode === "overloaded") {
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = {
        type: "message_start",
        message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 25, cache_creation_input_tokens: 0 } },
      };
      if (mode === "text") {
        res.end(
          sse([
            start,
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
            { type: "message_stop" },
          ]),
        );
      } else {
        res.end(
          sse([
            start,
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running." } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "terminal", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } },
            { type: "message_stop" },
          ]),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  baseURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const request: CompletionRequest = {
  model: "claude-sonnet-5",
  system: "You are an agent.",
  messages: [
    { role: "user", content: [{ type: "text", text: "list" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "toolu_0", name: "terminal", arguments: { command: "ls" } }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "toolu_0", content: "a.txt", isError: false }, { type: "text", text: "[operator message] quick" }] },
    { role: "assistant", content: [{ type: "text", text: "there is a.txt" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ],
  tools: [{ name: "terminal", description: "runs", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
  cachePrefix: true,
};

async function collect(provider: AnthropicProvider, req: CompletionRequest) {
  const events = [];
  for await (const e of provider.complete(req)) events.push(e);
  return events;
}

describe("Anthropic provider", () => {
  it("maps messages and tools to the Messages format, with cache on the prefix", async () => {
    mode = "text";
    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    const events = await collect(provider, request);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello world");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { inputTokens: 30, outputTokens: 3, cachedInputTokens: 25 } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    const body = captured.at(-1)!;
    expect(body["system"]).toEqual([{ type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } }]);
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[1]!.content[0]).toMatchObject({ type: "tool_use", id: "toolu_0", name: "terminal", input: { command: "ls" } });
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_0", content: "a.txt" },
      { type: "text", text: "[operator message] quick" },
    ]);
    expect((body["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "terminal", input_schema: { type: "object" } });
  });

  it("reassembles tool calls from the JSON fragments", async () => {
    mode = "tools";
    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    const events = await collect(provider, request);
    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", call: { type: "tool_call", id: "toolu_1", name: "terminal", arguments: { command: "ls" } } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("classifies overload (529) as transient", async () => {
    mode = "overloaded";
    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    await expect(collect(provider, request)).rejects.toSatisfy((e) => e instanceof ProviderError && e.kind === "transient" && e.retryable);
  });

  it("counts tokens with the dedicated endpoint and lists the models with the price list", async () => {
    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    expect(await provider.countTokens(request)).toBe(42);
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toContain("claude-sonnet-5");
    expect(models.find((m) => m.id === "claude-sonnet-5")!.price).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10 });
  });
});
