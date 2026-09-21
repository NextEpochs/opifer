/**
 * Native core tools (M1): terminal, file read and write, file listing and
 * search, request for clarification. Few and fundamental: everything else
 * arrives via MCP or plugins.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { LocalEnvironment } from "../environments/local.js";
import { checkCommand } from "./safety.js";
import type { NativeTool, ToolContext } from "./types.js";

const environments = new Map<string, LocalEnvironment>();
let factory: () => LocalEnvironment = () => new LocalEnvironment();

/** Chooses how commands run (local process or a Docker container). Sessions already open keep their environment. */
export function useEnvironment(make: () => LocalEnvironment): void {
  factory = make;
  environments.clear();
}

export async function environmentFor(context: ToolContext): Promise<LocalEnvironment> {
  let env = environments.get(context.workdir);
  if (!env) {
    env = factory();
    await env.prepare(context.workdir);
    environments.set(context.workdir, env);
  }
  return env;
}

export function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing parameter "${key}"`);
  return value;
}

export const terminalTool: NativeTool = {
  risk: "high",
  definition: {
    name: "terminal",
    description: "Runs a shell command in the working directory and returns output and exit code. Use non-interactive commands.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "The command to run (sh -c)." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 1800, description: "Maximum time (default 120; builds and test suites may need more)." },
      },
    },
  },
  async execute(args, context) {
    const command = str(args, "command");
    const verdict = checkCommand(command);
    if (!verdict.allowed) {
      return { content: `Command refused: ${verdict.reason}. This pattern is always forbidden.`, isError: true };
    }
    const env = await environmentFor(context);
    const timeoutMs = typeof args["timeout_seconds"] === "number" ? args["timeout_seconds"] * 1000 : 120_000;
    // Git never prompts; a project clone leaves a credential helper in .opifer/askpass that answers with the bound token.
    const gitEnv: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: env.containerPath(".opifer/askpass"),
      GIT_AUTHOR_NAME: "Opifer agent",
      GIT_AUTHOR_EMAIL: "agents@opifer.dev",
      GIT_COMMITTER_NAME: "Opifer agent",
      GIT_COMMITTER_EMAIL: "agents@opifer.dev",
    };
    const result = await env.run(["sh", "-c", command], { timeoutMs, signal: context.signal, env: { ...gitEnv, ...(context.secrets ?? {}) } });
    const parts = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    parts.push(`[exit code ${result.exitCode}, ${result.durationMs} ms]`);
    return { content: parts.join("\n"), isError: result.exitCode !== 0 };
  },
};

export const readFileTool: NativeTool = {
  risk: "low",
  definition: {
    name: "read_file",
    description: "Reads a text file in the working directory. Returns the content with line numbers.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1, description: "First line to read (default 1)." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines (default 400)." },
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
    const tail = offset - 1 + limit < lines.length ? `\n[... ${lines.length - (offset - 1 + limit)} more lines ...]` : "";
    return { content: body + tail };
  },
};

export const writeFileTool: NativeTool = {
  risk: "medium",
  definition: {
    name: "write_file",
    description: "Writes (or overwrites) a text file in the working directory, creating missing folders.",
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
    return { content: `Wrote ${p} (${content.length} characters)` };
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
  risk: "low",
  definition: {
    name: "list_files",
    description: "Lists the files in the working directory (recursive, excluding node_modules, .git and dist).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Subfolder to start from (default the root)." }, limit: { type: "integer", minimum: 1 } },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const start = env.resolve(typeof args["path"] === "string" && args["path"] ? args["path"] : ".");
    const limit = typeof args["limit"] === "number" ? args["limit"] : 500;
    const out: string[] = [];
    await walk(context.workdir, start, out, limit);
    return { content: out.length ? out.join("\n") + (out.length >= limit ? "\n[... list truncated ...]" : "") : "(no files)" };
  },
};

export const searchFilesTool: NativeTool = {
  risk: "low",
  definition: {
    name: "search_files",
    description: "Searches a regular expression in the text files of the working directory. Returns file:line: text.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Subfolder (default the root)." },
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
    return { content: hits.length ? hits.join("\n") + (hits.length >= max ? "\n[... results truncated ...]" : "") : "(no results)" };
  },
};

export const askUserTool: NativeTool = {
  risk: "low",
  definition: {
    name: "ask_user",
    description: "Asks the person a question and stops the turn waiting for the answer. Use it when information is missing or an action is ambiguous.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: { question: { type: "string" } },
    },
  },
  async execute(args) {
    const question = str(args, "question");
    return { content: `Question asked to the person: ${question}`, endTurn: { stopReason: "clarification_requested" } };
  },
};

export const NATIVE_TOOLS: NativeTool[] = [terminalTool, readFileTool, writeFileTool, listFilesTool, searchFilesTool, askUserTool];
