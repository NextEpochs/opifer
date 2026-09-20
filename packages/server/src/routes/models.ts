import type { AgentRuntime } from "@opifer/runtime";
import type { FastifyInstance } from "fastify";
import type { ProviderSetup } from "../providers.js";

export async function registerModelRoutes(app: FastifyInstance, options: { runtime: AgentRuntime; setup: ProviderSetup }): Promise<void> {
  app.get("/models", async () => {
    const models: Array<{ id: string; provider: string; contextWindow: number; price: unknown }> = [];
    const errors: Array<{ provider: string; error: string }> = [];
    for (const provider of options.setup.providers.list()) {
      try {
        for (const m of await provider.listModels()) {
          models.push({ id: `${provider.id}/${m.id}`, provider: provider.id, contextWindow: m.capabilities.contextWindow, price: m.price });
        }
      } catch (error) {
        errors.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { default: options.setup.defaultModel, fallback: options.setup.fallbackModel, providers: options.setup.report, models, errors };
  });
}
