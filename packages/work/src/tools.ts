/**
 * Task tools for agents: see the task, comment, delegate a subtask, deliver
 * a result for review, or block and ask for help. They act on the task of
 * the session (ToolContext.taskId) and speak in plain words.
 */

import type { Sql } from "postgres";
import type { NativeTool, ToolContext, ToolOutcome, ToolScope } from "@opifer/runtime";
import type { WorkService } from "./service.js";
import type { Task, TaskPriority, WhyChain, WorkProductKind } from "./types.js";

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    if (required) throw new Error(`missing parameter "${key}"`);
    return "";
  }
  return value;
}

/** The task as text for the model: the why first, then the what. */
export function describeTask(task: Task, why: WhyChain, extra: { comments?: Array<{ author: string; body: string }> } = {}): string {
  const lines: string[] = [];
  lines.push(`Task: ${task.title}`);
  lines.push(`Status: ${task.status} · priority ${task.priority}${task.dueAt ? ` · due ${task.dueAt.toISOString().slice(0, 10)}` : ""}`);
  if (task.description.trim()) lines.push(`\n${task.description.trim()}`);
  if (task.acceptance.trim()) lines.push(`\nDone when: ${task.acceptance.trim()}`);
  lines.push("\nWhy this matters:");
  if (why.mission) lines.push(`- Company mission (${why.companyName}): ${why.mission}`);
  for (const goal of why.goals) lines.push(`- Goal: ${goal.title}${goal.measure ? ` (measured by: ${goal.measure})` : ""}`);
  if (why.project) lines.push(`- Project: ${why.project.name}${why.project.description ? ` — ${why.project.description}` : ""}`);
  if (why.project?.repoUrl)
    lines.push(
      `- Repository: ${why.project.repoUrl}${why.project.branch ? ` (branch ${why.project.branch})` : ""}, ${why.project.repoStatus === "cloned" ? "cloned in your working directory" : `not cloned (${why.project.repoDetail || why.project.repoStatus})`}. ${ENGINEER_GUIDE}`,
    );
  for (const parent of why.parents) lines.push(`- Part of: ${parent.title}`);
  if (task.result?.summary) lines.push(`\nDelivered result: ${task.result.summary}${task.result.verification ? `\nHow to verify: ${task.result.verification}` : ""}`);
  if (extra.comments && extra.comments.length > 0) {
    lines.push("\nRecent comments:");
    for (const c of extra.comments.slice(-8)) lines.push(`- ${c.author}: ${c.body}`);
  }
  return lines.join("\n");
}

/** How to work on a repository: explore, change precisely, test, commit on a branch, deliver the diff. */
export const ENGINEER_GUIDE = `Work like an engineer: read before you change (list_files, search_files, read_file); make precise changes with edit_file or apply_patch, write_file for new files; run the build and the tests in the terminal and fix what breaks; commit on a branch named after the task (git checkout -b, git add, git commit -m) and push it when the company gave you a token for the repository (git push -u origin <branch>); for a large piece of work hand a full brief to run_coder when it is available. Deliver with the branch, the commits, the diff stat and how the result was verified.`;

export const TASK_GUIDE = `You work on tasks. Use the task tools: task_status to re-read the task, task_comment to report progress or ask the people following it, task_create to delegate a subtask to someone who reports to you (or to yourself), task_deliver when the result is ready for review, task_block when you cannot continue. When you delegate, you are the reviewer of that subtask: you will be woken up when it is delivered, and you close it with task_approve or send it back with task_request_changes. A parent task is delivered only after its subtasks are closed; while you wait, end your turn and you will be woken up. A task closes only with a verifiable result: say what you produced and how it can be checked.`;

const onlyInTask = (scope: ToolScope) => Boolean(scope.taskId);

export const CHAT_GUIDE = `In a conversation you are not working on a task: use company_status to see how the company is doing (who is working on what, what waits for a person, routines, spend), task_list to follow tasks, and task_create to hand out work to yourself or to the agents that report to you — the assignee starts at once and you review the result. Do not promise a report you cannot produce: create the tasks that will produce it.`;

export function taskTools(work: WorkService, sql: Sql): NativeTool[] {
  const requireTask = async (context: ToolContext): Promise<Task | ToolOutcome> => {
    if (!context.taskId) return { content: "This conversation is not attached to a task.", isError: true };
    const task = await work.getTask(context.companyId, context.taskId);
    if (!task) return { content: "The task no longer exists.", isError: true };
    return task;
  };
  const isOutcome = (v: Task | ToolOutcome): v is ToolOutcome => "content" in v;
  const actor = (context: ToolContext) => ({ kind: "agent" as const, id: context.agentId });

  const status: NativeTool = {
    when: onlyInTask,
    risk: "low",
    definition: {
      name: "task_status",
      description: "Shows the task you are working on: title, description, acceptance criterion, why it matters, recent comments and subtasks.",
      inputSchema: { type: "object", properties: {} },
    },
    async execute(_args, context) {
      const task = await requireTask(context);
      if (isOutcome(task)) return task;
      const why = await work.whyChain(context.companyId, task);
      const comments = await work.listComments(context.companyId, task.id);
      const agents = await sql<{ id: string; name: string }[]>`SELECT id, name FROM agents WHERE company_id = ${context.companyId}`;
      const nameOf = (kind: string, id: string | null) => (kind === "agent" ? (agents.find((a) => a.id === id)?.name ?? "agent") : kind === "person" ? "a person" : "system");
      const children = await work.listTasks(context.companyId, { parentId: task.id });
      const text = describeTask(task, why, { comments: comments.map((c) => ({ author: nameOf(c.authorKind, c.authorId), body: c.body })) });
      const subtasks =
        children.length > 0
          ? `\n\nSubtasks:\n${children.map((c) => `- [${c.status}] ${c.title} → ${agents.find((a) => a.id === c.assigneeAgentId)?.name ?? "unassigned"}${c.result?.summary ? ` — ${c.result.summary}` : ""}`).join("\n")}`
          : "";
      const products = await work.listProducts(context.companyId, task.id);
      const produced = products.length > 0 ? `\n\nProducts:\n${products.map((p) => `- ${p.kind}: ${p.title}${p.ref ? ` (${p.ref})` : ""}`).join("\n")}` : "";
      return { content: text + produced + subtasks };
    },
  };

  const comment: NativeTool = {
    when: onlyInTask,
    risk: "low",
    definition: {
      name: "task_comment",
      description: "Leaves a comment on the task: progress, a question for the people following it, a note for a colleague (mention with @Name to wake them).",
      inputSchema: { type: "object", required: ["body"], properties: { body: { type: "string" } } },
    },
    async execute(args, context) {
      const task = await requireTask(context);
      if (isOutcome(task)) return task;
      const c = await work.comment(context.companyId, task.id, actor(context), str(args, "body"));
      return { content: `Comment posted${c.mentions.length > 0 ? ` (${c.mentions.length} mentioned)` : ""}.` };
    },
  };

  const create: NativeTool = {
    risk: "medium",
    definition: {
      name: "task_create",
      description:
        "Creates a task and assigns it: inside a task it is a subtask of the current one, in a conversation it is a new top-level task. You can delegate only to agents that report to you, or keep it for yourself. The assignee wakes up and works on it; you are its reviewer and will be woken up when it is delivered.",
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "string", description: "What makes the result verifiable." },
          assignee: { type: "string", description: "Name of the agent, or omit for yourself." },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        },
      },
    },
    async execute(args, context) {
      const task = context.taskId ? await requireTask(context) : null;
      if (task && isOutcome(task)) return task;
      const assigneeName = str(args, "assignee", false);
      let assigneeId = context.agentId;
      if (assigneeName) {
        const [target] = await sql<
          { id: string; reports_to_agent_id: string | null }[]
        >`SELECT id, reports_to_agent_id FROM agents WHERE company_id = ${context.companyId} AND lower(name) = ${assigneeName.toLowerCase()} AND status = 'active'`;
        if (!target) return { content: `No active agent named "${assigneeName}" in the company.`, isError: true };
        if (target.id !== context.agentId && target.reports_to_agent_id !== context.agentId)
          return { content: `${assigneeName} does not report to you: you can delegate only downward. Ask upward with a comment instead.`, isError: true };
        assigneeId = target.id;
      }
      const priority = (typeof args["priority"] === "string" ? args["priority"] : "normal") as TaskPriority;
      const created = await work.createTask(
        {
          companyId: context.companyId,
          title: str(args, "title"),
          description: str(args, "description", false),
          acceptance: str(args, "acceptance", false),
          parentId: task?.id ?? null,
          assigneeAgentId: assigneeId,
          // The delegator reviews the work of a report; nobody reviews their own.
          reviewerAgentId: assigneeId === context.agentId ? null : context.agentId,
          priority,
        },
        actor(context),
      );
      return {
        content: `${task ? "Subtask" : "Task"} created: "${created.title}" (${created.id}) assigned to ${assigneeName || "you"}.${assigneeId !== context.agentId ? (task ? " They will be woken up; you will be told when it is delivered." : " They will be woken up; you will review it when it is delivered, and you can follow it with task_list.") : ""}`,
      };
    },
  };

  const deliver: NativeTool = {
    when: onlyInTask,
    risk: "medium",
    definition: {
      name: "task_deliver",
      description:
        "Delivers the result of the task for review and ends your turn. State what you produced, how it can be verified, and list the products (files, links, documents, decisions).",
      inputSchema: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string", description: "What was done, in a few sentences." },
          verification: { type: "string", description: "How the reviewer can check it." },
          products: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "title"],
              properties: {
                kind: { type: "string", enum: ["file", "link", "diff", "document", "decision", "note"] },
                title: { type: "string" },
                ref: { type: "string", description: "Path, URL or the content itself." },
                summary: { type: "string" },
              },
            },
          },
        },
      },
    },
    async execute(args, context) {
      const task = await requireTask(context);
      if (isOutcome(task)) return task;
      if (task.status !== "in_progress") return { content: `The task is ${task.status}: nothing to deliver.`, isError: true };
      const open = (await work.listTasks(context.companyId, { parentId: task.id })).filter((c) => c.status !== "done" && c.status !== "cancelled");
      if (open.length > 0)
        return {
          content: `${open.length} subtask${open.length === 1 ? " is" : "s are"} still open (${open.map((c) => `"${c.title}": ${c.status}`).join(", ")}). A parent is delivered after its subtasks are closed: end your turn and you will be woken up when they are.`,
          isError: true,
        };
      const products = Array.isArray(args["products"]) ? (args["products"] as Array<Record<string, unknown>>) : [];
      for (const p of products) {
        await work.addProduct(
          context.companyId,
          task.id,
          {
            kind: (typeof p["kind"] === "string" ? p["kind"] : "note") as WorkProductKind,
            title: typeof p["title"] === "string" ? p["title"] : "result",
            ref: typeof p["ref"] === "string" ? p["ref"] : "",
            summary: typeof p["summary"] === "string" ? p["summary"] : "",
            runId: context.runId,
          },
          actor(context),
        );
      }
      const verification = str(args, "verification", false);
      await work.requestReview(context.companyId, task.id, { summary: str(args, "summary"), ...(verification ? { verification } : {}) }, actor(context), context.runId);
      return { content: "Delivered for review. Your turn ends here; you will be woken up if changes are requested.", endTurn: { stopReason: "task_delivered" } };
    },
  };

  const block: NativeTool = {
    when: onlyInTask,
    risk: "low",
    definition: {
      name: "task_block",
      description:
        "Marks the task as blocked and ends your turn: use it when you cannot continue without a person (missing access, contradictory instructions, a decision above your level).",
      inputSchema: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } },
    },
    async execute(args, context) {
      const task = await requireTask(context);
      if (isOutcome(task)) return task;
      await work.block(context.companyId, task.id, str(args, "reason"), actor(context));
      return { content: "Task blocked; a person has been asked to help. Your turn ends here.", endTurn: { stopReason: "task_blocked" } };
    },
  };

  const requireReview = async (context: ToolContext): Promise<Task | ToolOutcome> => {
    const task = await requireTask(context);
    if (isOutcome(task)) return task;
    if (task.reviewerAgentId !== context.agentId) return { content: "You are not the reviewer of this task.", isError: true };
    if (task.assigneeAgentId === context.agentId) return { content: "Nobody reviews their own work.", isError: true };
    if (task.status !== "in_review") return { content: `The task is ${task.status}, not in review.`, isError: true };
    return task;
  };

  const approve: NativeTool = {
    when: onlyInTask,
    risk: "medium",
    definition: {
      name: "task_approve",
      description: "Closes the task under your review as done: use it only after checking the result against the acceptance criterion. Say what you verified.",
      inputSchema: { type: "object", required: ["verification"], properties: { verification: { type: "string", description: "What you checked and how." } } },
    },
    async execute(args, context) {
      const task = await requireReview(context);
      if (isOutcome(task)) return task;
      const done = await work.complete(context.companyId, task.id, { summary: task.result?.summary ?? task.title, verification: str(args, "verification") }, actor(context), {
        from: ["in_review"],
      });
      return { content: `Approved: "${done.title}" is done.` };
    },
  };

  const requestChanges: NativeTool = {
    when: onlyInTask,
    risk: "low",
    definition: {
      name: "task_request_changes",
      description: "Sends the task under your review back to its assignee with what must change. They are woken up.",
      inputSchema: { type: "object", required: ["note"], properties: { note: { type: "string", description: "What is missing or wrong, concretely." } } },
    },
    async execute(args, context) {
      const task = await requireReview(context);
      if (isOutcome(task)) return task;
      await work.requestChanges(context.companyId, task.id, str(args, "note"), actor(context));
      return { content: `Sent back: "${task.title}" returns to its assignee with your note.` };
    },
  };

  const list: NativeTool = {
    risk: "low",
    definition: {
      name: "task_list",
      description: "Lists the company's tasks: yours, those of your reports, or all; optionally by status. Each line shows status, title, assignee and the result when delivered.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["mine", "reports", "all"],
            description: "mine = assigned to you; reports = assigned to agents that report to you; all = the whole company (default: mine and reports).",
          },
          status: { type: "string", enum: ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"], description: "Only this status (default: open tasks)." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
    async execute(args, context) {
      const agents = await sql<
        { id: string; name: string; reports_to_agent_id: string | null }[]
      >`SELECT id, name, reports_to_agent_id FROM agents WHERE company_id = ${context.companyId}`;
      const scope = typeof args["scope"] === "string" ? args["scope"] : "team";
      const status = typeof args["status"] === "string" ? [args["status"] as Task["status"]] : (["todo", "in_progress", "in_review", "blocked"] as Task["status"][]);
      const limit = typeof args["limit"] === "number" ? args["limit"] : 40;
      const mine = new Set([context.agentId, ...agents.filter((a) => a.reports_to_agent_id === context.agentId).map((a) => a.id)]);
      const tasks = (await work.listTasks(context.companyId, { status })).filter((t) =>
        scope === "all"
          ? true
          : scope === "mine"
            ? t.assigneeAgentId === context.agentId
            : scope === "reports"
              ? t.assigneeAgentId !== context.agentId && mine.has(t.assigneeAgentId ?? "")
              : mine.has(t.assigneeAgentId ?? ""),
      );
      if (tasks.length === 0) return { content: "No tasks match." };
      const nameOf = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? "agent") : "unassigned");
      return {
        content: tasks
          .slice(0, limit)
          .map(
            (t) =>
              `- [${t.status}] ${t.title} (${t.id.slice(0, 8)}) → ${nameOf(t.assigneeAgentId)}${t.result?.summary ? ` — ${t.result.summary.slice(0, 160)}` : ""}${t.blockedReason ? ` — blocked: ${t.blockedReason.slice(0, 120)}` : ""}`,
          )
          .join("\n"),
      };
    },
  };

  const companyStatus: NativeTool = {
    risk: "low",
    definition: {
      name: "company_status",
      description:
        "How the company is doing right now: agents and what they are working on, tasks by status, what waits for a person (approvals, reviews, blocked tasks), routines and their next run, spend this month.",
      inputSchema: { type: "object", properties: {} },
    },
    async execute(_args, context) {
      const companyId = context.companyId;
      const agents = await sql<
        { id: string; name: string; role: string; status: string; reports_to_agent_id: string | null }[]
      >`SELECT id, name, role, status, reports_to_agent_id FROM agents WHERE company_id = ${companyId} ORDER BY name`;
      const open = await work.listTasks(companyId, { status: ["todo", "in_progress", "in_review", "blocked"] });
      const done = await sql<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM tasks WHERE company_id = ${companyId} AND status = 'done' AND finished_at > now() - interval '7 days'`;
      const approvals = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM approvals WHERE company_id = ${companyId} AND status = 'pending'`;
      const routines = await sql<
        { name: string; enabled: boolean; next_due_at: Date | null; last_run_at: Date | null }[]
      >`SELECT name, enabled, next_due_at, last_run_at FROM routines WHERE company_id = ${companyId} ORDER BY name`;
      const spend = await sql<
        { eur: string }[]
      >`SELECT coalesce(sum(amount_eur), 0)::text AS eur FROM cost_events WHERE company_id = ${companyId} AND occurred_at >= date_trunc('month', now())`;
      const nameOf = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? "agent") : "a person");
      const lines: string[] = [];
      lines.push("Agents:");
      for (const a of agents) {
        const theirs = open.filter((t) => t.assigneeAgentId === a.id);
        const working = theirs.filter((t) => t.status === "in_progress").map((t) => t.title);
        lines.push(
          `- ${a.name} (${a.role.split(".")[0]}${a.status !== "active" ? `, ${a.status}` : ""})${a.reports_to_agent_id ? ` reports to ${nameOf(a.reports_to_agent_id)}` : ""}: ${theirs.length} open task${theirs.length === 1 ? "" : "s"}${working.length > 0 ? `, working on ${working.map((w) => `"${w}"`).join(", ")}` : ""}`,
        );
      }
      const by = (status: Task["status"]) => open.filter((t) => t.status === status);
      lines.push(
        `\nTasks: ${by("todo").length} to do, ${by("in_progress").length} in progress, ${by("in_review").length} in review, ${by("blocked").length} blocked; ${done[0]?.n ?? 0} done in the last 7 days.`,
      );
      for (const t of [...by("blocked"), ...by("in_review"), ...by("in_progress"), ...by("todo")].slice(0, 20))
        lines.push(
          `- [${t.status}] ${t.title} → ${nameOf(t.assigneeAgentId)}${t.blockedReason ? ` — ${t.blockedReason.slice(0, 120)}` : t.result?.summary ? ` — ${t.result.summary.slice(0, 120)}` : ""}`,
        );
      lines.push(
        `\nWaiting for a person: ${approvals[0]?.n ?? 0} approval${approvals[0]?.n === "1" ? "" : "s"}, ${by("in_review").length} deliveries to verify, ${by("blocked").length} blocked task${by("blocked").length === 1 ? "" : "s"}.`,
      );
      lines.push(`\nRoutines: ${routines.length === 0 ? "none" : ""}`);
      for (const r of routines)
        lines.push(
          `- ${r.name}${r.enabled ? "" : " (disabled)"}: next ${r.next_due_at ? r.next_due_at.toISOString().slice(0, 16).replace("T", " ") : "—"}, last ${r.last_run_at ? r.last_run_at.toISOString().slice(0, 16).replace("T", " ") : "never"}`,
        );
      lines.push(`\nSpend this month: ${Number(spend[0]?.eur ?? 0).toFixed(2)} EUR.`);
      return { content: lines.join("\n") };
    },
  };

  return [status, comment, create, deliver, block, approve, requestChanges, list, companyStatus];
}
