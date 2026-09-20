/**
 * Context management (spec 5.4): two lines of defence against a context that
 * grows past what the model can hold, and one rule — the only change ever made
 * to a session's past is a compression, done at a threshold and traced.
 *
 * First line: old tool results are pruned in the request view, without a model
 * call and without touching the stored messages.
 *
 * Second line: when the estimated input passes the threshold (half the model's
 * window by default), the older messages are summarised by the auxiliary model
 * — the session's own model in the MVP — and the session records from which
 * message the summary stands in for the originals. A deterministic outline
 * takes over when the model fails, so a turn never dies of a full context.
 */

import type { ContentPart, Message, ModelProvider, Usage } from "@opifer/sdk";
import type { StoredMessage } from "./types.js";

export interface ContextOptions {
  /** Share of the model's context window at which the second line runs (default 0.5). */
  compressAt: number;
  /** Tool results older than this many messages from the end are pruned to this many characters. */
  pruneAfterMessages: number;
  pruneKeepChars: number;
  /** Messages kept verbatim at the tail when summarising. */
  keepRecent: number;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = { compressAt: 0.5, pruneAfterMessages: 12, pruneKeepChars: 400, keepRecent: 8 };

/** Rough token estimate: four characters per token. */
export function estimateTokens(system: string, messages: Message[]): number {
  const chars = system.length + messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
  return Math.ceil(chars / 4);
}

/** First line: a view of the history where old, long tool results are shortened. The stored messages do not change. */
export function pruneToolResults(history: StoredMessage[], options: ContextOptions = DEFAULT_CONTEXT_OPTIONS): { messages: Message[]; prunedChars: number } {
  const cutoff = history.length - options.pruneAfterMessages;
  let prunedChars = 0;
  const messages = history.map((m, index): Message => {
    if (m.role !== "tool" || index >= cutoff) return { role: m.role, content: m.content };
    const content = m.content.map((part): ContentPart => {
      if (part.type !== "tool_result" || part.content.length <= options.pruneKeepChars) return part;
      prunedChars += part.content.length - options.pruneKeepChars;
      return {
        ...part,
        content: `${part.content.slice(0, options.pruneKeepChars)}\n[… ${part.content.length - options.pruneKeepChars} characters pruned from the context; run the tool again if you need them]`,
      };
    });
    return { role: m.role, content };
  });
  return { messages, prunedChars };
}

/**
 * Where to cut for a summary: the last message boundary, at least `keepRecent`
 * messages from the end, such that the first kept message is a user message
 * (so the summary can be folded into it and role alternation holds).
 * Returns the index of the first kept message, or -1 when there is nothing to cut.
 */
export function cutPoint(history: StoredMessage[], keepRecent: number): number {
  for (let i = history.length - keepRecent; i > 0; i--) {
    if (history[i]!.role === "user") return i;
  }
  return -1;
}

/** The summary folded into the first kept user message: the model sees one coherent history. */
export function foldSummary(messages: Message[], summary: string | null): Message[] {
  if (!summary || messages.length === 0) return messages;
  const [first, ...rest] = messages;
  const preface: ContentPart = {
    type: "text",
    text: `[Summary of the earlier conversation — the details were compressed]\n${summary}\n[End of summary. The conversation continues:]`,
  };
  if (first!.role === "user") return [{ role: "user", content: [preface, ...first!.content] }, ...rest];
  return [{ role: "user", content: [preface] }, first!, ...rest];
}

const SUMMARY_PROMPT = `You compress the earlier part of a working conversation between a person and an AI agent so the agent can continue without it. Write a structured summary, in the language of the conversation, with these headings: Goal (what the person wants), Done so far (facts, results, numbers, file names, decisions — keep every concrete value), Open (what is still to do, questions pending), Constraints (rules, preferences, things to avoid). Be precise and compact: no preamble, no commentary, at most 500 words.`;

/** Second line, model path: one call to the auxiliary model over a transcript of the messages being compressed. */
export async function summariseWithModel(
  provider: ModelProvider,
  model: string,
  previousSummary: string | null,
  messages: StoredMessage[],
  signal?: AbortSignal,
): Promise<{ summary: string; usage: Usage | null }> {
  const transcript = transcriptOf(messages, 60_000);
  const text = `${previousSummary ? `Previous summary:\n${previousSummary}\n\n` : ""}Conversation to compress:\n${transcript}`;
  let out = "";
  let usage: Usage | null = null;
  for await (const event of provider.complete({
    model,
    system: SUMMARY_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    maxOutputTokens: 1500,
    ...(signal ? { signal } : {}),
  })) {
    if (event.type === "text_delta") out += event.text;
    if (event.type === "usage") usage = event.usage;
  }
  if (!out.trim()) throw new Error("empty summary");
  return { summary: out.trim(), usage };
}

/** Second line, fallback: an outline built without a model — asks, tool calls and answers, in order. */
export function summariseDeterministically(previousSummary: string | null, messages: StoredMessage[]): string {
  const lines: string[] = [];
  if (previousSummary) lines.push(`Earlier: ${previousSummary.slice(0, 1500)}`);
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text" && part.text.trim()) lines.push(`${m.role === "user" ? "Person" : "Agent"}: ${part.text.trim().slice(0, 300)}`);
      else if (part.type === "tool_call") lines.push(`Agent called ${part.name}(${JSON.stringify(part.arguments).slice(0, 160)})`);
      else if (part.type === "tool_result") lines.push(`${part.isError ? "Failed" : "Result"}: ${part.content.trim().slice(0, 200)}`);
    }
  }
  return lines.join("\n").slice(0, 8000);
}

function transcriptOf(messages: StoredMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text") lines.push(`${m.role.toUpperCase()}: ${part.text}`);
      else if (part.type === "tool_call") lines.push(`TOOL CALL ${part.name}: ${JSON.stringify(part.arguments)}`);
      else if (part.type === "tool_result") lines.push(`TOOL RESULT${part.isError ? " (error)" : ""}: ${part.content.slice(0, 2000)}`);
    }
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[… transcript truncated]` : text;
}
