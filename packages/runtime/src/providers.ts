/**
 * Registro dei provider di modelli. Un modello si indica come
 * `provider/nome`, per esempio `anthropic/claude-sonnet-4-5` oppure
 * `local/llama3`; il provider è un plugin che implementa `ModelProvider`.
 */

import type { ModelProvider } from "@opifer/sdk";

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
  /** Forma completa `provider/modello`. */
  id: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Provider già registrato: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  resolve(modelId: string): ResolvedModel {
    const slash = modelId.indexOf("/");
    if (slash <= 0) {
      throw new Error(`Modello "${modelId}" non valido: usa la forma provider/modello (es. anthropic/claude-sonnet-4-5)`);
    }
    const providerId = modelId.slice(0, slash);
    const model = modelId.slice(slash + 1);
    const provider = this.providers.get(providerId);
    if (!provider) {
      const known = [...this.providers.keys()].join(", ") || "nessuno";
      throw new Error(`Provider "${providerId}" non configurato (disponibili: ${known})`);
    }
    return { provider, model, id: modelId };
  }
}
