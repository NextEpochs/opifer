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
import {
  runLearningSet,
  runLearningShow,
  runMemoryAction,
  runMemoryAdd,
  runMemoryList,
  runSkillAction,
  runSkillExport,
  runSkillInstall,
  runSkillList,
  runSkillShow,
} from "./commands/learning.js";
import {
  runChannelAddTelegram,
  runChannelList,
  runChannelPair,
  runChannelRemove,
  runConnectionAction,
  runConnectionAddMcp,
  runConnectionAddWorkflow,
  runConnectionList,
  runRoutineAction,
  runRoutineCreate,
  runRoutineList,
  runStopAll,
  runDemo,
  runExport,
  runImport,
  runWebhookCreate,
  runWebhookList,
  runWebhookRemove,
  runWebhookSubscribe,
} from "./commands/connections.js";
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
  .description('set a permission for the company, a role or an agent (tool "*" means every tool)')
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
  .action(async (name: string, value: string | undefined, opts: { company?: string }) =>
    runSecretSet({ name, ...(value !== undefined ? { value } : {}), ...opts, ...homeOf(program) }),
  );
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
  .action(async (title: string, opts: { agent?: string; description?: string; acceptance?: string; priority?: string; project?: string; parent?: string; company?: string }) =>
    runTaskCreate({ title, ...opts, ...homeOf(program) }),
  );
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

const memory = program.command("memory").description("what the agents remember");
memory
  .command("list", { isDefault: true })
  .description("memories (from an agent's point of view with --agent; --query searches)")
  .option("--agent <name>", "read as this agent: its own, its teams', the company's")
  .option("--query <text>", "search (needs --agent)")
  .option("--all", "include retired and superseded entries")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { agent?: string; query?: string; all?: boolean; company?: string }) => runMemoryList({ ...opts, ...homeOf(program) }));
memory
  .command("add <content>")
  .description("save a memory (company-wide, or an agent's with --agent)")
  .option("--agent <name>", "the agent it belongs to")
  .option("--scope <agent|team|company>", "scope (default: agent with --agent, company otherwise)")
  .option("--subject <name>", "makes it a profile of a person or a system")
  .option("--pin", "keep it first in the snapshot")
  .option("--company <name>", "company (default: the first one)")
  .action(async (content: string, opts: { agent?: string; scope?: string; subject?: string; pin?: boolean; company?: string }) =>
    runMemoryAdd({ content, ...opts, ...homeOf(program) }),
  );
for (const [name, description] of [
  ["retire", "retire a memory with a reason (it stays in the record)"],
  ["correct", "replace a memory with a corrected text"],
  ["pin", "keep a memory first in the snapshot"],
  ["unpin", "unpin a memory"],
  ["promote", "share a memory with the whole company (per the company policy)"],
] as const) {
  memory
    .command(`${name} <id> [text]`)
    .description(description)
    .option("--company <name>", "company (default: the first one)")
    .action(async (id: string, text: string | undefined, opts: { company?: string }) =>
      runMemoryAction({ action: name, id, ...(text ? { text } : {}), ...opts, ...homeOf(program) }),
    );
}

const skill = program.command("skill").description("reusable procedures the agents learn and use");
skill
  .command("list", { isDefault: true })
  .description("skills (what an agent can load with --agent)")
  .option("--agent <name>", "as seen by this agent")
  .option("--all", "include archived skills")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { agent?: string; all?: boolean; company?: string }) => runSkillList({ ...opts, ...homeOf(program) }));
skill
  .command("show <name>")
  .description("the skill's text, versions and usage")
  .option("--agent <name>", "the agent's own copy")
  .option("--version <n>", "an older version")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { agent?: string; version?: string; company?: string }) => runSkillShow({ name, ...opts, ...homeOf(program) }));
skill
  .command("install <dir>")
  .description("install a skill folder (SKILL.md plus scripts/, references/, templates/)")
  .option("--agent <name>", "for this agent only (default: the whole company)")
  .option("--name <name>", "override the name in the header")
  .option("--company <name>", "company (default: the first one)")
  .action(async (dir: string, opts: { agent?: string; name?: string; company?: string }) => runSkillInstall({ dir, ...opts, ...homeOf(program) }));
skill
  .command("export <name> <dir>")
  .description("export a skill as a folder in the open format")
  .option("--agent <name>", "the agent's own copy")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, dir: string, opts: { agent?: string; company?: string }) => runSkillExport({ name, dir, ...opts, ...homeOf(program) }));
for (const [name, description] of [
  ["restore", "go back to a version: o4r skill restore <name> <version>"],
  ["archive", "archive a skill (restorable)"],
  ["unarchive", "bring an archived skill back"],
  ["pin", "pin a skill: the curator and the agents leave it alone"],
  ["unpin", "unpin a skill"],
  ["promote", "share an agent's skill with the whole company (per the company policy)"],
] as const) {
  skill
    .command(`${name} <name> [version]`)
    .description(description)
    .option("--agent <name>", "the agent's own copy")
    .option("--company <name>", "company (default: the first one)")
    .action(async (skillName: string, version: string | undefined, opts: { agent?: string; company?: string }) =>
      runSkillAction({ action: name, name: skillName, ...(version ? { version } : {}), ...opts, ...homeOf(program) }),
    );
}

const learning = program.command("learning").description("how the company learns: review, promotion policy, curator");
learning
  .command("show", { isDefault: true })
  .description("settings and the last background reviews")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runLearningShow({ ...opts, ...homeOf(program) }));
learning
  .command("set <key> <value>")
  .description("review on|off · promotion automatic|review|forbidden · threshold N · snapshot CHARS · inactive DAYS · archive DAYS")
  .option("--company <name>", "company (default: the first one)")
  .action(async (key: string, value: string, opts: { company?: string }) => runLearningSet({ key, value, ...opts, ...homeOf(program) }));

const routine = program.command("routine").description("recurring work: an agent, a prompt, a schedule (at most one run per due time)");
routine
  .command("list", { isDefault: true })
  .description("the routines and their next run")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runRoutineList({ ...opts, ...homeOf(program) }));
routine
  .command("create <name>")
  .description('create a routine: --every "monday 9:00" | "every 2 hours" | "weekdays 18:30" | a cron | a date')
  .requiredOption("--agent <name>", "who runs it")
  .requiredOption("--every <schedule>", "when")
  .requiredOption("--prompt <text>", "what to do each time")
  .option("--timezone <tz>", "timezone for the schedule (default: this machine's)")
  .option("--skills <names>", "comma-separated skills to load")
  .option("--deliver <targets>", "comma-separated: channels (default), inbox, or a channel id")
  .option("--learn", "let the routine write memory (off by default)")
  .option("--as-task", "every run is a task: the agent can delegate to its reports and the result is reviewed")
  .option("--company <name>", "company (default: the first one)")
  .action(
    async (
      name: string,
      opts: { agent: string; every: string; prompt: string; timezone?: string; skills?: string; deliver?: string; learn?: boolean; asTask?: boolean; company?: string },
    ) => runRoutineCreate({ name, ...opts, ...homeOf(program) }),
  );
for (const [name, description] of [
  ["run", "run a routine now"],
  ["enable", "enable a routine"],
  ["disable", "disable a routine"],
  ["remove", "remove a routine"],
  ["runs", "the last runs of a routine"],
] as const) {
  routine
    .command(`${name} <name>`)
    .description(description)
    .option("--company <name>", "company (default: the first one)")
    .action(async (routineName: string, opts: { company?: string }) => runRoutineAction({ action: name, name: routineName, ...opts, ...homeOf(program) }));
}

const connection = program.command("connection").description("MCP servers and workflow tools the agents can use");
connection
  .command("list", { isDefault: true })
  .description("connections, their health and their tools")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runConnectionList({ ...opts, ...homeOf(program) }));
connection
  .command("add-mcp <name>")
  .description("add an MCP server: --command with --args (local, stdio) or --url (remote, streamable HTTP)")
  .option("--command <cmd>", "the executable, for example npx")
  .option("--args <list>", "comma-separated arguments")
  .option("--url <url>", "a remote MCP server")
  .option("--secret <NAME>", "a company secret passed as environment variable (stdio) or bearer header (HTTP)")
  .option("--risk <low|medium|high>", "risk of its tools (default medium)")
  .option("--description <text>", "what it is for")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { command?: string; args?: string; url?: string; secret?: string; risk?: string; description?: string; company?: string }) =>
    runConnectionAddMcp({ name, ...opts, ...homeOf(program) }),
  );
connection
  .command("add-workflow <name>")
  .description("add an n8n/Zapier/Make workflow as a tool: one URL the agent can call")
  .requiredOption("--url <url>", "the webhook URL of the workflow")
  .requiredOption("--description <text>", "when the agent should use it")
  .option("--schema <json>", "JSON schema of the parameters")
  .option("--field <name>", "JSON field of the response to return to the agent")
  .option("--method <POST|GET>", "HTTP method (default POST)")
  .option("--secret <NAME>", "a company secret sent as bearer header")
  .option("--risk <low|medium|high>", "risk (default medium)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { url: string; description: string; schema?: string; field?: string; method?: string; secret?: string; risk?: string; company?: string }) =>
    runConnectionAddWorkflow({ name, ...opts, ...homeOf(program) }),
  );
for (const [name, description] of [
  ["check", "talk to the server and refresh its tools and health"],
  ["enable", "enable a connection"],
  ["disable", "disable a connection"],
  ["remove", "remove a connection"],
  ["call", "call a tool by hand: --tool <name> --args '{...}'"],
] as const) {
  connection
    .command(`${name} <name>`)
    .description(description)
    .option("--tool <tool>", "the tool (for call)")
    .option("--args <json>", "the arguments (for call)")
    .option("--company <name>", "company (default: the first one)")
    .action(async (connectionName: string, opts: { tool?: string; args?: string; company?: string }) =>
      runConnectionAction({ action: name, name: connectionName, ...opts, ...homeOf(program) }),
    );
}

const webhook = program.command("webhook").description("inbound webhooks and outbound signed events (n8n, Zapier, Make, scripts)");
webhook
  .command("list", { isDefault: true })
  .description("webhooks and subscriptions")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runWebhookList({ ...opts, ...homeOf(program) }));
webhook
  .command("create <name>")
  .description("an inbound webhook: --action create_task | wake_agent | comment | decide_approval")
  .requiredOption("--action <action>", "what a call does")
  .option("--agent <name>", "default agent for the action")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { action: string; agent?: string; company?: string }) => runWebhookCreate({ name, ...opts, ...homeOf(program) }));
webhook
  .command("subscribe <name> <url>")
  .description("send the company's events to a URL, signed")
  .option("--events <list>", "comma-separated types or patterns (task.*, approval.requested…); default all")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, url: string, opts: { events?: string; company?: string }) => runWebhookSubscribe({ name, url, ...opts, ...homeOf(program) }));
webhook
  .command("remove <name>")
  .description("remove a webhook or a subscription")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { company?: string }) => runWebhookRemove({ name, ...opts, ...homeOf(program) }));

const channel = program.command("channel").description("messaging channels: talk to the agents and approve from Telegram");
channel
  .command("list", { isDefault: true })
  .description("channels and who is paired")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runChannelList({ ...opts, ...homeOf(program) }));
channel
  .command("add-telegram")
  .description("add the company's Telegram bot (token from @BotFather)")
  .requiredOption("--token <token>", "the bot token")
  .option("--agent <name>", "the agent that answers by default")
  .option("--name <name>", "channel name (default Telegram)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { token: string; agent?: string; name?: string; company?: string }) => runChannelAddTelegram({ ...opts, ...homeOf(program) }));
channel
  .command("pair <code>")
  .description("link a chat to you with the code the bot gave you")
  .option("--company <name>", "company (default: the first one)")
  .action(async (code: string, opts: { company?: string }) => runChannelPair({ code, ...opts, ...homeOf(program) }));
channel
  .command("remove <name>")
  .description("remove a channel")
  .option("--company <name>", "company (default: the first one)")
  .action(async (name: string, opts: { company?: string }) => runChannelRemove({ name, ...opts, ...homeOf(program) }));

program
  .command("demo")
  .description("create a demo company on the running server: a team at work, tasks in every state, routines and connections")
  .option("--name <name>", "company name (default: Proclive)")
  .action(async (opts: { name?: string }) => runDemo({ ...opts, ...homeOf(program) }));
program
  .command("export [file]")
  .description("export a company (configuration and work; secret values never leave) to a JSON file")
  .option("--company <name>", "company (default: the first one)")
  .action(async (file: string | undefined, opts: { company?: string }) => runExport({ ...(file ? { file } : {}), ...opts, ...homeOf(program) }));
program
  .command("import <file>")
  .description("import a company from an export file, as a copy with new ids")
  .option("--name <name>", "name for the imported company")
  .action(async (file: string, opts: { name?: string }) => runImport({ file, ...opts, ...homeOf(program) }));
program
  .command("stop")
  .description("emergency stop: every agent of the company stops, routines pause, no model is called until resume")
  .option("--reason <text>", "why (recorded in the audit)")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { reason?: string; company?: string }) => runStopAll({ ...opts, ...homeOf(program) }));
program
  .command("resume")
  .description("lift the emergency stop")
  .option("--company <name>", "company (default: the first one)")
  .action(async (opts: { company?: string }) => runStopAll({ ...opts, resume: true, ...homeOf(program) }));

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
