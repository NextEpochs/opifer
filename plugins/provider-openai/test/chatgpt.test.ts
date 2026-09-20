/**
 * ChatGPT subscription provider tests against a fake authorization server
 * and a fake Codex backend: code exchange, token claims, refresh close to
 * expiry, Responses API mapping and SSE reading.
 */

import { createServer, type Server } from "node:http";
import { ProviderError, type CompletionRequest } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChatGPTProvider,
  MemoryCredentialStore,
  buildAuthorizationRequest,
  exchangeCode,
  parseCallbackURL,
  startCallbackServer,
  type ChatGPTCredentials,
  type OAuthEndpoints,
} from "../src/index.js";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

const account = { chatgpt_account_id: "acct_123", chatgpt_plan_type: "plus" };
let tokenCalls: Array<Record<string, string>> = [];
let backendCalls: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
let backendMode: "text" | "tools" = "text";
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url === "/oauth/token") {
        const form = Object.fromEntries(new URLSearchParams(raw));
        tokenCalls.push(form);
        const exp = Math.floor(Date.now() / 1000) + 3600;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: jwt({ exp, "https://api.openai.com/auth": account }),
            refresh_token: form["grant_type"] === "refresh_token" ? "refresh_2" : "refresh_1",
            id_token: jwt({ exp, email: "mike@example.com", "https://api.openai.com/auth": account }),
            expires_in: 3600,
          }),
        );
        return;
      }
      if (req.url === "/codex/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }, { slug: "gpt-5.3-codex" }] }));
        return;
      }
      if (req.url === "/codex/responses") {
        backendCalls.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`).join("");
        if (backendMode === "text") {
          res.end(
            sse([
              { type: "response.created", response: { id: "r1" } },
              { type: "response.output_text.delta", delta: "Hello" },
              { type: "response.output_text.delta", delta: " there" },
              { type: "response.completed", response: { id: "r1", usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } } } },
            ]),
          );
        } else {
          res.end(
            sse([
              { type: "response.output_item.added", item: { type: "function_call", call_id: "call_9", name: "terminal" } },
              { type: "response.function_call_arguments.delta", delta: '{"command":"ls"}' },
              { type: "response.output_item.done", item: { type: "function_call", call_id: "call_9", name: "terminal", arguments: '{"command":"ls"}' } },
              { type: "response.completed", response: { id: "r2", usage: { input_tokens: 50, output_tokens: 12 } } },
            ]),
          );
        }
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const endpoints = (): OAuthEndpoints => ({
  authorizeURL: `${base}/oauth/authorize`,
  tokenURL: `${base}/oauth/token`,
  clientId: "app_test",
  redirectURI: "http://localhost:14555/auth/callback",
  scope: "openid profile email offline_access",
  originator: "opifer_test",
});

const request: CompletionRequest = {
  model: "gpt-5.6-terra",
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
};

async function collect(provider: ChatGPTProvider, req: CompletionRequest) {
  const events = [];
  for await (const e of provider.complete(req)) events.push(e);
  return events;
}

describe("ChatGPT sign-in", () => {
  it("builds a PKCE authorization request with the Codex parameters", () => {
    const auth = buildAuthorizationRequest(endpoints());
    const url = new URL(auth.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_test");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe(auth.state);
    expect(auth.pkce.verifier.length).toBeGreaterThan(40);
  });

  it("exchanges the code and reads account id, plan and email from the tokens", async () => {
    tokenCalls = [];
    const auth = buildAuthorizationRequest(endpoints());
    const creds = await exchangeCode("code_abc", auth.pkce, endpoints());
    expect(creds).toMatchObject({ accountId: "acct_123", planType: "plus", email: "mike@example.com", refreshToken: "refresh_1" });
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
    expect(tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "code_abc", code_verifier: auth.pkce.verifier, client_id: "app_test" });
  });

  it("receives the redirect on the local callback server and checks the state", async () => {
    const callback = await startCallbackServer(14555);
    try {
      const waiting = callback.waitForCode("state_ok", 5000);
      const rejected = expect(waiting).rejects.toThrow(/state mismatch/);
      const bad = await fetch("http://127.0.0.1:14555/auth/callback?code=x&state=wrong");
      expect(bad.status).toBe(400);
      await rejected;
      const again = callback.waitForCode("state_ok", 5000);
      const good = await fetch("http://127.0.0.1:14555/auth/callback?code=code_ok&state=state_ok");
      expect(good.status).toBe(200);
      expect(await again).toBe("code_ok");
    } finally {
      await callback.close();
    }
  });

  it("parses a pasted redirect URL (manual flow)", () => {
    expect(parseCallbackURL(" http://localhost:1455/auth/callback?code=c1&state=s1 ")).toEqual({ code: "c1", state: "s1" });
    expect(() => parseCallbackURL("nope")).toThrow(ProviderError);
  });
});

describe("ChatGPT provider", () => {
  const freshCredentials = (expiresInMs: number): ChatGPTCredentials => ({
    accessToken: jwt({ exp: Math.floor((Date.now() + expiresInMs) / 1000), "https://api.openai.com/auth": account }),
    refreshToken: "refresh_1",
    idToken: jwt({ email: "mike@example.com", "https://api.openai.com/auth": account }),
    accountId: "acct_123",
    planType: "plus",
    email: "mike@example.com",
    expiresAt: Date.now() + expiresInMs,
    obtainedAt: Date.now(),
  });

  it("sends Responses API requests to the Codex backend with the subscription headers", async () => {
    backendCalls = [];
    backendMode = "text";
    const provider = new ChatGPTProvider({ store: new MemoryCredentialStore(freshCredentials(3_600_000)), baseURL: `${base}/codex`, oauth: endpoints() });
    const events = await collect(provider, request);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Hello there");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { inputTokens: 40, outputTokens: 5, cachedInputTokens: 10 } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    const call = backendCalls[0]!;
    expect(call.headers["authorization"]).toMatch(/^Bearer /);
    expect(call.headers["chatgpt-account-id"]).toBe("acct_123");
    expect(call.headers["originator"]).toBe("opifer_test");
    expect(call.body).toMatchObject({ model: "gpt-5.6-terra", instructions: "You are an agent.", stream: true, store: false });
    const input = call.body["input"] as Array<Record<string, unknown>>;
    expect(input.map((i) => i["type"])).toEqual(["message", "function_call", "function_call_output", "message", "message", "message"]);
    expect(input[1]).toMatchObject({ call_id: "call_0", name: "terminal", arguments: '{"command":"ls"}' });
    expect(input[2]).toMatchObject({ call_id: "call_0", output: "a.txt" });
    expect((call.body["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "function", name: "terminal" });
  });

  it("reads tool calls from the stream", async () => {
    backendMode = "tools";
    const provider = new ChatGPTProvider({ store: new MemoryCredentialStore(freshCredentials(3_600_000)), baseURL: `${base}/codex`, oauth: endpoints() });
    const events = await collect(provider, request);
    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", call: { type: "tool_call", id: "call_9", name: "terminal", arguments: { command: "ls" } } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("refreshes the tokens when close to expiry and saves them", async () => {
    tokenCalls = [];
    backendMode = "text";
    const store = new MemoryCredentialStore(freshCredentials(60_000));
    const provider = new ChatGPTProvider({ store, baseURL: `${base}/codex`, oauth: endpoints() });
    await collect(provider, request);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh_1" });
    const saved = await store.load();
    expect(saved?.refreshToken).toBe("refresh_2");
    expect(saved!.expiresAt - Date.now()).toBeGreaterThan(30 * 60 * 1000);
  });

  it("lists the backend models with no per-token price", async () => {
    const provider = new ChatGPTProvider({ store: new MemoryCredentialStore(freshCredentials(3_600_000)), baseURL: `${base}/codex`, oauth: endpoints() });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-5.3-codex"]);
    expect(models[0]!.price).toMatchObject({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it("fails clearly when not signed in", async () => {
    const provider = new ChatGPTProvider({ store: new MemoryCredentialStore(null), baseURL: `${base}/codex`, oauth: endpoints() });
    await expect(collect(provider, request)).rejects.toSatisfy((e) => e instanceof ProviderError && e.kind === "auth" && /not signed in/.test(e.message));
  });
});
