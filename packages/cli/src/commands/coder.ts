/**
 * Which coding agent is installed on this machine: Claude Code (`claude`) or
 * the Codex CLI (`codex`). Found on the PATH at start unless the configuration
 * names one (`coder` in config.json; `null` turns run_coder off).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CoderOptions } from "@opifer/runtime";

const run = promisify(execFile);

async function onPath(binary: string): Promise<boolean> {
  try {
    await run(process.platform === "win32" ? "where" : "which", [binary]);
    return true;
  } catch {
    return false;
  }
}

/** Claude Code first, then Codex; null when neither is installed. */
export async function detectCoder(): Promise<CoderOptions | null> {
  if (await onPath("claude")) return { kind: "claude" };
  if (await onPath("codex")) return { kind: "codex" };
  return null;
}
