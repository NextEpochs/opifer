/**
 * `o4r login chatgpt`: sign in with a ChatGPT account so OpenAI models are
 * billed to the subscription instead of an API key. Opens the browser on the
 * authorization page and waits for the redirect on a local port; with
 * --manual the redirect URL is pasted by hand (headless machines).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  FileCredentialStore,
  buildAuthorizationRequest,
  exchangeCode,
  parseCallbackURL,
  startCallbackServer,
  DEFAULT_OAUTH,
} from "@opifer/provider-openai";
import { chatgptCredentialsFile } from "@opifer/server";
import { resolveHome } from "../home.js";
import { c, say } from "../output.js";

export interface LoginOptions {
  home?: string;
  manual?: boolean;
  /** Do not try to open the browser. */
  noBrowser?: boolean;
}

const PROVIDERS = ["chatgpt"] as const;
type LoginProvider = (typeof PROVIDERS)[number];

function assertProvider(name: string): LoginProvider {
  if ((PROVIDERS as readonly string[]).includes(name)) return name as LoginProvider;
  throw new Error(`Unknown sign-in provider "${name}". Available: ${PROVIDERS.join(", ")}. API keys go in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY).`);
}

/** The Codex OAuth endpoints, with OPIFER_CHATGPT_AUTH_URL as issuer override (proxies, tests). */
function oauthEndpoints() {
  const issuer = process.env["OPIFER_CHATGPT_AUTH_URL"]?.replace(/\/$/, "");
  if (!issuer) return DEFAULT_OAUTH;
  return { ...DEFAULT_OAUTH, authorizeURL: `${issuer}/oauth/authorize`, tokenURL: `${issuer}/oauth/token` };
}

function openBrowser(url: string): boolean {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runLogin(providerName: string, options: LoginOptions): Promise<void> {
  const provider = assertProvider(providerName);
  const home = resolveHome(options.home);
  if (provider !== "chatgpt") return;

  const store = new FileCredentialStore(chatgptCredentialsFile(home.credentialsDir));
  const existing = await store.load();
  if (existing) say.warn(`Already signed in as ${existing.email ?? existing.accountId}; signing in again replaces those credentials.`);

  const endpoints = oauthEndpoints();
  const auth = buildAuthorizationRequest(endpoints);
  say.step("Sign in with ChatGPT");
  say.info(
    c.dim(
      "This uses the same sign-in as OpenAI's Codex CLI: OpenAI tolerates third-party tools using it, but does not guarantee it. Use your own account and keep the credentials private.",
    ),
  );

  let code: string;
  if (options.manual) {
    say.info(`Open this URL in a browser, sign in, then paste the full URL you are redirected to (it starts with ${DEFAULT_OAUTH.redirectURI}):`);
    say.info("");
    say.info(auth.url);
    say.info("");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const pasted = await rl.question("Redirect URL: ");
      const parsed = parseCallbackURL(pasted);
      if (parsed.state !== auth.state) throw new Error("the pasted URL belongs to a different sign-in attempt (state mismatch)");
      code = parsed.code;
    } finally {
      rl.close();
    }
  } else {
    const callback = await startCallbackServer();
    try {
      const opened = options.noBrowser ? false : openBrowser(auth.url);
      say.info(opened ? "A browser window should open. If it does not, open this URL:" : "Open this URL in your browser:");
      say.info("");
      say.info(auth.url);
      say.info("");
      say.info(c.dim("Waiting for the sign-in to complete (up to 5 minutes)…"));
      code = await callback.waitForCode(auth.state);
    } finally {
      await callback.close();
    }
  }

  const credentials = await exchangeCode(code, auth.pkce, endpoints);
  await store.save(credentials);
  say.ok(`Signed in as ${c.bold(credentials.email ?? credentials.accountId)}${credentials.planType ? ` (${credentials.planType})` : ""}`);
  say.info(`Credentials saved in ${store.file}`);
  say.info(`Models are now available as ${c.cyan("chatgpt/<model>")}; set the default with ${c.cyan("o4r init --model chatgpt/gpt-5.6-terra")} and restart the server.`);
}

export async function runLogout(providerName: string, options: { home?: string }): Promise<void> {
  const provider = assertProvider(providerName);
  const home = resolveHome(options.home);
  if (provider !== "chatgpt") return;
  const store = new FileCredentialStore(chatgptCredentialsFile(home.credentialsDir));
  const existing = await store.load();
  await store.clear();
  if (existing) say.ok(`Signed out of ChatGPT (${existing.email ?? existing.accountId}); restart the server to apply.`);
  else say.warn("No ChatGPT credentials stored");
}
