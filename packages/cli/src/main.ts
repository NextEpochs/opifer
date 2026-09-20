#!/usr/bin/env node
import { Command } from "commander";
import { OPIFER_VERSION } from "@opifer/core";
import { runChat } from "./commands/chat.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runDown, runUp } from "./commands/up.js";
import {
  runApprovalDecide,
  runApprovalsList,
  runBudgetList,
  runBudgetRemove,
  runBudgetSet,
  runCosts,
  runPolicyList,
  runPolicyRemove,
  runPolicySet,
  runSecretBind,
  runSecretList,
  runSecretRemove,
  runSecretSet,
  runSecretUnbind,
} from "./commands/govern.js";
import { runTaskAction, runTaskAssign, runTaskComment, runTaskCreate, runTaskList, runTaskShow } from "./commands/task.js";
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

const budget = program.command("budget").description("spending caps (the most restrictive applicable cap wins)");
budget
  .command("list", { isDefault: true })
  .description("show the budgets of the company")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runBudgetList({ ...opts, ...homeOf(program) }));
budget
  .command("set")
  .description("set a cap for the company or one agent")
  .requiredOption("--cap <amount>", "cap amount")
  .option("--agent <name>", "cap one agent instead of the whole company")
  .option("--window <monthly|daily|lifetime>", "window (default monthly)")
  .option("--currency <EUR|USD>", "currency (default EUR)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { cap: string; agent?: string; window?: string; currency?: string; company?: string }) => runBudgetSet({ ...opts, ...homeOf(program) }));
budget
  .command("remove <id>")
  .description("remove a budget by id")
  .option("--company <name>", "company (default: the first one)")
  .action(async (id: string, opts: { company?: string }) => runBudgetRemove({ id, ...opts, ...homeOf(program) }));

program
  .command("costs")
  .description("spending by agent and model")
  .option("--all", "all time instead of the current month")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { all?: boolean; company?: string }) => runCosts({ ...opts, ...homeOf(program) }));

const approvals = program.command("approvals").description("the inbox: decisions waiting for a person");
approvals
  .command("list", { isDefault: true })
  .description("pending approvals")
  .option("--all", "include decided ones")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { all?: boolean; company?: string }) => runApprovalsList({ ...opts, ...homeOf(program) }));
approvals
  .command("approve <id>")
  .description("approve: the tool runs, or the budget is raised and the agent resumes")
  .option("--note <text>", "note for the audit")
  .option("--cap <amount>", "for a budget increase: the new cap (default: double)")
  .action(async (id: string, opts: { note?: string; cap?: string }) => runApprovalDecide("approved", { id, ...opts, ...homeOf(program) }));
approvals
  .command("deny <id>")
  .description("deny: the agent is told and continues without it")
  .option("--note <text>", "note for the audit, shown to the agent")
  .action(async (id: string, opts: { note?: string }) => runApprovalDecide("denied", { id, ...opts, ...homeOf(program) }));

const policy = program.command("policy").description("tool permissions: automatic, approval or blocked");
policy
  .command("list", { isDefault: true })
  .description("policies of the company, or the effective permissions of one agent")
  .option("--agent <name>", "show the permissions one agent ends up with")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { agent?: string; company?: string }) => runPolicyList({ ...opts, ...homeOf(program) }));
policy
  .command("set <tool> <permission>")
  .description("set a permission for the company, a role or an agent (tool \"*\" means every tool)")
  .option("--agent <name>", "apply to one agent")
  .option("--role <role>", "apply to every agent with this role")
  .option("--company <name>", "company (default: the first one)")
  .action(async (tool: string, permission: string, opts: { agent?: string; role?: string; company?: string }) => runPolicySet({ tool, permission, ...opts, ...homeOf(program) }));
policy
  .command("remove <id>")
  .description("remove a policy by id")
  .option("--company <name>", "company (default: the first one)")
  .action(async (id: string, opts: { company?: string }) => runPolicyRemove({ id, ...opts, ...homeOf(program) }));

const secret = program.command("secret").description("encrypted secrets, injected into tools and never shown to the model");
secret
  .command("list", { isDefault: true })
  .description("names, versions and bindings (never the values)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runSecretList({ ...opts, ...homeOf(program) }));
secret
  .command("set <name> [value]")
  .description("store a secret (prompted, or read from stdin, when the value is omitted)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, value: string | undefined, opts: { company?: string }) => runSecretSet({ name, ...(value !== undefined ? { value } : {}), ...opts, ...homeOf(program) }));
secret
  .command("remove <name>")
  .description("remove a secret and its bindings")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { company?: string }) => runSecretRemove({ name, ...opts, ...homeOf(program) }));
secret
  .command("bind <name>")
  .description("make a secret available to an agent, in every tool or one tool")
  .requiredOption("--agent <name>", "the agent")
  .option("--tool <tool>", "only this tool (default: every tool)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { agent: string; tool?: string; company?: string }) => runSecretBind({ name, ...opts, ...homeOf(program) }));
secret
  .command("unbind <bindingId>")
  .description("remove a binding by id")
  .option("--company <name>", "company (default: the first one)")
  .action(async (id: string, opts: { company?: string }) => runSecretUnbind({ id, ...opts, ...homeOf(program) }));

const task = program.command("task").description("tasks: what the agents work on");
task
  .command("list", { isDefault: true })
  .description("open tasks (todo, in progress, in review, blocked)")
  .option("--all", "include done and cancelled")
  .option("--status <list>", "comma-separated statuses")
  .option("--agent <name>", "only this agent's tasks")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { all?: boolean; status?: string; agent?: string; company?: string }) => runTaskList({ ...opts, ...homeOf(program) }));
task
  .command("create <title>")
  .description("create a task; with --agent the agent wakes up and starts")
  .option("--agent <name>", "assign to an agent")
  .option("--description <text>", "what to do")
  .option("--acceptance <text>", "what makes the result verifiable")
  .option("--priority <low|normal|high|urgent>", "priority (default normal)")
  .option("--project <name>", "project")
  .option("--parent <id>", "parent task id")
  .option("--company <name>", "company (default: the first one)")
  .action(async (title: string, opts: { agent?: string; description?: string; acceptance?: string; priority?: string; project?: string; parent?: string; company?: string }) => runTaskCreate({ title, ...opts, ...homeOf(program) }));
task
  .command("show <id>")
  .description("the task with its why chain, results, subtasks and comments")
  .option("--company <name>", "company (default: the first one)")
  .action(async (id: string, opts: { company?: string }) => runTaskShow({ id, ...opts, ...homeOf(program) }));
task
  .command("comment <id> <body>")
  .description("comment on a task (@Name wakes an agent)")
  .action(async (id: string, body: string) => runTaskComment({ id, body, ...homeOf(program) }));
task
  .command("assign <id> <agent>")
  .description("assign the task to an agent, who wakes up")
  .option("--company <name>", "company (default: the first one)")
  .action(async (id: string, agent: string, opts: { company?: string }) => runTaskAssign({ id, agent, ...opts, ...homeOf(program) }));
for (const [name, description] of [
  ["complete", "close the task as verified (--note is the result summary)"],
  ["request-changes", "send a delivered task back with a note"],
  ["block", "block the task with a reason"],
  ["unblock", "unblock the task; the assignee wakes up"],
  ["cancel", "cancel the task"],
  ["release", "give a task in progress back to the queue"],
  ["wake", "wake the assignee again"],
] as const) {
  task
    .command(`${name} <id>`)
    .description(description)
    .option("--note <text>", "summary, note or reason")
    .option("--verification <text>", "for complete: how the result was checked")
    .action(async (id: string, opts: { note?: string; verification?: string }) => runTaskAction(name, { id, ...opts, ...homeOf(program) }));
}

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
