/**
 * Local execution environment: commands run on the Opifer machine, in the
 * session's working directory. It is the backend of the trusted local mode;
 * Docker (M5) becomes the default, with restricted network.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, ExecutionEnvironment } from "@opifer/sdk";

const OUTPUT_CAP = 64 * 1024;

function capped(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n[... output truncated at ${OUTPUT_CAP} characters ...]` : text;
}

export class LocalEnvironment implements ExecutionEnvironment {
  readonly id: string = "local";
  private workdir = process.cwd();

  async prepare(workdir: string): Promise<void> {
    await mkdir(workdir, { recursive: true });
    this.workdir = workdir;
  }

  resolve(p: string): string {
    const full = path.resolve(this.workdir, p);
    if (full !== this.workdir && !full.startsWith(this.workdir + path.sep)) {
      throw new Error(`Path outside the working directory: ${p}`);
    }
    return full;
  }

  run(command: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<CommandResult> {
    const started = Date.now();
    const cwd = options.cwd ? this.resolve(options.cwd) : this.workdir;
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise((resolve) => {
      const [file, ...args] = command;
      const child = spawn(file!, args, {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (exitCode: number, note?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout: capped(stdout), stderr: capped(note ? `${stderr}\n${note}` : stderr), durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(124, `[command interrupted after ${timeoutMs} ms]`);
      }, timeoutMs);
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(130, "[command interrupted by the operator]");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_CAP * 2) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_CAP * 2) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish(127, error.message));
      child.on("close", (code) => finish(code ?? 1));
    });
  }

  async readFile(p: string): Promise<Uint8Array> {
    return readFile(this.resolve(p));
  }

  async writeFile(p: string, content: Uint8Array): Promise<void> {
    const full = this.resolve(p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async dispose(): Promise<void> {
    // nothing to release locally
  }
}
