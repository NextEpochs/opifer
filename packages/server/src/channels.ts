/**
 * The channel hub: starts one transport per enabled channel (Telegram…),
 * turns incoming messages into pairing, control commands or agent turns,
 * and pushes approvals and finished work to the paired people. Unknown
 * senders are refused until a person claims them with a pairing code.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { EventBus } from "@opifer/core";
import type { Channel, InboundMessage } from "@opifer/sdk";
import type { ChannelBinding, ChannelRecord, ChannelService } from "@opifer/connections";
import type { Routine, RoutineRun } from "@opifer/work";
import { TelegramChannel } from "@opifer/channel-telegram";
import { decideApproval } from "./routes/governance.js";

export interface ChannelHubOptions {
  app: FastifyInstance;
  bus: EventBus;
  channels: ChannelService;
  log: FastifyBaseLogger;
  /** Builds the transport for a channel; tests inject a fake. */
  transport?: (channel: ChannelRecord, token: string) => Channel & { me?(): Promise<{ username: string }> };
}

const HELP = [
  "/status — who is working and what needs you",
  "/agent <name> — talk to another agent in this chat",
  "/stop — interrupt the agent you are talking to",
  "/approve <id> · /deny <id> — decide an approval (the buttons do the same)",
  "/notify on|off — receive approvals and finished work here",
  "Anything else is a message to your agent.",
].join("\n");

export class ChannelHub {
  private readonly live = new Map<string, Channel>();

  constructor(private readonly o: ChannelHubOptions) {
    // The hub listens from the start; it only sends where a channel is live.
    this.o.bus.subscribe((event) => void this.onEvent(event.type, event.companyId, event.payload as Record<string, unknown>));
  }

  async start(): Promise<void> {
    for (const channel of await this.o.channels.listAll())
      await this.open(channel).catch((error) => this.o.log.warn({ err: error, channel: channel.name }, "channel failed to start"));
  }

  async stop(): Promise<void> {
    for (const [id, channel] of this.live) {
      await channel.stop().catch(() => {});
      this.live.delete(id);
    }
  }

  /** (Re)opens one channel: reads the token, starts polling, records the health. */
  async open(channel: ChannelRecord): Promise<void> {
    await this.close(channel.id);
    if (!channel.enabled) return;
    const governance = this.o.app.opifer.governance;
    const token = governance ? await governance.secrets.readForSystem(channel.companyId, channel.secretName, `channel:${channel.name}`) : null;
    if (!token) {
      await this.o.channels.setStatus(channel.id, "missing_secret", `set the secret ${channel.secretName}`);
      return;
    }
    const make = this.o.transport ?? ((c, t) => new TelegramChannel({ id: c.id, token: t, onError: (error) => this.o.log.warn({ err: error, channel: c.name }, "channel error") }));
    const transport = make(channel, token);
    try {
      const me = transport.me ? await transport.me() : null;
      await transport.start((message) => this.onMessage(channel, transport, message));
      this.live.set(channel.id, transport);
      await this.o.channels.setStatus(channel.id, "healthy", me ? `@${me.username}` : null);
      if (me) await this.o.app.opifer.db.sql`UPDATE channels SET config = config || ${{ botUsername: me.username } as never}::jsonb WHERE id = ${channel.id}`;
    } catch (error) {
      await this.o.channels.setStatus(channel.id, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  async close(channelId: string): Promise<void> {
    const live = this.live.get(channelId);
    if (live) {
      await live.stop().catch(() => {});
      this.live.delete(channelId);
    }
  }

  isLive(channelId: string): boolean {
    return this.live.has(channelId);
  }

  // --- Inbound ----------------------------------------------------------------

  private async onMessage(channel: ChannelRecord, transport: Channel, message: InboundMessage): Promise<void> {
    const { app } = this.o;
    await this.o.channels.touch(channel.id);
    const [company] = await app.opifer.db.sql<{ name: string }[]>`SELECT name FROM companies WHERE id = ${channel.companyId}`;
    const reply = (text: string, actions?: Array<{ id: string; label: string }>) =>
      transport.send({ externalChatId: message.externalChatId, text, ...(actions ? { actions } : {}) });

    let binding = await this.o.channels.binding(channel.id, message.externalChatId, message.externalSenderId);
    if (!binding?.userId) {
      binding = await this.o.channels.pairingFor(channel, message.externalChatId, message.externalSenderId, message.senderName ?? message.externalSenderId);
      await reply(
        `Hello ${binding.displayName}. I am the Opifer bot of ${company?.name ?? "the company"}. This chat is not linked to a person yet: open Opifer → Connections → Channels and enter the code **${binding.pairingCode}** (valid 15 minutes).`,
      );
      return;
    }

    if (message.actionId) return this.onAction(channel, binding, message.actionId, reply);
    const text = message.text.trim();
    if (text.startsWith("/")) return this.onCommand(channel, binding, text, reply);
    return this.talk(channel, binding, text, reply);
  }

  private async onAction(channel: ChannelRecord, binding: ChannelBinding, actionId: string, reply: (t: string) => Promise<void>): Promise<void> {
    const [verb, id] = actionId.split(":");
    if ((verb === "approve" || verb === "deny") && id) {
      try {
        const decided = await decideApproval(this.o.app, id, { status: verb === "approve" ? "approved" : "denied", decidedBy: binding.userId });
        await reply(`${verb === "approve" ? "Approved" : "Denied"}${decided.followUp ? ` · ${decided.followUp.replace(/_/g, " ")}` : ""}.`);
      } catch (error) {
        await reply(`Could not decide: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    await reply("Unknown action.");
    void channel;
  }

  private async onCommand(
    channel: ChannelRecord,
    binding: ChannelBinding,
    text: string,
    reply: (t: string, a?: Array<{ id: string; label: string }>) => Promise<void>,
  ): Promise<void> {
    const { app } = this.o;
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const sql = app.opifer.db.sql;
    switch (command) {
      case "/start":
      case "/help":
        await reply(`You are linked as ${binding.displayName}. ${await this.statusLine(channel)}\n\n${HELP}`);
        return;
      case "/status": {
        await reply(await this.statusLine(channel));
        const pending = app.opifer.governance ? await app.opifer.governance.approvals.list(channel.companyId, { status: "pending" }) : [];
        for (const a of pending.slice(0, 5))
          await reply(
            this.describeApproval(
              a as { id: string; kind: string; reason: string | null; subject: Record<string, unknown> },
              await this.agentName(channel.companyId, (a as { agentId: string | null }).agentId),
            ),
            [
              { id: `approve:${a.id}`, label: "Approve" },
              { id: `deny:${a.id}`, label: "Deny" },
            ],
          );
        return;
      }
      case "/agent": {
        const [agent] = await sql<
          { id: string; name: string }[]
        >`SELECT id, name FROM agents WHERE company_id = ${channel.companyId} AND status = 'active' AND lower(name) = ${arg.toLowerCase()}`;
        if (!agent) {
          const names = await sql<{ name: string }[]>`SELECT name FROM agents WHERE company_id = ${channel.companyId} AND status = 'active' ORDER BY name`;
          await reply(`No agent named "${arg}". Available: ${names.map((n) => n.name).join(", ")}`);
          return;
        }
        await this.o.channels.setAgent(binding.id, agent.id);
        await reply(`This chat now talks to ${agent.name}.`);
        return;
      }
      case "/stop": {
        const stopped = binding.sessionId ? app.opifer.runtime?.interrupt(binding.sessionId) : false;
        await reply(stopped ? "Stopped." : "Nothing is running.");
        return;
      }
      case "/approve":
      case "/deny": {
        const [match] = await sql<
          { id: string }[]
        >`SELECT id FROM approvals WHERE company_id = ${channel.companyId} AND status = 'pending' AND id::text LIKE ${`${arg}%`} ORDER BY created_at DESC LIMIT 1`;
        if (!match) {
          await reply("No pending approval matches. /status lists them.");
          return;
        }
        await this.onAction(channel, binding, `${command.slice(1)}:${match.id}`, reply);
        return;
      }
      case "/notify": {
        const on = arg !== "off";
        await this.o.channels.setNotify(channel.companyId, binding.id, on);
        await reply(on ? "You will receive approvals and finished work here." : "Notifications off for this chat.");
        return;
      }
      default:
        await reply(`Unknown command.\n\n${HELP}`);
    }
  }

  /** A message to the bound agent: one turn on the chat's session, the answer back. */
  private async talk(channel: ChannelRecord, binding: ChannelBinding, text: string, reply: (t: string, a?: Array<{ id: string; label: string }>) => Promise<void>): Promise<void> {
    const { app } = this.o;
    const runtime = app.opifer.runtime;
    if (!runtime) return reply("No model is configured: nobody can answer yet.");
    const agentId = binding.agentId ?? channel.defaultAgentId;
    if (!agentId) return reply("This chat is not linked to an agent. Use /agent <name>.");
    const [agent] = await app.opifer.db.sql<
      { id: string; name: string; status: string }[]
    >`SELECT id, name, status FROM agents WHERE id = ${agentId} AND company_id = ${channel.companyId}`;
    if (!agent || agent.status !== "active") return reply(agent ? `${agent.name} is ${agent.status}.` : "The agent is gone. Use /agent <name>.");
    let session = binding.sessionId ? await runtime.store.getSession(binding.sessionId) : null;
    if (!session || session.status !== "active" || session.agentId !== agent.id) {
      session = await runtime.startSession({ companyId: channel.companyId, agentId: agent.id, kind: "chat", title: `${channel.name} · ${binding.displayName}` });
      await this.o.channels.setSession(binding.id, session.id);
      app.opifer.bus.publish("session.created", channel.companyId, { sessionId: session.id, agentId: agent.id, channelId: channel.id });
    }
    if (runtime.isRunning(session.id)) {
      runtime.inject(session.id, text);
      return reply(`${agent.name} is busy; your message was passed on.`);
    }
    await this.o.channels.setSession(binding.id, session.id);
    try {
      const result = await runtime.runTurn({
        sessionId: session.id,
        text,
        onEvent: (event) => app.opifer.bus.publish("session.event", channel.companyId, { sessionId: session!.id, runId: event.type === "done" ? event.run.id : null, event }),
      });
      if (result.stopReason === "approval_pending") {
        const pending = app.opifer.governance ? await app.opifer.governance.approvals.list(channel.companyId, { status: "pending" }) : [];
        const mine = pending.find((a) => (a as { sessionId: string | null }).sessionId === session!.id);
        if (mine)
          await reply(`${agent.name} needs your approval.\n${this.describeApproval(mine as never, agent.name)}`, [
            { id: `approve:${mine.id}`, label: "Approve" },
            { id: `deny:${mine.id}`, label: "Deny" },
          ]);
        else await reply(`${agent.name} is waiting for an approval in the Inbox.`);
        return;
      }
      if (result.stopReason === "budget_exhausted") return reply(`${agent.name} stopped: the budget is reached. Raise it in the Inbox.`);
      await reply(result.assistantText.trim() || `${agent.name} finished without a reply.`);
    } catch (error) {
      await reply(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- Outbound ---------------------------------------------------------------

  private async onEvent(type: string, companyId: string | null, payload: Record<string, unknown>): Promise<void> {
    if (!companyId || this.live.size === 0) return;
    try {
      if (type === "approval.requested" && typeof payload["approvalId"] === "string") {
        const approval = this.o.app.opifer.governance ? await this.o.app.opifer.governance.approvals.get(companyId, payload["approvalId"]) : null;
        if (!approval || approval.status !== "pending") return;
        const text = this.describeApproval(approval as never, await this.agentName(companyId, approval.agentId));
        await this.broadcast(
          companyId,
          text,
          [
            { id: `approve:${approval.id}`, label: "Approve" },
            { id: `deny:${approval.id}`, label: "Deny" },
          ],
          approval.sessionId,
        );
      } else if (type === "task.updated" && (payload["status"] === "in_review" || payload["status"] === "blocked") && typeof payload["taskId"] === "string") {
        const task = await this.o.app.opifer.work.getTask(companyId, payload["taskId"]);
        if (!task) return;
        const who = await this.agentName(companyId, task.assigneeAgentId);
        const text =
          payload["status"] === "in_review"
            ? `**${who} delivered “${task.title}”**\n${task.result?.summary ?? ""}\nVerify it in Opifer → Work.`
            : `**“${task.title}” is blocked**\n${task.blockedReason ?? ""}\nUnblock it in Opifer → Work.`;
        await this.broadcast(companyId, text);
      }
    } catch (error) {
      this.o.log.warn({ err: error, type }, "channel notification failed");
    }
  }

  /** A finished routine run, to the channels the routine names ("channels" = every paired chat). */
  async deliverRoutine(routine: Routine, run: RoutineRun, text: string): Promise<void> {
    const targets = routine.deliverTo;
    if (!targets.some((t) => t === "channels" || this.live.has(t))) return;
    const body = `**${routine.name}** · ${run.dueAt.toISOString().slice(0, 16).replace("T", " ")}\n${text}`;
    for (const b of await this.o.channels.notifiable(routine.companyId)) {
      if (!targets.includes("channels") && !targets.includes(b.channelId)) continue;
      const transport = this.live.get(b.channelId);
      if (transport) await transport.send({ externalChatId: b.externalChatId, text: body }).catch((error) => this.o.log.warn({ err: error }, "routine delivery failed"));
    }
  }

  /** To every paired chat of the company that asked for notifications; a chat whose own session asked is skipped (it already got the buttons). */
  private async broadcast(companyId: string, text: string, actions?: Array<{ id: string; label: string }>, exceptSessionId?: string | null): Promise<void> {
    for (const b of await this.o.channels.notifiable(companyId)) {
      if (exceptSessionId && b.sessionId === exceptSessionId) continue;
      const transport = this.live.get(b.channelId);
      if (transport)
        await transport.send({ externalChatId: b.externalChatId, text, ...(actions ? { actions } : {}) }).catch((error) => this.o.log.warn({ err: error }, "channel send failed"));
    }
  }

  private describeApproval(a: { id: string; kind: string; reason: string | null; subject: Record<string, unknown> }, agent: string): string {
    const command =
      typeof a.subject["command"] === "string"
        ? a.subject["command"]
        : typeof (a.subject["args"] as Record<string, unknown> | undefined)?.["command"] === "string"
          ? ((a.subject["args"] as Record<string, unknown>)["command"] as string)
          : typeof (a.subject["arguments"] as Record<string, unknown> | undefined)?.["command"] === "string"
            ? ((a.subject["arguments"] as Record<string, unknown>)["command"] as string)
            : null;
    const head =
      a.kind === "budget_increase"
        ? `${agent} reached the budget`
        : a.kind === "skill_promotion"
          ? `Share “${String(a.subject["name"] ?? "a skill")}” with the whole company?`
          : a.kind === "dangerous_command"
            ? `${agent} wants to run a risky command`
            : `${agent} wants to use ${String(a.subject["tool"] ?? "a tool")}`;
    return `**${head}**${a.reason ? `\n${a.reason}` : ""}${command ? `\n\`${command.slice(0, 500)}\`` : ""}\n#${a.id.slice(0, 8)}`;
  }

  private async statusLine(channel: ChannelRecord): Promise<string> {
    const sql = this.o.app.opifer.db.sql;
    const [w] = await sql<{ working: string; pending: string }[]>`
      SELECT (SELECT count(*) FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.company_id = ${channel.companyId} AND r.status = 'running')::text AS working,
             (SELECT count(*) FROM approvals WHERE company_id = ${channel.companyId} AND status = 'pending')::text AS pending
    `;
    const agents = await sql<{ name: string }[]>`SELECT name FROM agents WHERE company_id = ${channel.companyId} AND status = 'active' ORDER BY name`;
    return `${agents.length} agents (${agents.map((a) => a.name).join(", ")}) · ${w!.working} working · ${w!.pending} decisions waiting for you.`;
  }

  private async agentName(companyId: string, agentId: string | null): Promise<string> {
    if (!agentId) return "An agent";
    const [a] = await this.o.app.opifer.db.sql<{ name: string }[]>`SELECT name FROM agents WHERE id = ${agentId} AND company_id = ${companyId}`;
    return a?.name ?? "An agent";
  }
}
