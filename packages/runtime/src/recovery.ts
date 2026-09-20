/**
 * Recovery from provider errors: retries with increasing delays for
 * transient errors, switch to the fallback model when the attempts are
 * exhausted, a single retry for an empty response.
 */

import { ProviderError, type CompletionRequest, type ContentToolCall, type ModelProvider, type Usage } from "@opifer/sdk";
import type { ResolvedModel } from "./providers.js";

export interface RecoveryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
}

export const DEFAULT_RECOVERY: RecoveryOptions = { maxAttempts: 3, baseDelayMs: 500 };

export interface CompletionOutcome {
  text: string;
  toolCalls: ContentToolCall[];
  usage: Usage;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted";
  modelId: string;
}

async function consume(provider: ModelProvider, request: CompletionRequest, onText: (t: string) => void): Promise<Omit<CompletionOutcome, "modelId">> {
  let text = "";
  const toolCalls: ContentToolCall[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: CompletionOutcome["stopReason"] = "end_turn";
  for await (const event of provider.complete(request)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        onText(event.text);
        break;
      case "tool_call":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage = { ...usage, ...event.usage };
        break;
      case "done":
        stopReason = event.stopReason;
        break;
    }
  }
  return { text, toolCalls, usage, stopReason };
}

function classify(error: unknown): { retryable: boolean; message: string } {
  if (error instanceof ProviderError) return { retryable: error.retryable, message: error.message };
  if (error instanceof Error) {
    const transient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|overloaded|timeout/i.test(error.message);
    return { retryable: transient, message: error.message };
  }
  return { retryable: false, message: String(error) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attemptModel(
  resolved: ResolvedModel,
  request: Omit<CompletionRequest, "model">,
  onText: (t: string) => void,
  options: RecoveryOptions,
): Promise<CompletionOutcome> {
  let emptyRetried = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (request.signal?.aborted) throw new Error("interrupted");
    try {
      const outcome = await consume(resolved.provider, { ...request, model: resolved.model }, onText);
      if (!outcome.text && outcome.toolCalls.length === 0 && outcome.stopReason !== "aborted" && !emptyRetried) {
        emptyRetried = true;
        options.onRetry?.(attempt, 0, "empty response");
        continue;
      }
      return { ...outcome, modelId: resolved.id };
    } catch (error) {
      lastError = error;
      const { retryable, message } = classify(error);
      if (!retryable || attempt === options.maxAttempts || request.signal?.aborted) break;
      const delay = options.baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, delay, message);
      await sleep(delay);
    }
  }
  throw lastError ?? new Error("model call failed");
}

/** Calls the primary model with retries; if it fails and there is a fallback, switches to the fallback. */
export async function completeWithRecovery(
  primary: ResolvedModel,
  fallback: ResolvedModel | null,
  request: Omit<CompletionRequest, "model">,
  onText: (t: string) => void,
  options: RecoveryOptions = DEFAULT_RECOVERY,
): Promise<CompletionOutcome> {
  try {
    return await attemptModel(primary, request, onText, options);
  } catch (error) {
    if (!fallback || request.signal?.aborted) throw error;
    const { message } = classify(error);
    options.onFallback?.(primary.id, fallback.id, message);
    return attemptModel(fallback, request, onText, options);
  }
}
