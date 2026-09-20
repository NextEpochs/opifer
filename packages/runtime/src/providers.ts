/**
 * Registry of model providers. A model is referred to as `provider/name`,
 * for example `anthropic/claude-sonnet-4-5` or `local/llama3`; the provider
 * is a plugin that implements `ModelProvider`.
 */

import type { Embedder, EmbeddingProvider, ModelProvider } from "@opifer/sdk";

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
  /** Full form `provider/model`. */
  id: string;
}

function canEmbed(provider: ModelProvider): provider is ModelProvider & EmbeddingProvider {
  return typeof (provider as Partial<EmbeddingProvider>).embedder === "function";
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /**
   * The embedder for `provider/model`, or the first provider that offers one
   * when no model is given; null when none can embed (search stays full-text).
   */
  embedder(modelId?: string | null): Embedder | null {
    if (modelId) {
      const { provider, model } = this.resolve(modelId);
      return canEmbed(provider) ? provider.embedder(model) : null;
    }
    for (const provider of this.providers.values()) {
      if (canEmbed(provider)) return provider.embedder();
    }
    return null;
  }

  resolve(modelId: string): ResolvedModel {
    const slash = modelId.indexOf("/");
    if (slash <= 0) {
      throw new Error(`Invalid model "${modelId}": use the form provider/model (e.g. anthropic/claude-sonnet-4-5)`);
    }
    const providerId = modelId.slice(0, slash);
    const model = modelId.slice(slash + 1);
    const provider = this.providers.get(providerId);
    if (!provider) {
      const known = [...this.providers.keys()].join(", ") || "none";
      throw new Error(`Provider "${providerId}" not configured (available: ${known})`);
    }
    return { provider, model, id: modelId };
  }
}
