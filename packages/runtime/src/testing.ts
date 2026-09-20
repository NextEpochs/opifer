/**
 * Supporto ai test: un provider finto e deterministico. Risponde secondo un
 * copione, così i test del loop non chiamano modelli veri.
 */

import { ProviderError, type CompletionRequest, type ContentToolCall, type ModelInfo, type ModelProvider, type StreamEvent } from "@opifer/sdk";

export type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tools"; text?: string; calls: Array<{ name: string; arguments: Record<string, unknown> }> }
  | { kind: "error"; error: ProviderError }
  | { kind: "empty" }
  | { kind: "hang" };

export type Script = (request: CompletionRequest, callIndex: number) => ScriptedReply;

export class FakeProvider implements ModelProvider {
  readonly id: string;
  readonly requests: CompletionRequest[] = [];
  private calls = 0;

  constructor(private readonly script: Script, id = "finto") {
    this.id = id;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "eco",
        capabilities: { contextWindow: 200_000, maxOutputTokens: 8192, vision: false, reasoning: false, toolCalling: true },
        price: { inputPerMillion: 1, outputPerMillion: 5, currency: "EUR" },
      },
    ];
  }

  async countTokens(request: CompletionRequest): Promise<number> {
    const chars = request.system.length + request.messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    return Math.ceil(chars / 4);
  }

  async *complete(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const { signal: _signal, ...rest } = request;
    this.requests.push(structuredClone(rest));
    const reply = this.script(request, this.calls++);
    const inputTokens = await this.countTokens(request);
    switch (reply.kind) {
      case "error":
        throw reply.error;
      case "hang":
        await new Promise<void>((resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("interrotto")), { once: true });
          if (request.signal?.aborted) reject(new Error("interrotto"));
          setTimeout(resolve, 60_000).unref();
        });
        yield { type: "done", stopReason: "aborted" };
        return;
      case "empty":
        yield { type: "usage", usage: { inputTokens, outputTokens: 0 } };
        yield { type: "done", stopReason: "end_turn" };
        return;
      case "text":
        for (const word of reply.text.split(/(?<=\s)/)) yield { type: "text_delta", text: word };
        yield { type: "usage", usage: { inputTokens, outputTokens: Math.ceil(reply.text.length / 4) } };
        yield { type: "done", stopReason: "end_turn" };
        return;
      case "tools": {
        if (reply.text) yield { type: "text_delta", text: reply.text };
        for (const [i, c] of reply.calls.entries()) {
          const call: ContentToolCall = { type: "tool_call", id: `call_${this.calls}_${i}`, name: c.name, arguments: c.arguments };
          yield { type: "tool_call", call };
        }
        yield { type: "usage", usage: { inputTokens, outputTokens: 20 * reply.calls.length } };
        yield { type: "done", stopReason: "tool_use" };
        return;
      }
    }
  }
}

/** Copione semplice: risponde "eco: <ultimo testo utente o risultato di tool>". */
export function echoScript(): Script {
  return (request) => {
    const last = request.messages.at(-1);
    const text = last?.content
      .map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.content : ""))
      .join(" ")
      .trim();
    return { kind: "text", text: `eco: ${text}` };
  };
}
