/**
 * `o4r update`: a newer Opifer from npm, installed where this one is, and the
 * server restarted. From a repository checkout it says what to run instead.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareVersions, fetchLatestVersion } from "@opifer/server";
import { isPortOpen } from "../database.js";
import { readConfig, resolveHome } from "../home.js";
import { c, say } from "../output.js";
import { runDown, runUp } from "./up.js";

const run = promisify(execFile);

/** The version of this command line (its own package.json, which can be ahead of the core). */
export function cliVersion(): string {
  try {
    return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export type InstallKind = { kind: "npm"; prefix: string } | { kind: "repository"; root: string } | { kind: "unknown"; dir: string };

/** Where this CLI runs from: a global npm install (`<prefix>/lib/node_modules/@opifer/cli`) or the repository (`packages/cli/dist`). */
export function installedFrom(): InstallKind {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/dist/commands
  const pkg = path.resolve(here, "..", ".."); // …/@opifer/cli or …/packages/cli
  const marker = path.join("node_modules", "@opifer", "cli");
  if (pkg.endsWith(marker)) {
    const lib = pkg.slice(0, -marker.length - 1); // …/lib (posix) or the prefix itself (windows)
    return { kind: "npm", prefix: path.basename(lib) === "lib" ? path.dirname(lib) : lib };
  }
  if (pkg.endsWith(path.join("packages", "cli"))) return { kind: "repository", root: path.resolve(pkg, "..", "..") };
  return { kind: "unknown", dir: pkg };
}

export interface UpdateOptions {
  home?: string;
  /** Only say whether a newer version exists. */
  check?: boolean;
  /** Do not restart the server after the install. */
  noRestart?: boolean;
}

export async function runUpdate(options: UpdateOptions): Promise<void> {
  const current = cliVersion();
  const where = installedFrom();
  say.step(`Opifer ${c.bold(current)}`);
  const latest = await fetchLatestVersion();
  if (!latest) {
    say.warn("Could not reach the npm registry to look for a newer version (offline?)");
    if (options.check) return;
  } else if (compareVersions(latest, current) <= 0) {
    say.ok(`Up to date: ${latest} is the latest on npm`);
    return;
  } else {
    say.info(`Newer version on npm: ${c.bold(latest)}`);
    if (options.check) {
      say.info(`Update with ${c.cyan("o4r update")}`);
      return;
    }
  }

  if (where.kind === "repository") {
    say.info(`This Opifer runs from the repository at ${c.dim(where.root)}. Update it with:`);
    say.info(`  ${c.cyan("git pull --ff-only && pnpm install && pnpm build && pnpm o4r down && pnpm o4r up --detach")}`);
    return;
  }
  if (where.kind === "unknown") {
    say.warn(`Cannot tell how Opifer was installed (${where.dir}). Update it the way you installed it, then restart the server.`);
    return;
  }

  say.step(`Installing @opifer/cli@latest in ${c.dim(where.prefix)}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await run(npm, ["install", "-g", "@opifer/cli@latest"], {
      env: { ...process.env, npm_config_prefix: where.prefix, NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`npm install failed: ${error instanceof Error ? error.message.split("\n").slice(-3).join(" ") : String(error)}`);
  }
  const installed = await run(process.execPath, [path.join(where.prefix, "lib", "node_modules", "@opifer", "cli", "dist", "main.js"), "--version"])
    .then((r) => r.stdout.trim())
    .catch(() => "?");
  say.ok(`Installed ${c.bold(installed)}`);

  if (options.noRestart) {
    say.info("Restart the server to run it: o4r down && o4r up --detach (or restart the service)");
    return;
  }
  const home = resolveHome(options.home);
  const config = await readConfig(home);
  if (!config) return;
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  if (!(await isPortOpen(config.server.port, host))) {
    say.info("The server is not running: start it with o4r up --detach");
    return;
  }
  say.step("Restarting the server");
  await runDown({ ...(options.home ? { home: options.home } : {}) });
  // Under a service manager (systemd, launchd) the server comes back by itself; otherwise it is started here.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await isPortOpen(config.server.port, host)) {
      say.ok("The service manager restarted the server");
      return;
    }
  }
  await runUp({ ...(options.home ? { home: options.home } : {}), detach: true });
}
