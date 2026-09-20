/**
 * Tasks from the terminal: list, create and assign, show with the why
 * chain and comments, comment, review. Everything goes through the server.
 */

import { api, resolveAgent, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  parentId: string | null;
  createdAt: string;
  result: { summary: string; verification?: string } | null;
  blockedReason: string | null;
}

interface TaskDetail extends Task {
  description: string;
  acceptance: string;
  why: { mission: string | null; companyName: string; goals: Array<{ title: string }>; project: { name: string } | null; parents: Array<{ title: string }> };
  comments: Array<{ authorKind: string; authorId: string | null; body: string; createdAt: string }>;
  products: Array<{ kind: string; title: string; ref: string; summary: string }>;
  children: Task[];
  sessions: Array<{ id: string; running: boolean }>;
  cost: { eur: number; calls: number };
}

const statusColour = (s: string) =>
  s === "done" ? c.green(s) : s === "in_progress" ? c.cyan(s) : s === "in_review" || s === "blocked" ? c.yellow(s) : s === "cancelled" ? c.dim(s) : s;

async function connect(options: Common) {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const agents = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/agents`);
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name ?? (id ? "?" : "—");
  return { base, company, agents, nameOf };
}

export async function runTaskList(options: Common & { status?: string; all?: boolean; mine?: boolean; agent?: string }): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  else if (!options.all) params.set("status", "todo,in_progress,in_review,blocked");
  if (options.agent) params.set("agentId", (await resolveAgent(base, company.id, options.agent)).id);
  const tasks = await api<Task[]>(base, `/v1/companies/${company.id}/tasks?${params}`);
  if (tasks.length === 0) {
    say.info(`No tasks in ${company.name}. Create one with ${c.cyan('o4r task create "Title" --agent Philip')}`);
    return;
  }
  for (const t of tasks) {
    const indent = t.parentId ? "    " : "";
    say.info(`${indent}${statusColour(t.status).padEnd(20)} ${c.bold(t.title)}  ${c.dim(`${t.priority} · ${nameOf(t.assigneeAgentId)} · ${t.id.slice(0, 8)}`)}`);
    if (t.status === "blocked" && t.blockedReason) say.info(`${indent}  ${c.yellow(t.blockedReason)}`);
  }
}

export async function runTaskCreate(
  options: Common & { title: string; agent?: string; description?: string; acceptance?: string; priority?: string; project?: string; parent?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const body: Record<string, unknown> = { title: options.title };
  if (options.description) body["description"] = options.description;
  if (options.acceptance) body["acceptance"] = options.acceptance;
  if (options.priority) body["priority"] = options.priority;
  if (options.parent) body["parentId"] = options.parent;
  if (options.agent) body["assigneeAgentId"] = (await resolveAgent(base, company.id, options.agent)).id;
  if (options.project) {
    const projects = await api<Array<{ id: string; name: string }>>(base, `/v1/companies/${company.id}/projects`);
    const project = projects.find((p) => p.name.toLowerCase() === options.project!.toLowerCase() || p.id === options.project);
    if (!project) throw new Error(`Project "${options.project}" not found. Available: ${projects.map((p) => p.name).join(", ") || "none"}`);
    body["projectId"] = project.id;
  }
  const task = await api<Task>(base, `/v1/companies/${company.id}/tasks`, { method: "POST", body: JSON.stringify(body) });
  say.ok(`Task created: ${c.bold(task.title)} (${task.id})${options.agent ? ` — ${options.agent} has been woken up` : ""}`);
}

export async function runTaskShow(options: Common & { id: string }): Promise<void> {
  const { base, nameOf } = await connect(options);
  const t = await api<TaskDetail>(base, `/v1/tasks/${options.id}`);
  say.info(`${c.bold(t.title)}  ${statusColour(t.status)} · ${t.priority} · ${nameOf(t.assigneeAgentId)}`);
  if (t.description) say.info(t.description);
  if (t.acceptance) say.info(`${c.dim("Done when:")} ${t.acceptance}`);
  say.info(c.dim("Why:"));
  if (t.why.mission) say.info(`  mission: ${t.why.mission}`);
  for (const g of t.why.goals) say.info(`  goal: ${g.title}`);
  if (t.why.project) say.info(`  project: ${t.why.project.name}`);
  for (const p of t.why.parents) say.info(`  part of: ${p.title}`);
  if (t.blockedReason) say.warn(`Blocked: ${t.blockedReason}`);
  if (t.result) say.info(`${c.dim("Result:")} ${t.result.summary}${t.result.verification ? ` ${c.dim(`(verify: ${t.result.verification})`)}` : ""}`);
  if (t.products.length > 0) {
    say.info(c.dim("Products:"));
    for (const p of t.products) say.info(`  ${p.kind} ${c.bold(p.title)} ${c.dim(p.ref)}`);
  }
  if (t.children.length > 0) {
    say.info(c.dim("Subtasks:"));
    for (const ch of t.children) say.info(`  ${statusColour(ch.status).padEnd(20)} ${ch.title} ${c.dim(`· ${nameOf(ch.assigneeAgentId)} · ${ch.id.slice(0, 8)}`)}`);
  }
  if (t.comments.length > 0) {
    say.info(c.dim("Comments:"));
    for (const cm of t.comments) say.info(`  ${c.bold(cm.authorKind === "agent" ? nameOf(cm.authorId) : cm.authorKind === "person" ? "you" : "system")}: ${cm.body}`);
  }
  say.info(c.dim(`${t.cost.calls} calls · ${t.cost.eur.toFixed(4)} EUR · ${t.sessions.length} session(s)${t.sessions.some((s) => s.running) ? " · running now" : ""}`));
}

export async function runTaskComment(options: Common & { id: string; body: string }): Promise<void> {
  const base = await serverBase(options.home);
  await api(base, `/v1/tasks/${options.id}/comments`, { method: "POST", body: JSON.stringify({ body: options.body }) });
  say.ok("Comment posted; mentioned agents and the assignee have been woken up");
}

export async function runTaskAction(
  action: "complete" | "request-changes" | "block" | "unblock" | "cancel" | "wake" | "release",
  options: Common & { id: string; note?: string; verification?: string },
): Promise<void> {
  const base = await serverBase(options.home);
  const body =
    action === "complete"
      ? { summary: options.note ?? "Verified by a person", ...(options.verification ? { verification: options.verification } : {}) }
      : action === "request-changes"
        ? { note: options.note ?? "please revise" }
        : action === "block"
          ? { reason: options.note ?? "blocked by a person" }
          : action === "cancel" || action === "release"
            ? { reason: options.note ?? "" }
            : {};
  const task = await api<Task>(base, `/v1/tasks/${options.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
  say.ok(`${task.title}: ${statusColour(task.status)}`);
}

export async function runTaskAssign(options: Common & { id: string; agent: string }): Promise<void> {
  const { base, company } = await connect(options);
  const agent = await resolveAgent(base, company.id, options.agent);
  const task = await api<Task>(base, `/v1/tasks/${options.id}/assign`, { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
  say.ok(`${task.title} → ${agent.name} (woken up)`);
}
