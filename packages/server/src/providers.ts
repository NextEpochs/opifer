/**
 * Assemblaggio dei provider di modelli dalla configurazione e dalle
 * variabili d'ambiente. In M1 le chiavi arrivano dall'ambiente
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY); dalla M2 vivono nel vault cifrato.
 */

import { ProviderRegistry } from "@opifer/runtime";
import { AnthropicProvider } from "@opifer/provider-anthropic";
import { OpenAIProvider } from "@opifer/provider-openai";
import { createCompatibleProvider } from "@opifer/provider-openai-compatible";

export interface ModelsConfig {
  /** Modello di default per gli agenti senza modello, es. `anthropic/claude-sonnet-5`. */
  default?: string | null;
  fallback?: string | null;
  /** Modello ausiliario economico per compressione, titoli e revisione (M4, M6). */
  auxiliary?: string | null;
  /** Endpoint compatibile OpenAI per modelli locali. */
  local?: { baseURL: string; models?: string[]; tools?: boolean } | null;
}

export interface ProviderSetup {
  providers: ProviderRegistry;
  defaultModel: string;
  fallbackModel: string | null;
  /** Descrizione leggibile di cosa è configurato e cosa manca. */
  report: Array<{ id: string; enabled: boolean; detail: string }>;
}

const DEFAULT_BY_PROVIDER: Record<string, string> = {
  anthropic: "anthropic/claude-sonnet-5",
  openai: "openai/gpt-5.6-terra",
  local: "local/llama3",
};

export function setupProviders(config: ModelsConfig = {}, env: NodeJS.ProcessEnv = process.env): ProviderSetup {
  const providers = new ProviderRegistry();
  const report: ProviderSetup["report"] = [];

  if (env["ANTHROPIC_API_KEY"]) {
    providers.register(new AnthropicProvider({ apiKey: env["ANTHROPIC_API_KEY"] }));
    report.push({ id: "anthropic", enabled: true, detail: "chiave da ANTHROPIC_API_KEY" });
  } else {
    report.push({ id: "anthropic", enabled: false, detail: "manca ANTHROPIC_API_KEY" });
  }

  if (env["OPENAI_API_KEY"]) {
    providers.register(new OpenAIProvider({ apiKey: env["OPENAI_API_KEY"] }));
    report.push({ id: "openai", enabled: true, detail: "chiave da OPENAI_API_KEY" });
  } else {
    report.push({ id: "openai", enabled: false, detail: "manca OPENAI_API_KEY" });
  }

  const localURL = config.local?.baseURL ?? env["OPIFER_LOCAL_BASE_URL"];
  if (localURL) {
    providers.register(
      createCompatibleProvider({
        id: "local",
        baseURL: localURL,
        ...(config.local?.models ? { models: config.local.models } : {}),
        ...(config.local?.tools !== undefined ? { tools: config.local.tools } : {}),
      }),
    );
    report.push({ id: "local", enabled: true, detail: `endpoint ${localURL}` });
  } else {
    report.push({ id: "local", enabled: false, detail: "nessun endpoint locale (OPIFER_LOCAL_BASE_URL o config)" });
  }

  const enabled = report.filter((r) => r.enabled).map((r) => r.id);
  let defaultModel = config.default ?? null;
  if (defaultModel && !providers.has(defaultModel.split("/")[0]!)) defaultModel = null;
  if (!defaultModel) {
    const first = enabled[0];
    defaultModel = first ? DEFAULT_BY_PROVIDER[first]! : "anthropic/claude-sonnet-5";
  }
  let fallbackModel = config.fallback ?? null;
  if (fallbackModel && !providers.has(fallbackModel.split("/")[0]!)) fallbackModel = null;

  return { providers, defaultModel, fallbackModel, report };
}
