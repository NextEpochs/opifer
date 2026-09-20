/**
 * System prompt assembly, in a fixed order:
 * identity and role, position in the org chart, memory snapshot,
 * skills index, governance rules, task context.
 *
 * The result is computed once per session and stored: it is the stable
 * prefix the provider cache relies on.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PromptAgent {
  name: string;
  role: string;
  /** Name of the manager (agent or person), if any. */
  reportsTo: string | null;
  /** Names of the agents reporting to this one. */
  reports: string[];
}

export interface PromptCompany {
  name: string;
  mission: string | null;
}

export interface PromptInput {
  agent: PromptAgent;
  company: PromptCompany;
  /** Memory snapshot (M4); empty in M1. */
  memorySnapshot?: string;
  /** Index of the available skills (M4); empty in M1. */
  skillsIndex?: Array<{ name: string; description: string }>;
  /** Company governance rules, already in text form. */
  governanceRules?: string[];
  /** Task context with the chain of goals (M3). */
  taskContext?: string;
  /** Project context files (for example AGENTS.md), already read. */
  contextFiles?: Array<{ name: string; content: string }>;
  locale?: "it" | "en";
}

export const CONTEXT_FILE_NAMES = ["AGENTS.md", "OPIFER.md"] as const;
/** Size cap for context files, in characters. */
export const CONTEXT_FILE_MAX_CHARS = 24_000;

const DEFAULT_RULES = [
  "You work on behalf of the company and within the budget, permission and approval limits set by the organization.",
  "Use the available tools to act; never pretend to have performed an action.",
  "If an action is risky or ambiguous, ask for clarification instead of proceeding.",
  "A job is done only when the result is verifiable: an artifact, a test, a decision.",
  "Never put credentials or secrets in your answers.",
];

export function assembleSystemPrompt(input: PromptInput): string {
  const sections: string[] = [];

  sections.push(
    [
      `# Identity`,
      `You are ${input.agent.name}, an agent of the company ${input.company.name}.`,
      input.agent.role ? `Your role: ${input.agent.role}` : `Your role is not defined yet: ask whoever coordinates you.`,
      input.company.mission ? `Company mission: ${input.company.mission}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  sections.push(
    [
      `# Org chart`,
      input.agent.reportsTo ? `You report to: ${input.agent.reportsTo}.` : `You are at the root of the org chart: you report directly to the people of the company.`,
      input.agent.reports.length > 0 ? `You coordinate: ${input.agent.reports.join(", ")}.` : `You do not coordinate other agents.`,
      `You can only delegate downwards and ask for help upwards.`,
    ].join("\n"),
  );

  sections.push(`# Memory\n${input.memorySnapshot?.trim() || "No memory saved yet."}`);

  const skills = input.skillsIndex ?? [];
  sections.push(`# Available skills\n` + (skills.length > 0 ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "No skills available yet."));

  sections.push(`# Governance rules\n` + [...DEFAULT_RULES, ...(input.governanceRules ?? [])].map((r) => `- ${r}`).join("\n"));

  sections.push(`# Work context\n${input.taskContext?.trim() || "Direct conversation with a person of the company."}`);

  for (const file of input.contextFiles ?? []) {
    const content = file.content.length > CONTEXT_FILE_MAX_CHARS ? `${file.content.slice(0, CONTEXT_FILE_MAX_CHARS)}\n[... truncated ...]` : file.content;
    sections.push(`# Context file: ${file.name}\n${content}`);
  }

  if (input.locale === "it") {
    sections.push(`# Language\nAnswer in Italian unless the person writes in another language.`);
  } else {
    sections.push(`# Language\nAnswer in English unless the person writes in another language.`);
  }

  return sections.join("\n\n");
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
}

/** Reads the context files present in the working directory, if any. */
export async function loadContextFiles(workdir: string | null): Promise<Array<{ name: string; content: string }>> {
  if (!workdir) return [];
  const files: Array<{ name: string; content: string }> = [];
  for (const name of CONTEXT_FILE_NAMES) {
    try {
      const content = await readFile(path.join(workdir, name), "utf8");
      files.push({ name, content });
    } catch {
      // absent: that is fine
    }
  }
  return files;
}
