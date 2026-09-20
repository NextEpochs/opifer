/**
 * Docker execution environment: commands run in a throwaway container with
 * the working directory mounted at /work and no network unless allowed.
 * Files are read and written on the host side of the same folder, which is
 * the only thing that persists between two commands.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandResult } from "@opifer/sdk";
import { LocalEnvironment } from "./local.js";

const run = promisify(execFile);

export interface DockerOptions {
  image?: string;
  /** Docker network: "none" (default) isolates the container; "bridge" allows outbound traffic. */
  network?: "none" | "bridge" | string;
  /** Extra arguments for `docker run` (memory limits, volumes…). */
  extraArgs?: string[];
  /** The docker binary. */
  binary?: string;
  /**
   * The user inside the container (`uid:gid`). By default, on Linux, the user running the server, so that files written
   * under /work belong to it on the host; elsewhere Docker maps the ownership itself. `"root"` keeps the image's default.
   */
  user?: string;
}

function defaultUser(): string | undefined {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
  const uid = process.getuid();
  return uid === 0 ? undefined : `${uid}:${process.getgid()}`;
}

export const DEFAULT_IMAGE = "node:22-bookworm-slim";

/** Whether Docker is usable on this machine. */
export async function dockerAvailable(binary = "docker"): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await run(binary, ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    return { ok: true, detail: `Docker ${stdout.trim()}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

export class DockerEnvironment extends LocalEnvironment {
  override readonly id = "docker";
  private readonly image: string;
  private readonly network: string;
  private readonly extraArgs: string[];
  private readonly binary: string;
  private readonly user: string | undefined;

  constructor(options: DockerOptions = {}) {
    super();
    this.image = options.image ?? DEFAULT_IMAGE;
    this.network = options.network ?? "none";
    this.extraArgs = options.extraArgs ?? [];
    this.binary = options.binary ?? "docker";
    this.user = options.user === "root" ? undefined : (options.user ?? defaultUser());
  }

  override run(command: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<CommandResult> {
    const workdir = this.resolve(".");
    const cwd = options.cwd ? `/work/${options.cwd.replace(/^\.?\//, "")}` : "/work";
    const args = ["run", "--rm", "--network", this.network, "-v", `${workdir}:/work`, "-w", cwd, "--init"];
    for (const [k, v] of Object.entries(options.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(...this.extraArgs, this.image, ...command);
    // The host-side runner spawns docker itself; the container gets the timeout and the abort.
    return super.run([this.binary, ...args], {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}
