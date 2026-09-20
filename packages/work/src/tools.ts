/**
 * Task tools for agents: see the task, comment, delegate a subtask, deliver
 * a result for review, or block and ask for help. They act on the task of
 * the session (ToolContext.taskId) and speak in plain words.
 */

import type { Sql } from "postgres";
import type { NativeTool, ToolContext, ToolOutcome } from "@opifer/runtime";
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
  for (const parent of why.parents) lines.push(`- Part of: ${parent.title}`);
  if (task.result?.summary) lines.push(`\nDelivered result: ${task.result.summary}${task.result.verification ? `\nHow to verify: ${task.result.verification}` : ""}`);
  if (extra.comments && extra.comments.length > 0) {
    lines.push("\nRecent comments:");
    for (const c of extra.comments.slice(-8)) lines.push(`- ${c.author}: ${c.body}`);
  }
  return lines.join("\n");
}

export const TASK_GUIDE = `You work on tasks. Use the task tools: task_status to re-read the task, task_comment to report progress or ask the people following it, task_create to delegate a subtask to someone who reports to you (or to yourself), task_deliver when the result is ready for review, task_block when you cannot continue. When you delegate, you are the reviewer of that subtask: you will be woken up when it is delivered, and you close it with task_approve or send it back with task_request_changes. A parent task is delivered only after its subtasks are closed; while you wait, end your turn and you will be woken up. A task closes only with a verifiable result: say what you produced and how it can be checked.`;

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
        "Creates a subtask of the current task and assigns it. You can delegate only to agents that report to you, or keep it for yourself. The assignee wakes up and works on it; you will see its result as a subtask.",
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
      const task = await requireTask(context);
      if (isOutcome(task)) return task;
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
          parentId: task.id,
          assigneeAgentId: assigneeId,
          // The delegator reviews the work of a report; nobody reviews their own.
          reviewerAgentId: assigneeId === context.agentId ? null : context.agentId,
          priority,
        },
        actor(context),
      );
      return {
        content: `Subtask created: "${created.title}" (${created.id}) assigned to ${assigneeName || "you"}.${assigneeId !== context.agentId ? " They will be woken up; check task_status later for the result." : ""}`,
      };
    },
  };

  const deliver: NativeTool = {
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

  return [status, comment, create, deliver, block, approve, requestChanges];
}
