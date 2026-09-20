/**
 * OpenAI-compatible endpoints for local models: Ollama, vLLM, LM Studio,
 * llama.cpp and the like. It is the OpenAI provider pointed at another
 * address, with the adaptations local servers require.
 */

import { OpenAIProvider, type OpenAIProviderOptions } from "@opifer/provider-openai";

export interface CompatibleProviderOptions {
  /** Provider id, prefix of the models (default `local`). */
  id?: string;
  /** API address, for example `http://127.0.0.1:11434/v1` (Ollama) or `http://127.0.0.1:1234/v1` (LM Studio). */
  baseURL: string;
  apiKey?: string;
  models?: string[];
  contextWindow?: number;
  /** Some servers support neither tools nor usage in streaming. */
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
    apiKey: options.apiKey ?? "local",
    // Local models have no price list: zero cost unless configured.
    prices: {},
    compat: { systemRole: "system", tools: options.tools ?? true, streamUsage: options.streamUsage ?? true },
    ...(options.models ? { models: options.models } : {}),
    ...(options.contextWindow ? { defaultContextWindow: options.contextWindow } : {}),
  };
  return new OpenAIProvider(base);
}

export { OpenAIProvider };
