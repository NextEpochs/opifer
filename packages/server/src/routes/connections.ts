/**
 * Connections API: tool connections (MCP servers, workflow tools), inbound
 * webhooks (`POST /v1/hooks/:id` with a bearer token), outbound event
 * subscriptions, channels and their pairings.
 */

import { ConnectionError, type ChannelService, type ConnectionService, type EventService, type WebhookService } from "@opifer/connections";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChannelHub } from "../channels.js";
import { decideApproval } from "./governance.js";
import { startTurnInBackground } from "./sessions.js";

export interface ConnectionRoutesOptions {
  connections: ConnectionService;
  webhooks: WebhookService;
  events: EventService;
  channels: ChannelService;
  hub: ChannelHub | null;
  invalidateTools: (companyId: string) => void;
}

const person = { kind: "person" as const };
const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConnectionError)
      return reply
        .code(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "forbidden" ? 403 : error.code === "unavailable" ? 503 : 400)
        .send({ error: error.message, code: error.code });
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
}

const connectionBody = {
  type: "object",
  required: ["kind", "name", "config"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["mcp_stdio", "mcp_http", "workflow"] },
    name: { type: "string", minLength: 1, maxLength: 40 },
    description: { type: "string", maxLength: 1000 },
    config: { type: "object" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    secretNames: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" }, maxItems: 20 },
    enabled: { type: "boolean" },
  },
} as const;

export function registerConnectionRoutes(app: FastifyInstance, o: ConnectionRoutesOptions): void {
  const bus = app.opifer.bus;

  // --- Tool connections ---------------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/connections", async (request) => o.connections.list(request.params.id));
  app.post<{
    Params: { id: string };
    Body: {
      kind: "mcp_stdio" | "mcp_http" | "workflow";
      name: string;
      description?: string;
      config: Record<string, unknown>;
      risk?: "low" | "medium" | "high";
      secretNames?: string[];
      enabled?: boolean;
    };
  }>("/companies/:id/connections", { schema: { body: connectionBody } }, async (request, reply) =>
    handle(reply, async () => {
      const created = await o.connections.create({ companyId: request.params.id, ...request.body }, person);
      const checked = await o.connections.check(request.params.id, created.id);
      o.invalidateTools(request.params.id);
      bus.publish("connection.created", request.params.id, { connectionId: checked.id, name: checked.name, status: checked.status });
      return reply.code(201).send(checked);
    }),
  );
  app.get<{ Params: { id: string; connectionId: string } }>(
    "/companies/:id/connections/:connectionId",
    async (request, reply) => (await o.connections.get(request.params.id, request.params.connectionId)) ?? reply.code(404).send({ error: "connection not found" }),
  );
  app.patch<{
    Params: { id: string; connectionId: string };
    Body: { description?: string; config?: Record<string, unknown>; risk?: "low" | "medium" | "high"; secretNames?: string[]; enabled?: boolean };
  }>("/companies/:id/connections/:connectionId", { schema: { body: { ...connectionBody, required: [], properties: { ...connectionBody.properties } } } }, async (request, reply) =>
    handle(reply, async () => {
      const { kind: _kind, name: _name, ...patch } = request.body as Record<string, unknown>;
      const updated = await o.connections.update(request.params.id, request.params.connectionId, patch as never, person);
      o.invalidateTools(request.params.id);
      bus.publish("connection.updated", request.params.id, { connectionId: updated.id, enabled: updated.enabled });
      return updated;
    }),
  );
  app.delete<{ Params: { id: string; connectionId: string } }>("/companies/:id/connections/:connectionId", async (request, reply) =>
    handle(reply, async () => {
      await o.connections.remove(request.params.id, request.params.connectionId, person);
      o.invalidateTools(request.params.id);
      bus.publish("connection.removed", request.params.id, { connectionId: request.params.connectionId });
      return reply.code(204).send();
    }),
  );
  app.post<{ Params: { id: string; connectionId: string } }>("/companies/:id/connections/:connectionId/check", async (request, reply) =>
    handle(reply, async () => {
      const checked = await o.connections.check(request.params.id, request.params.connectionId);
      o.invalidateTools(request.params.id);
      bus.publish("connection.updated", request.params.id, { connectionId: checked.id, status: checked.status });
      return checked;
    }),
  );
  /** Runs a connection tool by hand (a test from the interface). */
  app.post<{ Params: { id: string }; Body: { tool: string; args?: Record<string, unknown> } }>(
    "/companies/:id/connections/call",
    { schema: { body: { type: "object", required: ["tool"], additionalProperties: false, properties: { tool: { type: "string" }, args: { type: "object" } } } } },
    async (request, reply) => handle(reply, () => o.connections.call(request.params.id, request.body.tool, request.body.args ?? {})),
  );

  // --- Webhooks (management) ----------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/webhooks", async (request) => o.webhooks.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { name: string; action: "create_task" | "wake_agent" | "comment" | "decide_approval"; defaults?: Record<string, unknown> } }>(
    "/companies/:id/webhooks",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "action"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            action: { type: "string", enum: ["create_task", "wake_agent", "comment", "decide_approval"] },
            defaults: { type: "object" },
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const { webhook, token } = await o.webhooks.create({ companyId: request.params.id, ...request.body }, person);
        return reply.code(201).send({ ...webhook, token, url: `/v1/hooks/${webhook.id}` });
      }),
  );
  app.patch<{ Params: { id: string; webhookId: string }; Body: { enabled?: boolean; defaults?: Record<string, unknown> } }>(
    "/companies/:id/webhooks/:webhookId",
    { schema: { body: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" }, defaults: { type: "object" } } } } },
    async (request, reply) => handle(reply, () => o.webhooks.update(request.params.id, request.params.webhookId, request.body, person)),
  );
  app.post<{ Params: { id: string; webhookId: string } }>("/companies/:id/webhooks/:webhookId/rotate", async (request, reply) =>
    handle(reply, async () => {
      const { webhook, token } = await o.webhooks.rotate(request.params.id, request.params.webhookId, person);
      return { ...webhook, token };
    }),
  );
  app.delete<{ Params: { id: string; webhookId: string } }>("/companies/:id/webhooks/:webhookId", async (request, reply) =>
    handle(reply, async () => {
      await o.webhooks.remove(request.params.id, request.params.webhookId, person);
      return reply.code(204).send();
    }),
  );

  // --- Webhooks (the public entry) ----------------------------------------------

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/hooks/:id", async (request, reply) => {
    const auth = request.headers["authorization"];
    const token =
      typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : typeof request.headers["x-opifer-token"] === "string"
          ? (request.headers["x-opifer-token"] as string)
          : null;
    const webhook = await o.webhooks.authenticate(request.params.id, token);
    if (!webhook) return reply.code(401).send({ error: "unknown webhook or bad token" });
    const runtime = app.opifer.runtime;
    return handle(reply, async () => {
      const result = await o.webhooks.handle(webhook, (request.body ?? {}) as Record<string, unknown>, {
        createTask: async (companyId, input) => {
          const task = await app.opifer.work.createTask({ companyId, ...(input as { title: string }) }, { kind: "system" });
          bus.publish("task.created", companyId, { taskId: task.id, status: task.status, source: "webhook" });
          return { id: task.id, status: task.status };
        },
        wakeAgent: async (companyId, agentId, text, options) => {
          if (!runtime) throw new ConnectionError("unavailable", "no model is configured");
          const session = await runtime.startSession({ companyId, agentId, kind: "chat", title: options.sessionTitle ?? `Webhook · ${webhook.name}` });
          startTurnInBackground(app, runtime, session, text);
          return { sessionId: session.id };
        },
        comment: async (companyId, taskId, body) => {
          const comment = await app.opifer.work.comment(companyId, taskId, { kind: "system" }, body);
          bus.publish("task.commented", companyId, { taskId, commentId: comment.id, source: "webhook" });
          return { id: comment.id };
        },
        decideApproval: async (_companyId, approvalId, status, note) => {
          const decided = await decideApproval(app, approvalId, { status, note: note ?? null });
          return { id: decided.id, status: decided.status };
        },
      });
      bus.publish("webhook.called", webhook.companyId, { webhookId: webhook.id, action: webhook.action });
      return { ok: true, action: webhook.action, ...result };
    });
  });

  // --- Event subscriptions -------------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/subscriptions", async (request) => o.events.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { name: string; url: string; events?: string[] } }>(
    "/companies/:id/subscriptions",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "url"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            url: { type: "string", minLength: 1, maxLength: 2000 },
            events: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await o.events.create({ companyId: request.params.id, ...request.body }, person))),
  );
  app.patch<{ Params: { id: string; subscriptionId: string }; Body: { url?: string; events?: string[]; enabled?: boolean } }>(
    "/companies/:id/subscriptions/:subscriptionId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { url: { type: "string" }, events: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => handle(reply, () => o.events.update(request.params.id, request.params.subscriptionId, request.body, person)),
  );
  app.delete<{ Params: { id: string; subscriptionId: string } }>("/companies/:id/subscriptions/:subscriptionId", async (request, reply) =>
    handle(reply, async () => {
      await o.events.remove(request.params.id, request.params.subscriptionId, person);
      return reply.code(204).send();
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/companies/:id/deliveries", async (request) =>
    o.events.deliveries(request.params.id, request.query.limit ? Number(request.query.limit) : 50),
  );

  // --- Channels -------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/companies/:id/channels", async (request) => {
    const list = await o.channels.list(request.params.id);
    return list.map((c) => ({ ...c, live: o.hub?.isLive(c.id) ?? false }));
  });
  app.post<{ Params: { id: string }; Body: { kind: "telegram"; name: string; secretName: string; defaultAgentId?: string | null } }>(
    "/companies/:id/channels",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind", "name", "secretName"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["telegram"] },
            name: { type: "string", minLength: 1, maxLength: 80 },
            secretName: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
            defaultAgentId: nullableUuid,
          },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const channel = await o.channels.create({ companyId: request.params.id, ...request.body }, person);
        if (o.hub) await o.hub.open(channel);
        const fresh = await o.channels.get(request.params.id, channel.id);
        bus.publish("channel.created", request.params.id, { channelId: channel.id, status: fresh?.status });
        return reply.code(201).send({ ...fresh, live: o.hub?.isLive(channel.id) ?? false });
      }),
  );
  app.patch<{ Params: { id: string; channelId: string }; Body: { name?: string; defaultAgentId?: string | null; enabled?: boolean; secretName?: string } }>(
    "/companies/:id/channels/:channelId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, defaultAgentId: nullableUuid, enabled: { type: "boolean" }, secretName: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" } },
        },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const channel = await o.channels.update(request.params.id, request.params.channelId, request.body, person);
        if (o.hub) await o.hub.open(channel);
        const fresh = await o.channels.get(request.params.id, channel.id);
        return { ...fresh, live: o.hub?.isLive(channel.id) ?? false };
      }),
  );
  app.post<{ Params: { id: string; channelId: string } }>("/companies/:id/channels/:channelId/reconnect", async (request, reply) =>
    handle(reply, async () => {
      const channel = await o.channels.get(request.params.id, request.params.channelId);
      if (!channel) throw new ConnectionError("not_found", "channel not found");
      if (o.hub) await o.hub.open(channel);
      const fresh = await o.channels.get(request.params.id, channel.id);
      return { ...fresh, live: o.hub?.isLive(channel.id) ?? false };
    }),
  );
  app.delete<{ Params: { id: string; channelId: string } }>("/companies/:id/channels/:channelId", async (request, reply) =>
    handle(reply, async () => {
      if (o.hub) await o.hub.close(request.params.channelId);
      await o.channels.remove(request.params.id, request.params.channelId, person);
      return reply.code(204).send();
    }),
  );
  app.get<{ Params: { id: string } }>("/companies/:id/channel-bindings", async (request) => o.channels.bindings(request.params.id));
  app.post<{ Params: { id: string }; Body: { code: string } }>(
    "/companies/:id/channel-bindings/pair",
    { schema: { body: { type: "object", required: ["code"], additionalProperties: false, properties: { code: { type: "string", minLength: 4, maxLength: 12 } } } } },
    async (request, reply) =>
      handle(reply, async () => {
        const binding = await o.channels.pair(request.params.id, request.body.code, null, person);
        bus.publish("channel.paired", request.params.id, { bindingId: binding.id, displayName: binding.displayName });
        return binding;
      }),
  );
  app.patch<{ Params: { id: string; bindingId: string }; Body: { agentId?: string | null; notify?: boolean } }>(
    "/companies/:id/channel-bindings/:bindingId",
    { schema: { body: { type: "object", additionalProperties: false, properties: { agentId: nullableUuid, notify: { type: "boolean" } } } } },
    async (request, reply) =>
      handle(reply, async () => {
        if (request.body.agentId !== undefined) await o.channels.setAgent(request.params.bindingId, request.body.agentId);
        if (request.body.notify !== undefined) await o.channels.setNotify(request.params.id, request.params.bindingId, request.body.notify);
        return (await o.channels.bindings(request.params.id)).find((b) => b.id === request.params.bindingId) ?? reply.code(404).send({ error: "binding not found" });
      }),
  );
  app.delete<{ Params: { id: string; bindingId: string } }>("/companies/:id/channel-bindings/:bindingId", async (request, reply) =>
    handle(reply, async () => {
      await o.channels.unpair(request.params.id, request.params.bindingId, person);
      return reply.code(204).send();
    }),
  );
  void uuid;
}
