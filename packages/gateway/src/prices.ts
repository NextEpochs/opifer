/**
 * Price book: per-model prices from the providers (editable tables in each
 * plugin), a USD→EUR rate, and the two computations governance needs: the
 * estimate before a call and the real cost after it.
 */

import type { ModelPrice, Usage } from "@opifer/sdk";
import type { ProviderRegistry } from "@opifer/runtime";

export interface Money {
  usd: number;
  eur: number;
}

export interface PriceBookOptions {
  /** Euros per dollar; updated by configuration. */
  usdToEur?: number;
}

const DEFAULT_USD_TO_EUR = 0.92;

export class PriceBook {
  private readonly cache = new Map<string, ModelPrice>();
  private readonly loaded = new Set<string>();
  readonly usdToEur: number;

  constructor(
    private readonly providers: ProviderRegistry,
    options: PriceBookOptions = {},
  ) {
    this.usdToEur = options.usdToEur ?? DEFAULT_USD_TO_EUR;
  }

  /** Explicit price for a model id (`provider/model`); overrides the provider's table. */
  set(modelId: string, price: ModelPrice): void {
    this.cache.set(modelId, price);
  }

  async priceFor(modelId: string): Promise<ModelPrice> {
    const cached = this.cache.get(modelId);
    if (cached) return cached;
    const slash = modelId.indexOf("/");
    const providerId = slash > 0 ? modelId.slice(0, slash) : modelId;
    if (!this.loaded.has(providerId) && this.providers.has(providerId)) {
      this.loaded.add(providerId);
      try {
        const { provider } = this.providers.resolve(`${providerId}/_`);
        for (const m of await provider.listModels()) {
          if (!this.cache.has(`${providerId}/${m.id}`)) this.cache.set(`${providerId}/${m.id}`, m.price);
        }
      } catch {
        // no list: unknown models cost zero until a price is set
      }
    }
    return this.cache.get(modelId) ?? { inputPerMillion: 0, outputPerMillion: 0, currency: "USD" };
  }

  private toMoney(amount: number, currency: ModelPrice["currency"]): Money {
    return currency === "EUR" ? { usd: amount / this.usdToEur, eur: amount } : { usd: amount, eur: amount * this.usdToEur };
  }

  /** Upper-bound estimate: counted input tokens plus the configured maximum output. */
  async estimate(modelId: string, inputTokens: number, maxOutputTokens: number): Promise<Money> {
    const p = await this.priceFor(modelId);
    return this.toMoney((inputTokens * p.inputPerMillion + maxOutputTokens * p.outputPerMillion) / 1_000_000, p.currency);
  }

  async cost(modelId: string, usage: Usage): Promise<Money> {
    const p = await this.priceFor(modelId);
    const cached = usage.cachedInputTokens ?? 0;
    const cachedRate = p.cachedInputPerMillion ?? p.inputPerMillion;
    const amount = ((usage.inputTokens - cached) * p.inputPerMillion + cached * cachedRate + usage.outputTokens * p.outputPerMillion) / 1_000_000;
    return this.toMoney(Math.max(0, amount), p.currency);
  }
}
