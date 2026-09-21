/**
 * Web search for the agents: which provider, from the configuration or the
 * environment. Brave and Tavily take an API key; SearXNG an instance URL.
 * web_fetch needs nothing.
 */

import type { SearchOptions } from "@opifer/runtime";
import type { OpiferConfig } from "../home.js";

export function searchFromConfig(config: OpiferConfig, env: NodeJS.ProcessEnv): SearchOptions | null {
  const configured = config.web?.search;
  if (configured === null) return null;
  const provider = configured?.provider ?? (env["BRAVE_API_KEY"] ? "brave" : env["TAVILY_API_KEY"] ? "tavily" : env["SEARXNG_URL"] ? "searxng" : null);
  if (!provider) return null;
  if (provider === "brave") return env["BRAVE_API_KEY"] ? { provider, apiKey: env["BRAVE_API_KEY"] } : null;
  if (provider === "tavily") return env["TAVILY_API_KEY"] ? { provider, apiKey: env["TAVILY_API_KEY"] } : null;
  const url = configured?.url ?? env["SEARXNG_URL"];
  return url ? { provider: "searxng", url } : null;
}
