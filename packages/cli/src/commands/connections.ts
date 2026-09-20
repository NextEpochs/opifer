/**
 * Routines, connections, webhooks, event subscriptions and channels from the
 * terminal. Everything goes through the server.
 */

import { api, resolveAgent, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

async function connect(options: Common) {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const agents = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/agents`);
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name ?? (id ? "?" : "—");
  return { base, company, agents, nameOf };
}

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

// --- Routines -----------------------------------------------------------------

interface Routine {
  id: string;
  name: string;
  agentId: string;
  scheduleKind: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  nextDueAt: string | null;
  lastRunAt: string | null;
  deliverTo: string[];
  skills: string[];
}

export async function runRoutineList(options: Common): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const routines = await api<Routine[]>(base, `/v1/companies/${company.id}/routines`);
  if (routines.length === 0) {
    say.info(`No routines. Create one with ${c.cyan('o4r routine create "Weekly digest" --agent Sam --every "monday 9:00" --prompt "..."')}`);
    return;
  }
  for (const r of routines) {
    const schedule = r.scheduleKind === "interval" ? `every ${r.schedule}s` : r.scheduleKind === "cron" ? `cron ${r.schedule} (${r.timezone})` : `once ${when(r.schedule)}`;
    say.info(
      `${(r.enabled ? c.green("on ") : c.dim("off")).padEnd(4)} ${c.bold(r.name.padEnd(28))} ${nameOf(r.agentId).padEnd(10)} ${schedule.padEnd(32)} next ${when(r.nextDueAt)}  ${c.dim(r.id.slice(0, 8))}`,
    );
  }
}

/** "monday 9:00" → cron; "every 2 hours" → interval; a date → once; a cron stays a cron. */
export function scheduleFrom(text: string): { scheduleKind: "interval" | "cron" | "once"; schedule: string } {
  const t = text.trim().toLowerCase();
  if (/^every\s/.test(t) || /^\d+$/.test(t)) return { scheduleKind: "interval", schedule: t };
  const days: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const m = /^(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday|daily|weekdays)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    const hour = Number(m[2]);
    const minute = m[3] ? Number(m[3]) : 0;
    const dow = m[1] === undefined || m[1] === "daily" ? "*" : m[1] === "weekdays" ? "1-5" : String(days[m[1]]);
    return { scheduleKind: "cron", schedule: `${minute} ${hour} * * ${dow}` };
  }
  if (!Number.isNaN(new Date(text).getTime()) && /\d{4}-\d{2}-\d{2}/.test(text)) return { scheduleKind: "once", schedule: new Date(text).toISOString() };
  return { scheduleKind: "cron", schedule: text.trim() };
}

export async function runRoutineCreate(
  options: Common & { name: string; agent: string; every: string; prompt: string; timezone?: string; skills?: string; deliver?: string; learn?: boolean },
): Promise<void> {
  const { base, company } = await connect(options);
  const agent = await resolveAgent(base, company.id, options.agent);
  const schedule = scheduleFrom(options.every);
  const routine = await api<Routine>(base, `/v1/companies/${company.id}/routines`, {
    method: "POST",
    body: JSON.stringify({
      agentId: agent.id,
      name: options.name,
      prompt: options.prompt,
      ...schedule,
      timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      skills: options.skills ? options.skills.split(",").map((s) => s.trim()) : [],
      deliverTo: options.deliver ? options.deliver.split(",").map((s) => s.trim()) : ["channels"],
      learn: options.learn ?? false,
    }),
  });
  say.ok(`Routine "${routine.name}" for ${agent.name}: ${routine.scheduleKind} ${routine.schedule} (${routine.timezone}), next run ${when(routine.nextDueAt)}.`);
}

export async function runRoutineAction(options: Common & { action: "run" | "enable" | "disable" | "remove" | "runs"; name: string }): Promise<void> {
  const { base, company } = await connect(options);
  const routines = await api<Routine[]>(base, `/v1/companies/${company.id}/routines`);
  const routine = routines.find((r) => r.name.toLowerCase() === options.name.toLowerCase() || r.id.startsWith(options.name));
  if (!routine) throw new Error(`routine "${options.name}" not found`);
  const url = `/v1/companies/${company.id}/routines/${routine.id}`;
  switch (options.action) {
    case "run":
      await api(base, `${url}/run`, { method: "POST" });
      say.ok("Queued: the agent runs it now.");
      break;
    case "enable":
    case "disable": {
      const r = await api<Routine>(base, url, { method: "PATCH", body: JSON.stringify({ enabled: options.action === "enable" }) });
      say.ok(options.action === "enable" ? `Enabled, next run ${when(r.nextDueAt)}.` : "Disabled.");
      break;
    }
    case "remove":
      await api(base, url, { method: "DELETE" });
      say.ok("Removed.");
      break;
    case "runs": {
      const runs = await api<Array<{ dueAt: string; status: string; result: string | null; error: string | null }>>(base, `${url}/runs?limit=20`);
      if (runs.length === 0) say.info("No runs yet.");
      for (const r of runs) say.info(`${when(r.dueAt)}  ${r.status.padEnd(12)} ${c.dim((r.result ?? r.error ?? "").replace(/\s+/g, " ").slice(0, 100))}`);
    }
  }
}

// --- Connections -------------------------------------------------------------

interface Connection {
  id: string;
  kind: string;
  name: string;
  description: string;
  status: string;
  statusDetail: string | null;
  enabled: boolean;
  risk: string;
  tools: Array<{ name: string; description: string }>;
}

const statusColour = (s: string) => (s === "healthy" ? c.green(s) : s === "failed" || s === "missing_secret" ? c.red(s) : s === "degraded" ? c.yellow(s) : c.dim(s));

export async function runConnectionList(options: Common): Promise<void> {
  const { base, company } = await connect(options);
  const list = await api<Connection[]>(base, `/v1/companies/${company.id}/connections`);
  if (list.length === 0) {
    say.info(
      `No connections. Add an MCP server with ${c.cyan('o4r connection add-mcp github --command npx --args "-y,@modelcontextprotocol/server-github" --secret GITHUB_TOKEN')} or a workflow with ${c.cyan("o4r connection add-workflow ...")}`,
    );
    return;
  }
  for (const x of list) {
    say.info(`${statusColour(x.status).padEnd(20)} ${c.bold(x.name.padEnd(20))} ${x.kind.padEnd(10)} ${x.risk.padEnd(7)} ${x.tools.length} tools ${c.dim(x.statusDetail ?? "")}`);
    for (const t of x.tools.slice(0, 8)) say.info(`  ${c.dim("·")} ${x.name}__${t.name}  ${c.dim(t.description.slice(0, 80))}`);
    if (x.tools.length > 8) say.info(`  ${c.dim(`… ${x.tools.length - 8} more`)}`);
  }
}

export async function runConnectionAddMcp(
  options: Common & { name: string; command?: string; args?: string; url?: string; secret?: string; risk?: string; description?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const kind = options.url ? "mcp_http" : "mcp_stdio";
  if (!options.url && !options.command) throw new Error("give --command (a local server) or --url (a remote one)");
  const config = options.url
    ? { url: options.url, ...(options.secret ? { headers: { authorization: `Bearer \${${options.secret}}` } } : {}) }
    : { command: options.command, args: options.args ? options.args.split(",").map((a) => a.trim()) : [] };
  const x = await api<Connection>(base, `/v1/companies/${company.id}/connections`, {
    method: "POST",
    body: JSON.stringify({
      kind,
      name: options.name,
      description: options.description ?? "",
      config,
      risk: options.risk ?? "medium",
      secretNames: options.secret ? [options.secret] : [],
    }),
  });
  (x.status === "healthy" ? say.ok : say.warn)(`${x.name}: ${x.status}${x.statusDetail ? ` (${x.statusDetail})` : ""}, ${x.tools.length} tools`);
  if (x.status === "missing_secret") say.info(`Set it with ${c.cyan(`o4r secret set ${options.secret}`)} then ${c.cyan(`o4r connection check ${x.name}`)}`);
}

export async function runConnectionAddWorkflow(
  options: Common & { name: string; url: string; description: string; secret?: string; risk?: string; schema?: string; field?: string; method?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const inputSchema = options.schema
    ? (JSON.parse(options.schema) as Record<string, unknown>)
    : { type: "object", properties: { input: { type: "string", description: "What to send to the workflow" } } };
  const x = await api<Connection>(base, `/v1/companies/${company.id}/connections`, {
    method: "POST",
    body: JSON.stringify({
      kind: "workflow",
      name: options.name,
      description: options.description,
      config: {
        url: options.url,
        method: options.method ?? "POST",
        inputSchema,
        toolDescription: options.description,
        ...(options.field ? { resultField: options.field } : {}),
        ...(options.secret ? { headers: { authorization: `Bearer \${${options.secret}}` } } : {}),
      },
      risk: options.risk ?? "medium",
      secretNames: options.secret ? [options.secret] : [],
    }),
  });
  (x.status === "healthy" ? say.ok : say.warn)(`${x.name}: ${x.status}${x.statusDetail ? ` (${x.statusDetail})` : ""}; the agents see the tool ${c.bold(`${x.name}__run`)}`);
}

export async function runConnectionAction(
  options: Common & { action: "check" | "enable" | "disable" | "remove" | "call"; name: string; args?: string; tool?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const list = await api<Connection[]>(base, `/v1/companies/${company.id}/connections`);
  const x = list.find((k) => k.name === options.name || k.id.startsWith(options.name));
  if (!x) throw new Error(`connection "${options.name}" not found`);
  const url = `/v1/companies/${company.id}/connections/${x.id}`;
  switch (options.action) {
    case "check": {
      const checked = await api<Connection>(base, `${url}/check`, { method: "POST" });
      (checked.status === "healthy" ? say.ok : say.warn)(
        `${checked.name}: ${checked.status}${checked.statusDetail ? ` (${checked.statusDetail})` : ""}, ${checked.tools.length} tools`,
      );
      break;
    }
    case "enable":
    case "disable":
      await api(base, url, { method: "PATCH", body: JSON.stringify({ enabled: options.action === "enable" }) });
      say.ok(options.action === "enable" ? "Enabled." : "Disabled: its tools disappear from the agents' next sessions.");
      break;
    case "remove":
      await api(base, url, { method: "DELETE" });
      say.ok("Removed.");
      break;
    case "call": {
      const tool = options.tool ?? (x.kind === "workflow" ? "run" : x.tools[0]?.name);
      if (!tool) throw new Error("which tool? --tool <name>");
      const result = await api<{ content: string; isError: boolean }>(base, `/v1/companies/${company.id}/connections/call`, {
        method: "POST",
        body: JSON.stringify({ tool: `${x.name}__${tool}`, args: options.args ? JSON.parse(options.args) : {} }),
      });
      (result.isError ? say.warn : say.ok)(result.content.slice(0, 2000));
    }
  }
}

// --- Webhooks and subscriptions -------------------------------------------------

export async function runWebhookList(options: Common): Promise<void> {
  const { base, company } = await connect(options);
  const hooks = await api<Array<{ id: string; name: string; action: string; enabled: boolean; calls: number; lastCalledAt: string | null }>>(
    base,
    `/v1/companies/${company.id}/webhooks`,
  );
  const subs = await api<Array<{ id: string; name: string; url: string; events: string[]; enabled: boolean; failures: number; lastDeliveredAt: string | null }>>(
    base,
    `/v1/companies/${company.id}/subscriptions`,
  );
  say.info(c.bold("Inbound webhooks") + (hooks.length === 0 ? c.dim("  none: o4r webhook create <name> --action create_task") : ""));
  for (const h of hooks)
    say.info(
      `  ${(h.enabled ? c.green("on ") : c.dim("off")).padEnd(4)} ${c.bold(h.name.padEnd(24))} ${h.action.padEnd(16)} POST ${base}/v1/hooks/${h.id}  ${c.dim(`${h.calls} calls, last ${when(h.lastCalledAt)}`)}`,
    );
  say.info(c.bold("Outbound events") + (subs.length === 0 ? c.dim("  none: o4r webhook subscribe <name> <url> --events task.*,approval.*") : ""));
  for (const s of subs)
    say.info(
      `  ${(s.enabled ? c.green("on ") : c.dim("off")).padEnd(4)} ${c.bold(s.name.padEnd(24))} ${s.url.padEnd(40)} ${s.events.join(",")}  ${c.dim(`${s.failures} failures, last ${when(s.lastDeliveredAt)}`)}`,
    );
}

export async function runWebhookCreate(options: Common & { name: string; action: string; agent?: string; project?: string }): Promise<void> {
  const { base, company } = await connect(options);
  const defaults: Record<string, unknown> = {};
  if (options.agent) defaults["agentId"] = (await resolveAgent(base, company.id, options.agent)).id;
  const r = await api<{ id: string; token: string; url: string }>(base, `/v1/companies/${company.id}/webhooks`, {
    method: "POST",
    body: JSON.stringify({ name: options.name, action: options.action, defaults }),
  });
  say.ok(`Webhook created. Call it with:`);
  say.info(`  curl -X POST ${base}${r.url} -H "Authorization: Bearer ${r.token}" -H "content-type: application/json" -d '{"title":"..."}'`);
  say.warn("The token is shown once: keep it in your automation tool.");
}

export async function runWebhookSubscribe(options: Common & { name: string; url: string; events?: string }): Promise<void> {
  const { base, company } = await connect(options);
  const s = await api<{ id: string; secret: string; events: string[] }>(base, `/v1/companies/${company.id}/subscriptions`, {
    method: "POST",
    body: JSON.stringify({ name: options.name, url: options.url, events: options.events ? options.events.split(",").map((e) => e.trim()) : ["*"] }),
  });
  say.ok(`Subscribed to ${s.events.join(", ")}. Deliveries carry X-Opifer-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<unix>.<body>").`);
  say.info(`  secret: ${s.secret}`);
  say.warn("The secret is shown once.");
}

export async function runWebhookRemove(options: Common & { name: string }): Promise<void> {
  const { base, company } = await connect(options);
  const hooks = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/webhooks`);
  const subs = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/subscriptions`);
  const h = hooks.find((x) => x.name === options.name);
  const s = subs.find((x) => x.name === options.name);
  if (h) await api(base, `/v1/companies/${company.id}/webhooks/${h.id}`, { method: "DELETE" });
  else if (s) await api(base, `/v1/companies/${company.id}/subscriptions/${s.id}`, { method: "DELETE" });
  else throw new Error(`"${options.name}" is neither a webhook nor a subscription`);
  say.ok("Removed.");
}

// --- Channels -------------------------------------------------------------------

export async function runChannelList(options: Common): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const channels = await api<
    Array<{
      id: string;
      kind: string;
      name: string;
      status: string;
      statusDetail: string | null;
      live: boolean;
      enabled: boolean;
      defaultAgentId: string | null;
      config: { botUsername?: string };
    }>
  >(base, `/v1/companies/${company.id}/channels`);
  const bindings = await api<
    Array<{ id: string; channelId: string; displayName: string; userId: string | null; pairingCode: string | null; agentId: string | null; notify: boolean }>
  >(base, `/v1/companies/${company.id}/channel-bindings`);
  if (channels.length === 0) {
    say.info(`No channels. Add Telegram with ${c.cyan("o4r channel add-telegram --token <bot token from @BotFather> --agent Philip")}`);
    return;
  }
  for (const ch of channels) {
    say.info(
      `${statusColour(ch.status).padEnd(20)} ${c.bold(ch.name.padEnd(16))} ${ch.kind}${ch.config.botUsername ? ` @${ch.config.botUsername}` : ""}  default agent ${nameOf(ch.defaultAgentId)}  ${c.dim(ch.statusDetail ?? "")}`,
    );
    for (const b of bindings.filter((x) => x.channelId === ch.id)) {
      say.info(
        `  ${b.userId ? c.green("paired ") : c.yellow(`code ${b.pairingCode ?? "expired"}`)}  ${b.displayName.padEnd(20)} talks to ${nameOf(b.agentId ?? ch.defaultAgentId)}  ${b.notify ? "notifications on" : c.dim("notifications off")}`,
      );
    }
  }
}

export async function runChannelAddTelegram(options: Common & { token: string; agent?: string; name?: string }): Promise<void> {
  const { base, company } = await connect(options);
  await api(base, `/v1/companies/${company.id}/secrets`, { method: "PUT", body: JSON.stringify({ name: "TELEGRAM_BOT_TOKEN", value: options.token }) });
  const defaultAgentId = options.agent ? (await resolveAgent(base, company.id, options.agent)).id : null;
  const ch = await api<{ id: string; status: string; statusDetail: string | null; config: { botUsername?: string } }>(base, `/v1/companies/${company.id}/channels`, {
    method: "POST",
    body: JSON.stringify({ kind: "telegram", name: options.name ?? "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId }),
  });
  (ch.status === "healthy" ? say.ok : say.warn)(
    `Telegram: ${ch.status}${ch.config.botUsername ? ` as @${ch.config.botUsername}` : ""}${ch.statusDetail && ch.status !== "healthy" ? ` (${ch.statusDetail})` : ""}`,
  );
  if (ch.status === "healthy") say.info(`Write to the bot on Telegram: it answers with a code; then ${c.cyan("o4r channel pair <code>")}`);
}

export async function runChannelPair(options: Common & { code: string }): Promise<void> {
  const { base, company } = await connect(options);
  const b = await api<{ displayName: string }>(base, `/v1/companies/${company.id}/channel-bindings/pair`, { method: "POST", body: JSON.stringify({ code: options.code }) });
  say.ok(`${b.displayName} is now linked to you: the chat talks to the agents and receives approvals with buttons.`);
}

export async function runChannelRemove(options: Common & { name: string }): Promise<void> {
  const { base, company } = await connect(options);
  const channels = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/channels`);
  const ch = channels.find((x) => x.name.toLowerCase() === options.name.toLowerCase());
  if (!ch) throw new Error(`channel "${options.name}" not found`);
  await api(base, `/v1/companies/${company.id}/channels/${ch.id}`, { method: "DELETE" });
  say.ok("Removed.");
}
