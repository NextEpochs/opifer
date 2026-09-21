/**
 * Which web search a company has: the model's own (ChatGPT, Anthropic search
 * by themselves), a key stored as a company secret (Brave, Tavily, SearXNG),
 * or the installation's environment. Nothing configured means web_search is
 * not offered; web_fetch and the browser still are.
 */

import type { SearchOptions } from "@opifer/runtime";

export const SEARCH_SECRETS = { brave: "BRAVE_API_KEY", tavily: "TAVILY_API_KEY", searxng: "SEARXNG_URL" } as const;
export type SearchProvider = keyof typeof SEARCH_SECRETS;

export interface SecretsView {
  list(companyId: string): Promise<Array<{ name: string }>>;
  readForSystem(companyId: string, name: string, purpose: string): Promise<string | null>;
}

export interface WebSearchStatus {
  /** Model providers whose models search by themselves. */
  native: string[];
  provider: SearchProvider | null;
  source: "secret" | "environment" | null;
}

export class WebSearchSetup {
  constructor(
    private readonly secrets: () => SecretsView | null,
    private readonly environment: SearchOptions | null,
    private readonly nativeProviders: () => string[],
  ) {}

  /** The provider a company's secrets name, checked by name only (no value read, no access logged). */
  private async secretProvider(companyId: string): Promise<SearchProvider | null> {
    const view = this.secrets();
    if (!view) return null;
    const names = new Set((await view.list(companyId)).map((s) => s.name));
    for (const [provider, secret] of Object.entries(SEARCH_SECRETS) as Array<[SearchProvider, string]>) if (names.has(secret)) return provider;
    return null;
  }

  async status(companyId: string): Promise<WebSearchStatus> {
    const fromSecret = await this.secretProvider(companyId);
    if (fromSecret) return { native: this.nativeProviders(), provider: fromSecret, source: "secret" };
    if (this.environment) return { native: this.nativeProviders(), provider: this.environment.provider, source: "environment" };
    return { native: this.nativeProviders(), provider: null, source: null };
  }

  /** The options for a search now: the secret's value is read (and the access logged) only here. */
  async resolve(companyId: string): Promise<SearchOptions | null> {
    const provider = await this.secretProvider(companyId);
    if (provider) {
      const value = await this.secrets()?.readForSystem(companyId, SEARCH_SECRETS[provider], "web search");
      if (value) return provider === "searxng" ? { provider, url: value } : { provider, apiKey: value };
    }
    return this.environment;
  }
}
