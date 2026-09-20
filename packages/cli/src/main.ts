#!/usr/bin/env node
import { Command } from "commander";
import { OPIFER_VERSION } from "@opifer/core";
import { runChat } from "./commands/chat.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runDown, runUp } from "./commands/up.js";
import { say, setColor } from "./output.js";

const program = new Command();

program
  .name("o4r")
  .description("Opifer: AI agents that work, learn and are governed like an organisation.")
  .version(OPIFER_VERSION, "-v, --version")
  .option("--home <dir>", "Opifer folder (default: $OPIFER_HOME or ~/.opifer)")
  .option("--no-color", "disable colours")
  .hook("preAction", (cmd) => {
    const opts = cmd.optsWithGlobals() as { color?: boolean };
    if (opts.color === false) setColor(false);
  });

program
  .command("init")
  .description("guided installation: embedded database, migrations, first company")
  .option("--company <name>", "name of the first company")
  .option("--host <address>", "server address (default 127.0.0.1)")
  .option("--port <n>", "server port (default 4700)")
  .option("--db-port <n>", "embedded database port (default 4701)")
  .option("--model <provider/model>", "default model (e.g. anthropic/claude-sonnet-5)")
  .option("--local-url <url>", "OpenAI-compatible endpoint for local models (e.g. http://127.0.0.1:11434/v1)")
  .action(async (opts: { company?: string; host?: string; port?: string; dbPort?: string; model?: string; localUrl?: string }) => {
    await runInit({ ...opts, ...homeOf(program) });
  });

program
  .command("up")
  .description("start database and server")
  .option("-d, --detach", "start in the background")
  .action(async (opts: { detach?: boolean }) => {
    await runUp({ ...opts, ...homeOf(program) });
  });

program
  .command("down")
  .description("stop the server started in the background")
  .action(async () => {
    await runDown(homeOf(program));
  });

program
  .command("chat [agent]")
  .description("terminal conversation with an agent (requires the server to be running)")
  .option("--company <name>", "company (default: the first one)")
  .option("--resume <session>", "resume an existing session")
  .option("--model <provider/model>", "model for the new session")
  .action(async (agent: string | undefined, opts: { company?: string; resume?: string; model?: string }) => {
    await runChat({ ...(agent ? { agent } : {}), ...opts, ...homeOf(program) });
  });

program
  .command("login <provider>")
  .description("sign in to a provider account (chatgpt: use a ChatGPT subscription instead of an API key)")
  .option("--manual", "paste the redirect URL by hand instead of using the local callback (headless machines)")
  .option("--no-browser", "print the URL without opening a browser")
  .action(async (provider: string, opts: { manual?: boolean; browser?: boolean }) => {
    await runLogin(provider, { ...(opts.manual ? { manual: true } : {}), ...(opts.browser === false ? { noBrowser: true } : {}), ...homeOf(program) });
  });

program
  .command("logout <provider>")
  .description("remove stored sign-in credentials for a provider")
  .action(async (provider: string) => {
    await runLogout(provider, homeOf(program));
  });

program
  .command("doctor")
  .description("diagnose the installation")
  .action(async () => {
    await runDoctor(homeOf(program));
  });

const migrate = program.command("migrate").description("schema migrations");
migrate
  .command("status")
  .description("show applied and pending migrations")
  .action(async () => runMigrate("status", homeOf(program)));
migrate
  .command("up")
  .description("apply the pending migrations")
  .option("--to <version>", "up to the given version")
  .action(async (opts: { to?: string }) => runMigrate("up", { ...opts, ...homeOf(program) }));
migrate
  .command("down")
  .description("roll back the latest migrations")
  .option("--steps <n>", "how many to roll back (default 1)")
  .option("--to <version>", "go back to the given version (0 = empty schema)")
  .action(async (opts: { steps?: string; to?: string }) => runMigrate("down", { ...opts, ...homeOf(program) }));

function homeOf(cmd: Command): { home?: string } {
  const home = (cmd.opts() as { home?: string }).home;
  return home ? { home } : {};
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  say.fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
