/**
 * Learning API: memories (list, search, save, correct, retire, pin),
 * skills (library, versions, restore, archive, pin, import/export in the
 * agent-skills format), promotions, reviews and the company's learning
 * settings.
 */

import { LearningError, parseSkillMarkdown, renderSkillMarkdown, type LearningService, type Scope } from "@opifer/learning";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Governance } from "../governance.js";

export interface LearningRoutesOptions {
  learning: LearningService;
  governance: Governance | null;
}

const person = { kind: "person" as const };
const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;
const scope = { type: "string", enum: ["agent", "team", "company"] } as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LearningError)
      return reply
        .code(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 400)
        .send({ error: error.message, code: error.code });
    return reply.code(400).send({ error: message(error) });
  }
}

export function registerLearningRoutes(app: FastifyInstance, options: LearningRoutesOptions): void {
  const { learning } = options;
  const bus = app.opifer.bus;

  // --- Settings ---------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/learning", async (request) => ({
    ...(await learning.settings.get(request.params.id)),
    semanticSearch: learning.memories.semantic,
  }));

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/companies/:id/learning",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            reviewEnabled: { type: "boolean" },
            promotion: {
              type: "string",
              enum: ["automatic", "review", "forbidden"],
            },
            promotionThreshold: { type: "integer", minimum: 1, maximum: 100 },
            snapshotMaxChars: {
              type: "integer",
              minimum: 500,
              maximum: 60_000,
            },
            inactiveAfterDays: { type: "integer", minimum: 1, maximum: 3650 },
            archiveAfterDays: { type: "integer", minimum: 1, maximum: 3650 },
          },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.settings.update(request.params.id, request.body as never, person)),
  );

  // --- Memories ----------------------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: {
      agent?: string;
      scope?: Scope;
      scopeAgentId?: string;
      status?: string;
      q?: string;
      limit?: string;
    };
  }>("/companies/:id/memories", async (request) => {
    const { agent, q, status, limit } = request.query;
    const statuses = status ? (status.split(",") as Array<"active" | "retired" | "superseded">) : undefined;
    if (q && agent)
      return (
        await learning.memories.search(request.params.id, agent, q, {
          limit: limit ? Number(limit) : 20,
          includeRetired: statuses?.includes("retired") ?? false,
        })
      ).map((h) => ({ ...h.memory, score: h.score }));
    return learning.memories.list(request.params.id, {
      ...(agent ? { agentView: agent } : {}),
      ...(request.query.scope ? { scope: request.query.scope } : {}),
      ...(request.query.scopeAgentId ? { scopeAgentId: request.query.scopeAgentId } : {}),
      ...(statuses ? { status: statuses } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  });

  app.post<{
    Params: { id: string };
    Body: {
      scope: Scope;
      scopeAgentId?: string | null;
      kind?: "note" | "profile";
      subject?: string;
      content: string;
      pinned?: boolean;
    };
  }>(
    "/companies/:id/memories",
    {
      schema: {
        body: {
          type: "object",
          required: ["scope", "content"],
          additionalProperties: false,
          properties: {
            scope,
            scopeAgentId: nullableUuid,
            kind: { type: "string", enum: ["note", "profile"] },
            subject: { type: "string", maxLength: 200 },
            content: { type: "string", minLength: 1, maxLength: 4000 },
            pinned: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const memory = await learning.memories.remember({ companyId: request.params.id, ...request.body }, person);
        bus.publish("memory.saved", request.params.id, {
          memoryId: memory.id,
          scope: memory.scope,
        });
        return reply.code(201).send(memory);
      }),
  );

  app.post<{
    Params: { id: string; memoryId: string };
    Body: { content: string };
  }>(
    "/companies/:id/memories/:memoryId/correct",
    {
      schema: {
        body: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: {
            content: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.memories.correct(request.params.id, request.params.memoryId, request.body.content, person)),
  );
  app.post<{
    Params: { id: string; memoryId: string };
    Body: { reason: string };
  }>(
    "/companies/:id/memories/:memoryId/retire",
    {
      schema: {
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.memories.retire(request.params.id, request.params.memoryId, request.body.reason, person)),
  );
  app.post<{
    Params: { id: string; memoryId: string };
    Body: { pinned: boolean };
  }>(
    "/companies/:id/memories/:memoryId/pin",
    {
      schema: {
        body: {
          type: "object",
          required: ["pinned"],
          additionalProperties: false,
          properties: { pinned: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.memories.pin(request.params.id, request.params.memoryId, request.body.pinned, person)),
  );
  app.post<{
    Params: { id: string; memoryId: string };
    Body: { toScope: "team" | "company" };
  }>(
    "/companies/:id/memories/:memoryId/promote",
    {
      schema: {
        body: {
          type: "object",
          required: ["toScope"],
          additionalProperties: false,
          properties: {
            toScope: { type: "string", enum: ["team", "company"] },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const promotion = await learning.promotions.propose(request.params.id, "memory", request.params.memoryId, request.body.toScope, person);
        if (promotion.approvalId)
          bus.publish("approval.requested", request.params.id, {
            approvalId: promotion.approvalId,
            kind: "skill_promotion",
          });
        return promotion;
      }),
  );

  // --- Skills ------------------------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: {
      agent?: string;
      scope?: Scope;
      scopeAgentId?: string;
      status?: string;
    };
  }>("/companies/:id/skills", async (request) => {
    const statuses: Array<"active" | "inactive" | "archived"> = request.query.status
      ? (request.query.status.split(",") as Array<"active" | "inactive" | "archived">)
      : ["active", "inactive", "archived"];
    return learning.skills.list(request.params.id, {
      ...(request.query.agent ? { agentView: request.query.agent } : {}),
      ...(request.query.scope ? { scope: request.query.scope } : {}),
      ...(request.query.scopeAgentId ? { scopeAgentId: request.query.scopeAgentId } : {}),
      status: statuses,
    });
  });

  app.post<{
    Params: { id: string };
    Body: {
      scope: Scope;
      scopeAgentId?: string | null;
      name: string;
      description: string;
      content: string;
      tags?: string[];
      pinned?: boolean;
      origin?: "person" | "imported";
    };
  }>(
    "/companies/:id/skills",
    {
      schema: {
        body: {
          type: "object",
          required: ["scope", "name", "description", "content"],
          additionalProperties: false,
          properties: {
            scope,
            scopeAgentId: nullableUuid,
            name: { type: "string", minLength: 1, maxLength: 64 },
            description: { type: "string", minLength: 1, maxLength: 500 },
            content: { type: "string", minLength: 1, maxLength: 200_000 },
            tags: {
              type: "array",
              items: { type: "string", maxLength: 40 },
              maxItems: 20,
            },
            pinned: { type: "boolean" },
            origin: { type: "string", enum: ["person", "imported"] },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const { origin, ...rest } = request.body;
        const skill = await learning.skills.create({ companyId: request.params.id, ...rest, origin: origin ?? "person" }, person);
        bus.publish("skill.created", request.params.id, {
          skillId: skill.id,
          name: skill.name,
          scope: skill.scope,
        });
        return reply.code(201).send(skill);
      }),
  );

  /** Import a SKILL.md as sent (header gives name and description unless given). */
  app.post<{
    Params: { id: string };
    Body: {
      scope: Scope;
      scopeAgentId?: string | null;
      markdown: string;
      name?: string;
      files?: Record<string, string>;
    };
  }>(
    "/companies/:id/skills/import",
    {
      schema: {
        body: {
          type: "object",
          required: ["scope", "markdown"],
          additionalProperties: false,
          properties: {
            scope,
            scopeAgentId: nullableUuid,
            markdown: { type: "string", minLength: 1, maxLength: 400_000 },
            name: { type: "string", maxLength: 64 },
            files: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const parsed = parseSkillMarkdown(request.body.markdown);
        const name = request.body.name ?? parsed.name;
        if (!name) throw new LearningError("invalid_input", "the SKILL.md header has no name: pass one");
        const skill = await learning.skills.create(
          {
            companyId: request.params.id,
            scope: request.body.scope,
            scopeAgentId: request.body.scopeAgentId ?? null,
            name,
            description: parsed.description || name,
            content: parsed.content,
            tags: parsed.tags,
            files: request.body.files ?? {},
            origin: "imported",
            note: "imported",
          },
          person,
        );
        return reply.code(201).send(skill);
      }),
  );

  app.get<{ Params: { id: string; skillId: string } }>("/companies/:id/skills/:skillId", async (request, reply) => {
    const skill = await learning.skills.get(request.params.id, request.params.skillId);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const [version, versions, usage, promotions] = await Promise.all([
      learning.skills.version(request.params.id, skill.id),
      learning.skills.versions(request.params.id, skill.id),
      learning.skills.usage(request.params.id, skill.id),
      learning.promotions.list(request.params.id),
    ]);
    return {
      ...skill,
      version,
      versions: versions.map((v) => ({
        version: v.version,
        note: v.note,
        createdAt: v.createdAt,
        createdByKind: v.createdByKind,
        description: v.description,
      })),
      usage: {
        successes: usage.successes,
        failures: usage.failures,
        recent: usage.uses.slice(0, 20),
      },
      promotions: promotions.filter((p) => p.subjectId === skill.id),
    };
  });

  app.get<{
    Params: { id: string; skillId: string };
    Querystring: { version?: string };
  }>("/companies/:id/skills/:skillId/export", async (request, reply) => {
    const skill = await learning.skills.get(request.params.id, request.params.skillId);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const version = await learning.skills.version(request.params.id, skill.id, request.query.version ? Number(request.query.version) : undefined);
    if (!version) return reply.code(404).send({ error: "version not found" });
    return {
      name: skill.name,
      markdown: renderSkillMarkdown(skill, version),
      files: version.files,
    };
  });

  app.get<{ Params: { id: string; skillId: string; version: string } }>("/companies/:id/skills/:skillId/versions/:version", async (request, reply) => {
    const version = await learning.skills.version(request.params.id, request.params.skillId, Number(request.params.version));
    return version ?? reply.code(404).send({ error: "version not found" });
  });

  app.post<{
    Params: { id: string; skillId: string };
    Body: {
      description?: string;
      content: string;
      files?: Record<string, string>;
      note?: string;
      tags?: string[];
    };
  }>(
    "/companies/:id/skills/:skillId/versions",
    {
      schema: {
        body: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: {
            description: { type: "string", maxLength: 500 },
            content: { type: "string", minLength: 1, maxLength: 200_000 },
            files: { type: "object", additionalProperties: { type: "string" } },
            note: { type: "string", maxLength: 500 },
            tags: { type: "array", items: { type: "string", maxLength: 40 } },
          },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.skills.update(request.params.id, request.params.skillId, request.body, person)),
  );
  app.post<{ Params: { id: string; skillId: string; version: string } }>("/companies/:id/skills/:skillId/versions/:version/restore", async (request, reply) =>
    handle(reply, () => learning.skills.restore(request.params.id, request.params.skillId, Number(request.params.version), person)),
  );
  app.post<{
    Params: { id: string; skillId: string };
    Body: { status: "active" | "inactive" | "archived"; reason?: string };
  }>(
    "/companies/:id/skills/:skillId/status",
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["active", "inactive", "archived"],
            },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.skills.setStatus(request.params.id, request.params.skillId, request.body.status, person, request.body.reason ?? "")),
  );
  app.post<{
    Params: { id: string; skillId: string };
    Body: { pinned: boolean };
  }>(
    "/companies/:id/skills/:skillId/pin",
    {
      schema: {
        body: {
          type: "object",
          required: ["pinned"],
          additionalProperties: false,
          properties: { pinned: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => handle(reply, () => learning.skills.pin(request.params.id, request.params.skillId, request.body.pinned, person)),
  );
  app.post<{
    Params: { id: string; skillId: string };
    Body: { toScope: "team" | "company" };
  }>(
    "/companies/:id/skills/:skillId/promote",
    {
      schema: {
        body: {
          type: "object",
          required: ["toScope"],
          additionalProperties: false,
          properties: {
            toScope: { type: "string", enum: ["team", "company"] },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const promotion = await learning.promotions.propose(request.params.id, "skill", request.params.skillId, request.body.toScope, person);
        if (promotion.approvalId)
          bus.publish("approval.requested", request.params.id, {
            approvalId: promotion.approvalId,
            kind: "skill_promotion",
          });
        return promotion;
      }),
  );

  // --- Promotions, reviews, curator ------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/companies/:id/promotions", async (request) =>
    learning.promotions.list(request.params.id, request.query.status ? (request.query.status.split(",") as never) : undefined),
  );
  app.get<{
    Params: { id: string };
    Querystring: { agent?: string; limit?: string };
  }>("/companies/:id/learning/reviews", async (request) =>
    learning.reviewer.list(request.params.id, {
      ...(request.query.agent ? { agentId: request.query.agent } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }),
  );
  app.post<{ Params: { id: string } }>("/companies/:id/learning/curate", async (request, reply) =>
    handle(reply, async () => {
      const settings = await learning.settings.get(request.params.id);
      return learning.skills.curate(request.params.id, {
        inactiveAfterDays: settings.inactiveAfterDays,
        archiveAfterDays: settings.archiveAfterDays,
      });
    }),
  );
  /** Runs pending reviews now (the worker does it by itself every few seconds). */
  app.post<{ Params: { id: string } }>("/companies/:id/learning/reviews/run", async () => ({ done: (await app.opifer.learningWorker?.tick()) ?? 0 }));

  /** What an agent would see at the start of its next session. */
  app.get<{ Params: { id: string; agentId: string } }>("/companies/:id/agents/:agentId/learning-snapshot", async (request) =>
    learning.snapshot(request.params.id, request.params.agentId),
  );
  void uuid;
}
