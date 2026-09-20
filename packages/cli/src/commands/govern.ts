/**
 * Governance from the terminal: budgets and costs, the approvals inbox,
 * tool policies, secrets. Every command talks to the running server.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { api, resolveAgent, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface BudgetPolicy {
  id: string;
  scopeKind: string;
  scopeId: string | null;
  window: string;
  cap: number;
  currency: string;
  warnRatio: number;
}

interface Approval {
  id: string;
  kind: string;
  status: string;
  agentId: string | null;
  sessionId: string | null;
  reason: string | null;
  risk: string;
  subject: Record<string, unknown>;
  createdAt: string;
  followUp?: string | null;
}

interface ToolPolicy {
  id: string;
  targetKind: string;
  targetId: string | null;
  toolName: string;
  permission: string;
}

async function connect(options: Common) {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  return { base, company };
}

function money(n: number, currency: string): string {
  return `${n.toFixed(4)} ${currency}`;
}

// --- budget ------------------------------------------------------------------

export async function runBudgetList(options: Common): Promise<void> {
  const { base, company } = await connect(options);
  const policies = await api<BudgetPolicy[]>(base, `/v1/companies/${company.id}/budgets`);
  if (policies.length === 0) {
    say.info(`No budget in ${company.name}: agents spend without a cap. Set one with ${c.cyan("o4r budget set --cap 20")}`);
    return;
  }
  for (const p of policies) {
    const scope = p.scopeKind === "company" ? "company" : `${p.scopeKind} ${p.scopeId}`;
    say.info(`${c.bold(scope)}  ${p.window}  cap ${p.cap} ${p.currency}  (warn at ${Math.round(p.warnRatio * 100)}%)  ${c.dim(p.id)}`);
  }
}

export async function runBudgetSet(options: Common & { cap: string; agent?: string; window?: string; currency?: string }): Promise<void> {
  const { base, company } = await connect(options);
  const cap = Number(options.cap);
  if (!Number.isFinite(cap) || cap < 0) throw new Error("--cap must be a number of euros (or dollars with --currency USD)");
  const scope = options.agent ? { scopeKind: "agent", scopeId: (await resolveAgent(base, company.id, options.agent)).id } : { scopeKind: "company" };
  const policy = await api<BudgetPolicy>(base, `/v1/companies/${company.id}/budgets`, {
    method: "PUT",
    body: JSON.stringify({ ...scope, cap, window: options.window ?? "monthly", currency: options.currency ?? "EUR" }),
  });
  say.ok(`Budget set: ${policy.scopeKind === "company" ? company.name : `agent ${options.agent}`} ${policy.window} cap ${policy.cap} ${policy.currency}`);
}

export async function runBudgetRemove(options: Common & { id: string }): Promise<void> {
  const { base, company } = await connect(options);
  await api(base, `/v1/companies/${company.id}/budgets/${options.id}`, { method: "DELETE" });
  say.ok("Budget removed");
}

export async function runCosts(options: Common & { all?: boolean }): Promise<void> {
  const { base, company } = await connect(options);
  const report = await api<{
    total: { usd: number; eur: number };
    byAgent: Array<{ agentName: string | null; eur: number; usd: number; calls: number }>;
    byModel: Array<{ model: string | null; eur: number; calls: number; inputTokens: number; outputTokens: number }>;
  }>(base, `/v1/companies/${company.id}/costs${options.all ? "?since=all" : ""}`);
  say.info(`${c.bold(company.name)} ${options.all ? "all time" : "this month"}: ${c.bold(money(report.total.eur, "EUR"))} (${money(report.total.usd, "USD")})`);
  if (report.byAgent.length === 0) {
    say.info(c.dim("  no paid calls yet"));
    return;
  }
  say.info(c.dim("  by agent"));
  for (const a of report.byAgent) say.info(`    ${(a.agentName ?? "—").padEnd(24)} ${money(a.eur, "EUR").padStart(14)}  ${a.calls} calls`);
  say.info(c.dim("  by model"));
  for (const m of report.byModel) say.info(`    ${(m.model ?? "—").padEnd(24)} ${money(m.eur, "EUR").padStart(14)}  ${m.calls} calls, ${m.inputTokens} in / ${m.outputTokens} out`);
}

// --- approvals ---------------------------------------------------------------

function describe(a: Approval): string {
  const subject = a.subject;
  switch (a.kind) {
    case "tool_use":
    case "dangerous_command": {
      const args = subject["arguments"] as Record<string, unknown> | undefined;
      const detail = typeof args?.["command"] === "string" ? args["command"] : JSON.stringify(args ?? {});
      return `${subject["tool"]}: ${String(detail).slice(0, 160)}`;
    }
    case "budget_increase":
      return `budget ${subject["scope"]} reached (${Number(subject["spent"]).toFixed(4)} of ${subject["cap"]} ${subject["currency"]})`;
    default:
      return JSON.stringify(subject).slice(0, 160);
  }
}

export async function runApprovalsList(options: Common & { all?: boolean }): Promise<void> {
  const { base, company } = await connect(options);
  const list = await api<Approval[]>(base, `/v1/companies/${company.id}/approvals${options.all ? "" : "?status=pending"}`);
  if (list.length === 0) {
    say.ok(options.all ? "No approvals" : "Nothing to decide");
    return;
  }
  for (const a of list) {
    const status = a.status === "pending" ? c.yellow("pending") : a.status === "approved" ? c.green(a.status) : c.red(a.status);
    say.info(`${status}  ${c.bold(a.kind)} [${a.risk}]  ${describe(a)}`);
    say.info(c.dim(`         ${a.reason ?? ""}  —  id ${a.id}`));
  }
  if (!options.all) say.info(c.dim(`Decide with: o4r approvals approve <id> | o4r approvals deny <id> [--note "..."]`));
}

export async function runApprovalDecide(status: "approved" | "denied", options: Common & { id: string; note?: string; cap?: string }): Promise<void> {
  const base = await serverBase(options.home);
  const decided = await api<Approval>(base, `/v1/approvals/${options.id}/decide`, {
    method: "POST",
    body: JSON.stringify({ status, ...(options.note ? { note: options.note } : {}), ...(options.cap ? { newCap: Number(options.cap) } : {}) }),
  });
  say.ok(`${decided.kind} ${decided.status}${decided.followUp ? ` — ${decided.followUp}` : ""}`);
}

// --- policies ------------------------------------------------------------------

export async function runPolicyList(options: Common & { agent?: string }): Promise<void> {
  const { base, company } = await connect(options);
  if (options.agent) {
    const agent = await resolveAgent(base, company.id, options.agent);
    const tools = await api<Array<{ name: string; risk: string; permission: string; source: string }>>(base, `/v1/agents/${agent.id}/permissions`);
    say.info(`Permissions of ${c.bold(agent.name)}:`);
    for (const t of tools) {
      const perm = t.permission === "automatic" ? c.green(t.permission) : t.permission === "approval" ? c.yellow(t.permission) : c.red(t.permission);
      say.info(`  ${t.name.padEnd(14)} ${perm.padEnd(20)} ${c.dim(`${t.risk} risk, from ${t.source}`)}`);
    }
    return;
  }
  const policies = await api<ToolPolicy[]>(base, `/v1/companies/${company.id}/tool-policies`);
  if (policies.length === 0) {
    say.info("No tool policy: permissions follow the tool risk (low and medium automatic, high with approval).");
    return;
  }
  for (const p of policies) {
    say.info(`${c.bold(p.targetKind)} ${p.targetId ?? ""}  ${p.toolName}  →  ${p.permission}  ${c.dim(p.id)}`);
  }
}

export async function runPolicySet(options: Common & { tool: string; permission: string; agent?: string; role?: string }): Promise<void> {
  const { base, company } = await connect(options);
  if (!["automatic", "approval", "blocked"].includes(options.permission)) throw new Error("permission must be automatic, approval or blocked");
  const target = options.agent
    ? { targetKind: "agent", targetId: (await resolveAgent(base, company.id, options.agent)).id }
    : options.role
      ? { targetKind: "role", targetId: options.role }
      : { targetKind: "company" };
  await api(base, `/v1/companies/${company.id}/tool-policies`, { method: "PUT", body: JSON.stringify({ ...target, toolName: options.tool, permission: options.permission }) });
  say.ok(`${options.tool} is now ${options.permission} for ${options.agent ?? options.role ?? company.name}`);
}

export async function runPolicyRemove(options: Common & { id: string }): Promise<void> {
  const { base, company } = await connect(options);
  await api(base, `/v1/companies/${company.id}/tool-policies/${options.id}`, { method: "DELETE" });
  say.ok("Policy removed");
}

// --- secrets -------------------------------------------------------------------

export async function runSecretList(options: Common): Promise<void> {
  const { base, company } = await connect(options);
  const list = await api<Array<{ name: string; version: number; createdAt: string }>>(base, `/v1/companies/${company.id}/secrets`);
  const bindings = await api<Array<{ id: string; secretName: string; agentId: string | null; toolName: string | null }>>(base, `/v1/companies/${company.id}/secret-bindings`);
  if (list.length === 0) {
    say.info(`No secret in ${company.name}. Add one with ${c.cyan("o4r secret set NAME")}`);
    return;
  }
  for (const s of list) {
    const bound = bindings.filter((b) => b.secretName === s.name);
    say.info(`${c.bold(s.name)}  v${s.version}  ${c.dim(`${bound.length} binding${bound.length === 1 ? "" : "s"}`)}`);
    for (const b of bound) say.info(c.dim(`    agent ${b.agentId} · ${b.toolName ?? "every tool"} · ${b.id}`));
  }
}

export async function runSecretSet(options: Common & { name: string; value?: string }): Promise<void> {
  const { base, company } = await connect(options);
  let value = options.value;
  if (value === undefined) {
    if (!stdin.isTTY) value = (await readAll()).trim();
    else {
      const rl = createInterface({ input: stdin, output: stdout });
      value = (await rl.question(`Value for ${options.name} (not echoed in logs): `)).trim();
      rl.close();
    }
  }
  if (!value) throw new Error("the value is empty");
  const info = await api<{ name: string; version: number }>(base, `/v1/companies/${company.id}/secrets`, { method: "PUT", body: JSON.stringify({ name: options.name, value }) });
  say.ok(`Secret ${info.name} stored (version ${info.version}). Bind it to an agent with ${c.cyan(`o4r secret bind ${info.name} --agent <name>`)}`);
}

export async function runSecretRemove(options: Common & { name: string }): Promise<void> {
  const { base, company } = await connect(options);
  await api(base, `/v1/companies/${company.id}/secrets/${options.name}`, { method: "DELETE" });
  say.ok(`Secret ${options.name} removed with its bindings`);
}

export async function runSecretBind(options: Common & { name: string; agent: string; tool?: string }): Promise<void> {
  const { base, company } = await connect(options);
  const agent = await resolveAgent(base, company.id, options.agent);
  await api(base, `/v1/companies/${company.id}/secret-bindings`, {
    method: "POST",
    body: JSON.stringify({ secretName: options.name, agentId: agent.id, ...(options.tool ? { toolName: options.tool } : {}) }),
  });
  say.ok(`${options.name} is available to ${agent.name} in ${options.tool ?? "every tool"} as an environment variable`);
}

export async function runSecretUnbind(options: Common & { id: string }): Promise<void> {
  const { base, company } = await connect(options);
  await api(base, `/v1/companies/${company.id}/secret-bindings/${options.id}`, { method: "DELETE" });
  say.ok("Binding removed");
}

async function readAll(): Promise<string> {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}
