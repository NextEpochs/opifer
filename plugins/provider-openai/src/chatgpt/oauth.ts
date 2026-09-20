/**
 * "Sign in with ChatGPT": the OAuth 2.0 authorization-code flow with PKCE
 * used by OpenAI's own Codex CLI, so that a ChatGPT subscription can be used
 * instead of a platform API key.
 *
 * The browser is opened on the authorization URL; the redirect lands on a
 * local callback (http://localhost:1455/auth/callback) or, when no browser
 * can reach this machine, the person pastes the redirect URL by hand.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { ProviderError } from "@opifer/sdk";
import type { ChatGPTCredentials } from "./credentials.js";

export interface OAuthEndpoints {
  authorizeURL: string;
  tokenURL: string;
  clientId: string;
  redirectURI: string;
  scope: string;
  /** Value of the `originator` parameter the authorization server expects. */
  originator: string;
}

/** The public OAuth client OpenAI ships in the Codex CLI. */
export const DEFAULT_OAUTH: OAuthEndpoints = {
  authorizeURL: "https://auth.openai.com/oauth/authorize",
  tokenURL: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectURI: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  originator: "codex_cli_rs",
};

export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";

const base64url = (buffer: Buffer): string => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  pkce: PkcePair;
}

export function buildAuthorizationRequest(endpoints: OAuthEndpoints = DEFAULT_OAUTH): AuthorizationRequest {
  const pkce = createPkce();
  const state = base64url(randomBytes(24));
  const url = new URL(endpoints.authorizeURL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", endpoints.clientId);
  url.searchParams.set("redirect_uri", endpoints.redirectURI);
  url.searchParams.set("scope", endpoints.scope);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", endpoints.originator);
  return { url: url.toString(), state, pkce };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface AuthClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
}

interface JwtPayload {
  exp?: number;
  email?: string;
  "https://api.openai.com/auth"?: AuthClaims;
  "https://api.openai.com/profile"?: { email?: string };
}

/** Decodes a JWT payload without verifying the signature: the tokens come straight from the authorization server. */
export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length < 2) throw new ProviderError("malformed token", "auth");
  const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as JwtPayload;
}

export function credentialsFromTokens(tokens: TokenResponse): ChatGPTCredentials {
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new ProviderError("the token response is missing access_token or refresh_token", "auth");
  }
  const idToken = tokens.id_token ?? tokens.access_token;
  const access = decodeJwtPayload(tokens.access_token);
  const id = decodeJwtPayload(idToken);
  const auth = access["https://api.openai.com/auth"] ?? id["https://api.openai.com/auth"] ?? {};
  const accountId = auth.chatgpt_account_id;
  if (!accountId) throw new ProviderError("no ChatGPT account id in the token: is this a ChatGPT account?", "auth");
  const expiresAt = access.exp ? access.exp * 1000 : Date.now() + (tokens.expires_in ?? 3600) * 1000;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken,
    accountId,
    planType: auth.chatgpt_plan_type ?? null,
    email: id.email ?? id["https://api.openai.com/profile"]?.email ?? null,
    expiresAt,
    obtainedAt: Date.now(),
  };
}

async function postForm(url: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const detail = body.error_description ?? body.error ?? `${response.status} ${response.statusText}`;
    throw ProviderError.fromStatus(response.status, `ChatGPT sign-in: ${detail}`);
  }
  return body;
}

export async function exchangeCode(code: string, pkce: PkcePair, endpoints: OAuthEndpoints = DEFAULT_OAUTH, fetchImpl: typeof fetch = fetch): Promise<ChatGPTCredentials> {
  const tokens = await postForm(
    endpoints.tokenURL,
    { grant_type: "authorization_code", client_id: endpoints.clientId, code, redirect_uri: endpoints.redirectURI, code_verifier: pkce.verifier },
    fetchImpl,
  );
  return credentialsFromTokens(tokens);
}

export async function refreshCredentials(current: ChatGPTCredentials, endpoints: OAuthEndpoints = DEFAULT_OAUTH, fetchImpl: typeof fetch = fetch): Promise<ChatGPTCredentials> {
  const tokens = await postForm(
    endpoints.tokenURL,
    { grant_type: "refresh_token", client_id: endpoints.clientId, refresh_token: current.refreshToken, scope: endpoints.scope },
    fetchImpl,
  );
  const next = credentialsFromTokens({ ...tokens, refresh_token: tokens.refresh_token ?? current.refreshToken, id_token: tokens.id_token ?? current.idToken });
  if (next.accountId !== current.accountId) throw new ProviderError("the refreshed token belongs to a different ChatGPT account: sign in again", "auth");
  return next;
}

/** Reads `code` and `state` from a pasted redirect URL (manual flow). */
export function parseCallbackURL(raw: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderError("that does not look like the redirect URL", "request");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new ProviderError("the redirect URL has no code or state", "request");
  return { code, state };
}

export interface CallbackServer {
  /** Resolves with the authorization code once the browser lands on the callback. */
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

const SUCCESS_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Opifer</title>
<body style="font-family:system-ui;margin:3rem;color:#222"><h1>Signed in</h1><p>You can close this window and go back to Opifer.</p></body></html>`;
const FAILURE_PAGE = (reason: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Opifer</title>
<body style="font-family:system-ui;margin:3rem;color:#222"><h1>Sign-in failed</h1><p>${reason}</p></body></html>`;

/** Local HTTP server for the OAuth redirect. Port 1455 is the one registered for the Codex client. */
export async function startCallbackServer(port: number = CALLBACK_PORT): Promise<CallbackServer> {
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  let expected: string | null = null;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error || !code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(FAILURE_PAGE(url.searchParams.get("error_description") ?? error ?? "missing code"));
      rejectCode?.(new ProviderError(`ChatGPT sign-in refused: ${url.searchParams.get("error_description") ?? error ?? "missing code"}`, "auth"));
      return;
    }
    if (expected && state !== expected) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(FAILURE_PAGE("state mismatch"));
      rejectCode?.(new ProviderError("ChatGPT sign-in: state mismatch (possible cross-site request)", "auth"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_PAGE);
    resolveCode?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new ProviderError(`port ${port} is busy: close the other program (or another sign-in) and retry`, "request") : error);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    waitForCode: (expectedState, timeoutMs = 5 * 60 * 1000) =>
      new Promise<string>((resolve, reject) => {
        expected = expectedState;
        const timer = setTimeout(() => reject(new ProviderError("ChatGPT sign-in timed out", "request")), timeoutMs);
        resolveCode = (code) => {
          clearTimeout(timer);
          resolve(code);
        };
        rejectCode = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
