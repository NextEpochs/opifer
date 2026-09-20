/**
 * Endpoint compatibili OpenAI per modelli locali: Ollama, vLLM, LM Studio,
 * llama.cpp e simili. È il provider OpenAI puntato a un altro indirizzo,
 * con gli adattamenti che i server locali richiedono.
 */

import { OpenAIProvider, type OpenAIProviderOptions } from "@opifer/provider-openai";

export interface CompatibleProviderOptions {
  /** Identificativo del provider, prefisso dei modelli (default `local`). */
  id?: string;
  /** Indirizzo dell'API, per esempio `http://127.0.0.1:11434/v1` (Ollama) o `http://127.0.0.1:1234/v1` (LM Studio). */
  baseURL: string;
  apiKey?: string;
  models?: string[];
  contextWindow?: number;
  /** Alcuni server non supportano i tool o l'usage nello streaming. */
  tools?: boolean;
  streamUsage?: boolean;
}

export const PRESETS = {
  ollama: { baseURL: "http://127.0.0.1:11434/v1" },
  lmstudio: { baseURL: "http://127.0.0.1:1234/v1" },
  vllm: { baseURL: "http://127.0.0.1:8000/v1" },
  llamacpp: { baseURL: "http://127.0.0.1:8080/v1" },
} as const;

export function createCompatibleProvider(options: CompatibleProviderOptions): OpenAIProvider {
  const base: OpenAIProviderOptions = {
    id: options.id ?? "local",
    baseURL: options.baseURL,
    apiKey: options.apiKey ?? "locale",
    // I modelli locali non hanno un listino: costo zero salvo configurazione.
    prices: {},
    compat: { systemRole: "system", tools: options.tools ?? true, streamUsage: options.streamUsage ?? true },
    ...(options.models ? { models: options.models } : {}),
    ...(options.contextWindow ? { defaultContextWindow: options.contextWindow } : {}),
  };
  return new OpenAIProvider(base);
}

export { OpenAIProvider };
