/**
 * `o4r agent`: the team from the command line — who is there, pause, resume,
 * archive (they stop working and leave the org chart; history, costs and
 * what they learned stay) and bring back.
 */

import { api, resolveAgent, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  model: string | null;
  reportsToAgentId?: string | null;
}

export async function runAgentList(options: Common & { all?: boolean }): Promise<void> {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const agents = await api<AgentRow[]>(base, `/v1/companies/${company.id}/agents`);
  const shown = options.all ? agents : agents.filter((a) => a.status !== "archived");
  if (shown.length === 0) return say.info(`No agents in ${company.name}${options.all ? "" : " (o4r agent list --all shows the archived ones)"}`);
  for (const a of shown) say.info(`${c.bold(a.name)}  ${a.role || "—"}  ${a.status}  ${c.dim(a.model ?? "default model")}  ${c.dim(a.id)}`);
  const archived = agents.length - agents.filter((a) => a.status !== "archived").length;
  if (!options.all && archived > 0) say.info(c.dim(`${archived} archived: o4r agent list --all`));
}

async function setStatus(options: Common & { name: string }, status: "active" | "paused" | "archived", done: string): Promise<void> {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const agent = await resolveAgent(base, company.id, options.name);
  await api(base, `/v1/agents/${agent.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
  say.ok(`${agent.name} ${done}`);
}

export const runAgentPause = (o: Common & { name: string }) => setStatus(o, "paused", "paused: no new work until resumed");
export const runAgentResume = (o: Common & { name: string }) => setStatus(o, "active", "is back at work");
export const runAgentArchive = (o: Common & { name: string }) =>
  setStatus(o, "archived", "archived: out of the org chart, history and learning kept (o4r agent restore to bring them back)");
export const runAgentRestore = (o: Common & { name: string }) => setStatus(o, "active", "restored and active");
