/**
 * Tools for writing software: exact edits, patches, and a coding agent
 * (Claude Code or Codex) run on the project as a worker under Opifer's
 * governance.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { environmentFor, str } from "./native.js";
import type { NativeTool, ToolContext } from "./types.js";

export const editFileTool: NativeTool = {
  risk: "medium",
  definition: {
    name: "edit_file",
    description:
      "Replaces an exact piece of text in a file of the working directory with new text. The old text must appear exactly once (or use replace_all). Use it for precise changes; write_file rewrites a whole file.",
    inputSchema: {
      type: "object",
      required: ["path", "old_string", "new_string"],
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "The exact text to replace, with its indentation." },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default: exactly one)." },
      },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const file = str(args, "path");
    const oldText = String(args["old_string"] ?? "");
    const newText = String(args["new_string"] ?? "");
    if (!oldText) return { content: "old_string is empty", isError: true };
    const text = Buffer.from(await env.readFile(file)).toString("utf8");
    const count = text.split(oldText).length - 1;
    if (count === 0) return { content: `old_string not found in ${file}`, isError: true };
    if (count > 1 && !args["replace_all"]) return { content: `old_string appears ${count} times in ${file}: make it unique or set replace_all`, isError: true };
    const next = args["replace_all"] ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    await env.writeFile(file, Buffer.from(next, "utf8"));
    return { content: `Edited ${file}: ${count} replacement${count === 1 ? "" : "s"}` };
  },
};

export const applyPatchTool: NativeTool = {
  risk: "medium",
  definition: {
    name: "apply_patch",
    description: "Applies a unified diff (as produced by git diff) to the working directory. Fails without changing anything when a hunk does not apply.",
    inputSchema: {
      type: "object",
      required: ["patch"],
      properties: { patch: { type: "string", description: "The unified diff, with a/ and b/ prefixes or plain paths." } },
    },
  },
  async execute(args, context) {
    const env = await environmentFor(context);
    const patch = str(args, "patch");
    await env.writeFile(".opifer-patch.diff", Buffer.from(patch.endsWith("\n") ? patch : `${patch}\n`, "utf8"));
    const isGit = await env.run(["git", "rev-parse", "--is-inside-work-tree"], { timeoutMs: 10_000, signal: context.signal });
    const command = isGit.exitCode === 0 ? ["git", "apply", "--whitespace=nowarn", "--3way", ".opifer-patch.diff"] : ["patch", "-p1", "--batch", "-i", ".opifer-patch.diff"];
    const result = await env.run(command, { timeoutMs: 60_000, signal: context.signal });
    await env.run(["rm", "-f", ".opifer-patch.diff"], { timeoutMs: 5000 });
    if (result.exitCode !== 0) return { content: `The patch did not apply:\n${result.stderr || result.stdout}`.trim(), isError: true };
    return { content: `Patch applied.${result.stdout ? `\n${result.stdout.trim()}` : ""}` };
  },
};

export interface CoderOptions {
  /** Which coding agent runs: Claude Code (`claude`) or the Codex CLI (`codex`). */
  kind: "claude" | "codex";
  /** The binary; defaults to `claude` or `codex` on the PATH. */
  binary?: string;
  /** Turns the coding agent may take by itself (Claude Code); default 40. */
  maxTurns?: number;
  /** Runs at most this long (default 30 minutes). */
  timeoutMs?: number;
}

function runOnHost(file: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

/**
 * `run_coder`: hands a brief to Claude Code or Codex in the working directory and reports what changed.
 * The coding agent runs on the machine (it needs its own installation and sign-in), not in the sandbox;
 * its own usage is billed to its subscription, outside Opifer's budget, and the tool says so.
 */
export function coderTool(options: CoderOptions): NativeTool {
  const binary = options.binary ?? (options.kind === "claude" ? "claude" : "codex");
  const label = options.kind === "claude" ? "Claude Code" : "Codex";
  return {
    risk: "high",
    definition: {
      name: "run_coder",
      description: `Gives a coding brief to ${label}, which works in the current working directory (reads, edits, runs commands) and comes back with a summary. Use it for software work that takes many steps: a feature, a refactor, a bug with tests. Say what to build, where, and how to verify it; ask for a git commit at the end when the folder is a repository. Returns the summary and the git diff stat.`,
      inputSchema: {
        type: "object",
        required: ["brief"],
        properties: {
          brief: { type: "string", description: "What to do, in full: goal, constraints, files to look at, how to verify." },
          cwd: { type: "string", description: "Sub-folder of the working directory to work in (default: the working directory)." },
          max_turns: { type: "integer", minimum: 1, maximum: 200, description: `Turns ${label} may take (default ${options.maxTurns ?? 40}).` },
        },
      },
    },
    async execute(args, context: ToolContext) {
      const env = await environmentFor(context);
      const cwd = args["cwd"] ? env.resolve(String(args["cwd"])) : context.workdir;
      if (!existsSync(cwd)) return { content: `No such folder: ${cwd}`, isError: true };
      const brief = str(args, "brief");
      const maxTurns = typeof args["max_turns"] === "number" ? args["max_turns"] : (options.maxTurns ?? 40);
      const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
      const argv =
        options.kind === "claude"
          ? ["-p", brief, "--output-format", "json", "--max-turns", String(maxTurns), "--dangerously-skip-permissions"]
          : ["exec", "--full-auto", "--skip-git-repo-check", brief];
      const before = await env.run(["git", "rev-parse", "HEAD"], { timeoutMs: 10_000 }).catch(() => null);
      const result = await runOnHost(binary, argv, cwd, timeoutMs, context.signal);
      let summary = result.stdout.trim();
      let cost = "";
      if (options.kind === "claude") {
        try {
          const parsed = JSON.parse(result.stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number; subtype?: string };
          summary = parsed.result ?? summary;
          cost =
            parsed.total_cost_usd !== undefined
              ? ` (${parsed.num_turns ?? "?"} turns, ${parsed.total_cost_usd.toFixed(2)} USD on ${label}'s own account, outside Opifer's budget)`
              : "";
          if (parsed.is_error) return { content: `${label} stopped with an error${cost}:\n${summary}`, isError: true };
        } catch {
          // Not JSON: the raw output is the summary.
        }
      }
      if (result.code !== 0 && !summary) return { content: `${label} failed (exit ${result.code}):\n${result.stderr.slice(-4000)}`, isError: true };
      const stat = await env.run(["git", "diff", "--stat", before && before.exitCode === 0 ? `${before.stdout.trim()}` : "HEAD"], { timeoutMs: 10_000 }).catch(() => null);
      const changed = stat && stat.exitCode === 0 && stat.stdout.trim() ? `\n\nChanges (git diff --stat):\n${stat.stdout.trim()}` : "";
      return { content: `${label} finished${cost}.\n\n${summary.slice(0, 20_000)}${changed}` };
    },
  };
}
