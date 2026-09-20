/**
 * Tool nativi del core (M1): terminale, lettura e scrittura file, elenco e
 * ricerca nei file, richiesta di chiarimento. Pochi e fondamentali: tutto il
 * resto arriva via MCP o plugin.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { LocalEnvironment } from "../environments/local.js";
import { checkCommand } from "./safety.js";
import type { NativeTool, ToolContext } from "./types.js";

const environments = new Map<string, LocalEnvironment>();

async function environmentFor(context: ToolContext): Promise<LocalEnvironment> {
  let env = environments.get(context.workdir);
  if (!env) {
    env = new LocalEnvironment();
    await env.prepare(context.workdir);
    environments.set(context.workdir, env);
  }
  return env;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`parametro "${key}" mancante`);
  return value;
}

export const terminalTool: NativeTool = {
  risk: "alto",
  definition: {
    name: "terminal",
    description: "Esegue un comando di shell nella cartella di lavoro e restituisce output ed exit code. Usa comandi non interattivi.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Il comando da eseguire (sh -c)." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Tempo massimo (default 120)." },
      },
    },
  },
  async execute(args, context) {
    const command = str(args, "command");
    const verdict = checkCommand(command);
    if (!verdict.allowed) {
      return { content: `Comando rifiutato: ${verdict.reason}. Questo pattern è sempre vietato.`, isError: true };
    }
    const env = await environmentFor(context);
    const timeoutMs = typeof args["timeout_seconds"] === "number" ? args["timeout_seconds"] * 1000 : 120_000;
    const result = await env.run(["sh", "-c", command], { timeoutMs, signal: context.signal });
    const parts = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    parts.push(`[exit code ${result.exitCode}, ${result.durationMs} ms]`);
    return { content: parts.join("\n"), isError: result.exitCode !== 0 };
  },
};

export const readFileTool: NativeTool = {
  risk: "basso",
  definition: {
    name: "read_file",
    description: "Legge un file di testo nella cartella di lavoro. Restituisce il contenuto con i numeri di riga.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1, description: "Prima riga da leggere (default 1)." },
        limit: { type: "integer", minimum: 1, description: "Numero massimo di righe (default 400)." },
      },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const text = Buffer.from(await env.readFile(str(args, "path"))).toString("utf8");
    const lines = text.split("\n");
    const offset = typeof args["offset"] === "number" ? Math.max(1, args["offset"]) : 1;
    const limit = typeof args["limit"] === "number" ? args["limit"] : 400;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const body = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
    const tail = offset - 1 + limit < lines.length ? `\n[... altre ${lines.length - (offset - 1 + limit)} righe ...]` : "";
    return { content: body + tail };
  },
};

export const writeFileTool: NativeTool = {
  risk: "medio",
  definition: {
    name: "write_file",
    description: "Scrive (o sovrascrive) un file di testo nella cartella di lavoro, creando le cartelle mancanti.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const p = str(args, "path");
    const content = typeof args["content"] === "string" ? args["content"] : "";
    await env.writeFile(p, Buffer.from(content, "utf8"));
    return { content: `Scritto ${p} (${content.length} caratteri)` };
  },
};

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out, limit);
    else out.push(path.relative(root, full));
  }
}

export const listFilesTool: NativeTool = {
  risk: "basso",
  definition: {
    name: "list_files",
    description: "Elenca i file nella cartella di lavoro (ricorsivo, esclusi node_modules, .git e dist).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Sottocartella da cui partire (default la radice)." }, limit: { type: "integer", minimum: 1 } },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const start = env.resolve(typeof args["path"] === "string" && args["path"] ? args["path"] : ".");
    const limit = typeof args["limit"] === "number" ? args["limit"] : 500;
    const out: string[] = [];
    await walk(context.workdir, start, out, limit);
    return { content: out.length ? out.join("\n") + (out.length >= limit ? "\n[... elenco troncato ...]" : "") : "(nessun file)" };
  },
};

export const searchFilesTool: NativeTool = {
  risk: "basso",
  definition: {
    name: "search_files",
    description: "Cerca un'espressione regolare nei file di testo della cartella di lavoro. Restituisce file:riga: testo.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Sottocartella (default la radice)." },
        max_results: { type: "integer", minimum: 1 },
      },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const regex = new RegExp(str(args, "pattern"));
    const start = env.resolve(typeof args["path"] === "string" && args["path"] ? args["path"] : ".");
    const max = typeof args["max_results"] === "number" ? args["max_results"] : 200;
    const files: string[] = [];
    await walk(context.workdir, start, files, 5000);
    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= max) break;
      const full = path.join(context.workdir, rel);
      const info = await stat(full).catch(() => null);
      if (!info || info.size > 2 * 1024 * 1024) continue;
      const text = Buffer.from(await env.readFile(rel)).toString("utf8");
      if (text.includes("\u0000")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (regex.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
      }
    }
    return { content: hits.length ? hits.join("\n") + (hits.length >= max ? "\n[... risultati troncati ...]" : "") : "(nessun risultato)" };
  },
};

export const askUserTool: NativeTool = {
  risk: "basso",
  definition: {
    name: "ask_user",
    description: "Pone una domanda alla persona e ferma il turno in attesa della risposta. Usalo quando un'informazione manca o un'azione è ambigua.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: { question: { type: "string" } },
    },
  },
  async execute(args) {
    const question = str(args, "question");
    return { content: `Domanda posta alla persona: ${question}`, endTurn: { stopReason: "chiarimento_richiesto" } };
  },
};

export const NATIVE_TOOLS: NativeTool[] = [terminalTool, readFileTool, writeFileTool, listFilesTool, searchFilesTool, askUserTool];
