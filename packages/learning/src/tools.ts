/**
 * Learning tools for agents: search memory, save a note now (it goes to the
 * store, not into the live prompt), load the full body of a skill, save or
 * improve a skill of one's own.
 */

import type { NativeTool } from "@opifer/runtime";
import type { MemoryService } from "./memory.js";
import { renderSkillMarkdown, type SkillService } from "./skills.js";
import { LearningError } from "./types.js";

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    if (required) throw new Error(`missing parameter "${key}"`);
    return "";
  }
  return value;
}

export const LEARNING_GUIDE = `Your memory holds what you learned in earlier work; the snapshot in this prompt is a summary — memory_search finds more. Before a job you have done before, load the matching skill with skill_load and follow it. When you notice something worth keeping (a preference, a fact about a system, a pitfall), save it with memory_save; when a procedure worked and will repeat, save it with skill_save so next time is faster and cheaper.`;

export function learningTools(memories: MemoryService, skills: SkillService): NativeTool[] {
  const search: NativeTool = {
    risk: "low",
    definition: {
      name: "memory_search",
      description: "Searches your memory (and your team's and the company's) for notes and profiles matching a question or a few words.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "number" } },
      },
    },
    async execute(args, context) {
      const hits = await memories.search(context.companyId, context.agentId, str(args, "query"), {
        limit: typeof args["limit"] === "number" ? Math.min(20, args["limit"]) : 8,
      });
      if (hits.length === 0) return { content: "Nothing in memory matches." };
      return {
        content: hits
          .map(
            (h) =>
              `- [${h.memory.id.slice(0, 8)}${h.memory.scope !== "agent" ? ` · ${h.memory.scope}` : ""}] ${h.memory.subject ? `${h.memory.subject}: ` : ""}${h.memory.content}`,
          )
          .join("\n"),
      };
    },
  };

  const save: NativeTool = {
    risk: "low",
    definition: {
      name: "memory_save",
      description:
        "Saves a short note to your memory for next time: a preference of a person, a fact about a system, a convention, a pitfall. One or two sentences. It is stored now and enters your prompt from the next session.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string" },
          kind: { type: "string", enum: ["note", "profile"] },
          subject: {
            type: "string",
            description: "For a profile: the person or system it is about.",
          },
        },
      },
    },
    async execute(args, context) {
      try {
        const memory = await memories.remember(
          {
            companyId: context.companyId,
            scope: "agent",
            scopeAgentId: context.agentId,
            kind: args["kind"] === "profile" ? "profile" : "note",
            subject: str(args, "subject", false),
            content: str(args, "content"),
            source: {
              sessionId: context.sessionId,
              runId: context.runId,
              taskId: context.taskId ?? null,
            },
          },
          { kind: "agent", id: context.agentId },
        );
        return { content: `Saved to memory (${memory.id.slice(0, 8)}).` };
      } catch (error) {
        return {
          content: error instanceof LearningError ? error.message : String(error),
          isError: true,
        };
      }
    },
  };

  const load: NativeTool = {
    risk: "low",
    definition: {
      name: "skill_load",
      description: "Loads the full text of one of your available skills (the prompt lists their names) so you can follow it step by step.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
    async execute(args, context) {
      const skill = await skills.resolve(context.companyId, context.agentId, str(args, "name"));
      if (!skill)
        return {
          content: `No skill named "${str(args, "name")}" is available to you.`,
          isError: true,
        };
      const version = await skills.version(context.companyId, skill.id);
      if (!version) return { content: "The skill has no content.", isError: true };
      await skills.recordUse(context.companyId, skill.id, {
        agentId: context.agentId,
        sessionId: context.sessionId,
        runId: context.runId,
        taskId: context.taskId ?? null,
      });
      const files = Object.keys(version.files);
      return {
        content: renderSkillMarkdown(skill, version) + (files.length > 0 ? `\n\nFiles:\n${files.map((f) => `--- ${f} ---\n${version.files[f]}`).join("\n")}` : ""),
      };
    },
  };

  const saveSkill: NativeTool = {
    risk: "low",
    definition: {
      name: "skill_save",
      description:
        "Saves a procedure that worked as a skill of yours (or improves one you own): a name (lowercase, dashes), a one-line description of when to use it, and the steps in Markdown. Every save is a new version.",
      inputSchema: {
        type: "object",
        required: ["name", "description", "content"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    async execute(args, context) {
      const name = str(args, "name").trim().toLowerCase();
      const actor = { kind: "agent" as const, id: context.agentId };
      try {
        const existing = await skills.resolve(context.companyId, context.agentId, name);
        if (existing && existing.scope === "agent" && existing.scopeAgentId === context.agentId) {
          if (existing.pinned)
            return {
              content: `The skill "${name}" is pinned by a person: propose the change in a comment instead.`,
              isError: true,
            };
          const { version } = await skills.update(
            context.companyId,
            existing.id,
            {
              description: str(args, "description"),
              content: str(args, "content"),
              note: "improved by the agent",
            },
            actor,
          );
          return {
            content: `Skill "${name}" updated to version ${version.version}.`,
          };
        }
        if (existing)
          return {
            content: `"${name}" is a ${existing.scope} skill you cannot change; pick another name or ask a person.`,
            isError: true,
          };
        const skill = await skills.create(
          {
            companyId: context.companyId,
            scope: "agent",
            scopeAgentId: context.agentId,
            name,
            description: str(args, "description"),
            content: str(args, "content"),
            origin: "agent",
            note: "saved by the agent",
          },
          actor,
        );
        return {
          content: `Skill "${skill.name}" saved. It is in your index from the next session; you can skill_load it now.`,
        };
      } catch (error) {
        return {
          content: error instanceof LearningError ? error.message : String(error),
          isError: true,
        };
      }
    },
  };

  return [search, save, load, saveSkill];
}
