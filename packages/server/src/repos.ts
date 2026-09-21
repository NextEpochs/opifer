/**
 * Projects that are git repositories: the clone into the project's working
 * folder, and the credential helper that lets agents push with a token kept
 * as a company secret (never written into the repository's configuration).
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Relative path, inside a working folder, of the helper git calls for a password. */
export const ASKPASS_RELATIVE = path.join(".opifer", "askpass");

/**
 * Writes the helper that answers git's password prompt with the GITHUB_TOKEN (or GIT_TOKEN) of the
 * environment: the token reaches the command as a bound secret, and only then.
 */
export async function writeAskpass(workdir: string): Promise<string> {
  const file = path.join(workdir, ASKPASS_RELATIVE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    '#!/bin/sh\n# Opifer: git asks here for a username or a password; the token is a bound secret of the agent.\ncase "$1" in\n  *sername*) echo "${GIT_USERNAME:-x-access-token}" ;;\n  *) echo "${GITHUB_TOKEN:-${GIT_TOKEN:-}}" ;;\nesac\n',
    "utf8",
  );
  await chmod(file, 0o755);
  return file;
}

export interface CloneResult {
  ok: boolean;
  detail: string;
}

/** Clones `repoUrl` (branch optional) into `workdir`; a token, when given, is used through the askpass helper and never stored. */
export async function cloneRepository(input: { repoUrl: string; branch?: string | null; workdir: string; token?: string | null; timeoutMs?: number }): Promise<CloneResult> {
  const { repoUrl, workdir } = input;
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(repoUrl)) return { ok: false, detail: "the repository URL must start with https://, ssh://, git@ or file://" };
  await mkdir(path.dirname(workdir), { recursive: true });
  const askpass = await writeAskpassTemp(workdir);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    ...(input.token ? { GITHUB_TOKEN: input.token } : {}),
  };
  const args = ["clone", "--quiet", ...(input.branch ? ["--branch", input.branch] : []), repoUrl, workdir];
  try {
    await run("git", args, { env, timeout: input.timeoutMs ?? 180_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? (error as Error & { stderr?: string }).stderr || error.message : String(error);
    return { ok: false, detail: message.replace(/\s+/g, " ").trim().slice(0, 400) };
  }
  await writeAskpass(workdir);
  const branch = await run("git", ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"])
    .then((r) => r.stdout.trim())
    .catch(() => input.branch ?? "");
  return { ok: true, detail: `cloned${branch ? ` on ${branch}` : ""}` };
}

/** The askpass helper must exist before the clone creates the folder: it is written next to it, then moved inside. */
async function writeAskpassTemp(workdir: string): Promise<string> {
  const dir = `${workdir}.opifer-clone`;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "askpass");
  await writeFile(file, '#!/bin/sh\ncase "$1" in\n  *sername*) echo "${GIT_USERNAME:-x-access-token}" ;;\n  *) echo "${GITHUB_TOKEN:-${GIT_TOKEN:-}}" ;;\nesac\n', "utf8");
  await chmod(file, 0o755);
  return file;
}
