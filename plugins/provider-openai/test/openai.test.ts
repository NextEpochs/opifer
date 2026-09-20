/**
 * OpenAI provider tests against a fake server speaking the streaming Chat
 * Completions protocol (SSE): checks message mapping, stream reading, tool
 * calling, usage and error classification.
 */

import { createServer, type Server } from "node:http";
import { ProviderError, type CompletionRequest } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAIProvider } from "../src/index.js";

interface Captured {
  body: Record<string, unknown>;
}

let server: Server;
let baseURL: string;
const captured: Captured[] = [];
let mode: "text" | "tools" | "error500" | "error401" = "text";

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-5.6-luna", object: "model" },
              { id: "gpt-6-astra", object: "model" },
            ],
          }),
        );
        return;
      }
      captured.push({ body: JSON.parse(raw) as Record<string, unknown> });
      if (mode === "error500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "server in trouble" } }));
        return;
      }
      if (mode === "error401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna" };
      if (mode === "text") {
        res.end(
          sse([
            { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
          ]),
        );
      } else {
        res.end(
          sse([
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "terminal", arguments: '{"comm' } }] },
                  finish_reason: null,
                },
              ],
            },
            { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            { ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
          ]),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  baseURL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const request: CompletionRequest = {
  model: "gpt-5.6-luna",
  system: "You are an agent.",
  messages: [
    { role: "user", content: [{ type: "text", text: "list" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "call_0", name: "terminal", arguments: { command: "ls" } }] },
    {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "call_0", content: "a.txt" },
        { type: "text", text: "[operator message] quick" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "there is a.txt" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ],
  tools: [{ name: "terminal", description: "runs", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
  cachePrefix: true,
};

async function collect(provider: OpenAIProvider, req: CompletionRequest) {
  const events = [];
  for await (const e of provider.complete(req)) events.push(e);
  return events;
}

describe("OpenAI provider", () => {
  it("maps messages to the chat completions format and reads streamed text", async () => {
    mode = "text";
    const provider = new OpenAIProvider({ apiKey: "test", baseURL });
    const events = await collect(provider, request);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Hello world");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 } });

    const body = captured.at(-1)!.body;
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["system", "user", "assistant", "tool", "user", "assistant", "user"]);
    expect(messages[2]).toMatchObject({ tool_calls: [{ id: "call_0", function: { name: "terminal", arguments: '{"command":"ls"}' } }] });
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_0", content: "a.txt" });
    expect(messages[4]).toMatchObject({ role: "user", content: "[operator message] quick" });
    expect((body["tools"] as unknown[]).length).toBe(1);
    expect(body["stream"]).toBe(true);
  });

  it("reassembles tool calls from the stream fragments", async () => {
    mode = "tools";
    const provider = new OpenAIProvider({ apiKey: "test", baseURL });
    const events = await collect(provider, request);
    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", call: { type: "tool_call", id: "call_1", name: "terminal", arguments: { command: "ls" } } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("classifies errors: 500 transient, 401 auth", async () => {
    const provider = new OpenAIProvider({ apiKey: "test", baseURL });
    mode = "error500";
    await expect(collect(provider, request)).rejects.toSatisfy((e) => e instanceof ProviderError && e.kind === "transient" && e.retryable);
    mode = "error401";
    await expect(collect(provider, request)).rejects.toSatisfy((e) => e instanceof ProviderError && e.kind === "auth" && !e.retryable);
  });

  it("lists the endpoint models with the price list", async () => {
    const provider = new OpenAIProvider({ apiKey: "test", baseURL });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-6-astra"]);
    expect(models[0]!.price).toMatchObject({ inputPerMillion: 0.2, outputPerMillion: 1.2, currency: "USD" });
    expect(models[1]!.price.inputPerMillion).toBe(10);
  });

  it("without a key and without an endpoint refuses to start", () => {
    const saved = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      expect(() => new OpenAIProvider()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
    }
  });
});
