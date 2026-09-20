/**
 * Assemblaggio del prompt di sistema, in ordine fisso:
 * identità e ruolo, posizione nell'organigramma, istantanea della memoria,
 * indice delle skill, regole di governo, contesto del task.
 *
 * Il risultato è calcolato una volta per sessione e conservato: è il prefisso
 * stabile su cui poggia la cache del provider.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PromptAgent {
  name: string;
  role: string;
  /** Nome del responsabile (agente o persona), se esiste. */
  reportsTo: string | null;
  /** Nomi degli agenti che rispondono a questo. */
  reports: string[];
}

export interface PromptCompany {
  name: string;
  mission: string | null;
}

export interface PromptInput {
  agent: PromptAgent;
  company: PromptCompany;
  /** Istantanea della memoria (M4); vuota in M1. */
  memorySnapshot?: string;
  /** Indice delle skill disponibili (M4); vuoto in M1. */
  skillsIndex?: Array<{ name: string; description: string }>;
  /** Regole di governo dell'azienda, già in forma di testo. */
  governanceRules?: string[];
  /** Contesto del task con la catena degli obiettivi (M3). */
  taskContext?: string;
  /** File di contesto del progetto (per esempio AGENTS.md), già letti. */
  contextFiles?: Array<{ name: string; content: string }>;
  locale?: "it" | "en";
}

export const CONTEXT_FILE_NAMES = ["AGENTS.md", "OPIFER.md"] as const;
/** Tetto di dimensione per i file di contesto, in caratteri. */
export const CONTEXT_FILE_MAX_CHARS = 24_000;

const DEFAULT_RULES = [
  "Lavori per conto dell'azienda e dentro i limiti di budget, permessi e approvazioni stabiliti dall'organizzazione.",
  "Usa i tool a disposizione per agire; non fingere di aver eseguito un'azione.",
  "Se un'azione è rischiosa o ambigua, chiedi un chiarimento invece di procedere.",
  "Un lavoro è finito solo quando il risultato è verificabile: un artefatto, un test, una decisione.",
  "Non inserire mai credenziali o segreti nelle risposte.",
];

export function assembleSystemPrompt(input: PromptInput): string {
  const sections: string[] = [];

  sections.push(
    [
      `# Identità`,
      `Sei ${input.agent.name}, un agente dell'azienda ${input.company.name}.`,
      input.agent.role ? `Il tuo ruolo: ${input.agent.role}` : `Il tuo ruolo non è ancora definito: chiedilo a chi ti coordina.`,
      input.company.mission ? `Missione dell'azienda: ${input.company.mission}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  sections.push(
    [
      `# Organigramma`,
      input.agent.reportsTo ? `Rispondi a: ${input.agent.reportsTo}.` : `Sei alla radice dell'organigramma: rispondi direttamente alle persone dell'azienda.`,
      input.agent.reports.length > 0 ? `Coordini: ${input.agent.reports.join(", ")}.` : `Non coordini altri agenti.`,
      `Puoi delegare solo verso il basso e chiedere aiuto verso l'alto.`,
    ].join("\n"),
  );

  sections.push(`# Memoria\n${input.memorySnapshot?.trim() || "Nessuna memoria salvata per ora."}`);

  const skills = input.skillsIndex ?? [];
  sections.push(
    `# Skill disponibili\n` +
      (skills.length > 0 ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "Nessuna skill disponibile per ora."),
  );

  sections.push(`# Regole di governo\n` + [...DEFAULT_RULES, ...(input.governanceRules ?? [])].map((r) => `- ${r}`).join("\n"));

  sections.push(`# Contesto del lavoro\n${input.taskContext?.trim() || "Conversazione diretta con una persona dell'azienda."}`);

  for (const file of input.contextFiles ?? []) {
    const content = file.content.length > CONTEXT_FILE_MAX_CHARS ? `${file.content.slice(0, CONTEXT_FILE_MAX_CHARS)}\n[... troncato ...]` : file.content;
    sections.push(`# File di contesto: ${file.name}\n${content}`);
  }

  if (input.locale === "en") {
    sections.push(`# Language\nAnswer in English unless the person writes in another language.`);
  } else {
    sections.push(`# Lingua\nRispondi in italiano, salvo che la persona scriva in un'altra lingua.`);
  }

  return sections.join("\n\n");
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
}

/** Legge i file di contesto presenti nella cartella di lavoro, se esistono. */
export async function loadContextFiles(workdir: string | null): Promise<Array<{ name: string; content: string }>> {
  if (!workdir) return [];
  const files: Array<{ name: string; content: string }> = [];
  for (const name of CONTEXT_FILE_NAMES) {
    try {
      const content = await readFile(path.join(workdir, name), "utf8");
      files.push({ name, content });
    } catch {
      // assente: va bene
    }
  }
  return files;
}
