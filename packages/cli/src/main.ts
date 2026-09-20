#!/usr/bin/env node
import { Command } from "commander";
import { OPIFER_VERSION } from "@opifer/core";
import { runChat } from "./commands/chat.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runDown, runUp } from "./commands/up.js";
import { say, setColor } from "./output.js";

const program = new Command();

program
  .name("o4r")
  .description("Opifer: agenti AI che lavorano, imparano e vengono governati come un'organizzazione.")
  .version(OPIFER_VERSION, "-v, --version")
  .option("--home <dir>", "cartella di Opifer (default: $OPIFER_HOME o ~/.opifer)")
  .option("--no-color", "disattiva i colori")
  .hook("preAction", (cmd) => {
    const opts = cmd.optsWithGlobals() as { color?: boolean };
    if (opts.color === false) setColor(false);
  });

program
  .command("init")
  .description("installazione guidata: database incorporato, migrazioni, prima azienda")
  .option("--company <nome>", "nome della prima azienda")
  .option("--host <indirizzo>", "indirizzo del server (default 127.0.0.1)")
  .option("--port <n>", "porta del server (default 4700)")
  .option("--db-port <n>", "porta del database incorporato (default 4701)")
  .option("--model <provider/modello>", "modello di default (es. anthropic/claude-sonnet-5)")
  .option("--local-url <url>", "endpoint compatibile OpenAI per modelli locali (es. http://127.0.0.1:11434/v1)")
  .action(async (opts: { company?: string; host?: string; port?: string; dbPort?: string; model?: string; localUrl?: string }) => {
    await runInit({ ...opts, ...homeOf(program) });
  });

program
  .command("up")
  .description("avvia database e server")
  .option("-d, --detach", "avvia in background")
  .action(async (opts: { detach?: boolean }) => {
    await runUp({ ...opts, ...homeOf(program) });
  });

program
  .command("down")
  .description("ferma il server avviato in background")
  .action(async () => {
    await runDown(homeOf(program));
  });

program
  .command("chat [agente]")
  .description("conversazione da terminale con un agente (richiede il server avviato)")
  .option("--company <nome>", "azienda (default: la prima)")
  .option("--resume <sessione>", "riprende una sessione esistente")
  .option("--model <provider/modello>", "modello per la nuova sessione")
  .action(async (agente: string | undefined, opts: { company?: string; resume?: string; model?: string }) => {
    await runChat({ ...(agente ? { agent: agente } : {}), ...opts, ...homeOf(program) });
  });

program
  .command("doctor")
  .description("diagnosi dell'installazione")
  .action(async () => {
    await runDoctor(homeOf(program));
  });

const migrate = program.command("migrate").description("migrazioni dello schema");
migrate
  .command("status")
  .description("mostra migrazioni applicate e in attesa")
  .action(async () => runMigrate("status", homeOf(program)));
migrate
  .command("up")
  .description("applica le migrazioni in attesa")
  .option("--to <versione>", "fino alla versione indicata")
  .action(async (opts: { to?: string }) => runMigrate("up", { ...opts, ...homeOf(program) }));
migrate
  .command("down")
  .description("ritira le ultime migrazioni")
  .option("--steps <n>", "quante ritirare (default 1)")
  .option("--to <versione>", "torna alla versione indicata (0 = schema vuoto)")
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
