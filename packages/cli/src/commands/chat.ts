/**
 * `o4r chat <agent>`: terminal conversation. It is a view over the same data
 * and the same rules as the web interface: it talks to the server through the
 * API and receives the stream from the events WebSocket.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, say } from "../output.js";
import { api, serverBase } from "../api.js";

export interface ChatOptions {
  home?: string;
  agent?: string;
  company?: string;
  resume?: string;
  model?: string;
}

interface Company {
  id: string;
  name: string;
}
interface Agent {
  id: string;
  name: string;
  role: string;
}
interface Session {
  id: string;
  agentId: string;
  companyId: string;
  title: string | null;
  model: string;
  status: string;
}
interface BusEvent {
  type: string;
  payload: { sessionId?: string; event?: RuntimeEventLike };
}
interface RuntimeEventLike {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  message?: string;
  phase?: string;
  attempt?: number;
  reason?: string;
  from?: string;
  to?: string;
  approvalId?: string;
  risk?: string;
  scope?: string;
  cap?: number;
  spent?: number;
  currency?: string;
  run?: { status: string; stopReason: string | null; inputTokens: number; outputTokens: number; iterations: number };
}

export async function runChat(options: ChatOptions): Promise<void> {
  const base = await serverBase(options.home);

  const health = await api<{ runtime: string }>(base, "/v1/health");
  if (health.runtime !== "ok") throw new Error("The server has no model providers configured: set ANTHROPIC_API_KEY, OPENAI_API_KEY or a local endpoint and restart");

  let session: Session;
  let agent: Agent;
  if (options.resume) {
    session = await api<Session>(base, `/v1/sessions/${options.resume}`);
    const agents = await api<Agent[]>(base, `/v1/companies/${session.companyId}/agents`);
    agent = agents.find((a) => a.id === session.agentId) ?? { id: session.agentId, name: "agent", role: "" };
    if (session.status !== "active") throw new Error(`The session is ${session.status}`);
    say.ok(`Session resumed: ${c.bold(session.title ?? session.id)}`);
    await printHistory(base, session.id);
  } else {
    const companies = await api<Company[]>(base, "/v1/companies");
    const company = options.company ? companies.find((co) => co.name.toLowerCase() === options.company!.toLowerCase()) : companies[0];
    if (!company) throw new Error(options.company ? `Company "${options.company}" not found` : "No company: create the first one with o4r init --company");
    const agents = await api<Agent[]>(base, `/v1/companies/${company.id}/agents`);
    if (agents.length === 0) throw new Error(`No agent in ${company.name}: create one from the web interface (${base})`);
    const chosen = options.agent ? agents.find((a) => a.name.toLowerCase() === options.agent!.toLowerCase()) : agents[0];
    if (!chosen) throw new Error(`Agent "${options.agent}" not found in ${company.name}. Available: ${agents.map((a) => a.name).join(", ")}`);
    agent = chosen;
    session = await api<Session>(base, `/v1/companies/${company.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id, ...(options.model ? { model: options.model } : {}) }),
    });
    say.ok(`New session with ${c.bold(agent.name)} (${session.model}) in ${company.name}`);
    say.info(c.dim(`session id ${session.id} — resume with: o4r chat --resume ${session.id}`));
  }
  say.info(c.dim("Commands: /stop interrupts the turn, /exit quits. A message sent during a turn is passed to the agent in the next tool result."));

  const socket = new WebSocket(`${base.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("events WebSocket not reachable")), { once: true });
  });

  let turnDone: (() => void) | null = null;
  let streamingLine = false;
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as BusEvent;
    if (event.type !== "session.event" || event.payload.sessionId !== session.id || !event.payload.event) return;
    const e = event.payload.event;
    switch (e.type) {
      case "text":
        if (!streamingLine) {
          stdout.write(`${c.cyan(agent.name)}: `);
          streamingLine = true;
        }
        stdout.write(e.text ?? "");
        break;
      case "tool_call":
        endLine();
        say.info(c.dim(`  ⚙ ${e.name} ${JSON.stringify(e.arguments ?? {}).slice(0, 200)}`));
        break;
      case "tool_result":
        say.info(c.dim(`  ${e.isError ? "✗" : "✓"} ${e.name} (${e.durationMs} ms) ${firstLine(e.content ?? "")}`));
        break;
      case "retry":
        endLine();
        say.warn(`retry ${e.attempt}: ${e.reason}`);
        break;
      case "fallback":
        endLine();
        say.warn(`switching to the fallback model ${e.to}: ${e.reason}`);
        break;
      case "notice":
        endLine();
        say.warn(e.message ?? "");
        break;
      case "approval_requested":
        endLine();
        say.warn(`approval needed for ${c.bold(e.name ?? "")} (${e.risk} risk): ${e.reason}`);
        say.info(c.dim(`  decide with: o4r approvals approve ${e.approvalId}  |  o4r approvals deny ${e.approvalId}`));
        break;
      case "budget_stop":
        endLine();
        say.fail(`budget reached for ${e.scope}: ${e.spent?.toFixed(4)} of ${e.cap} ${e.currency}. The agent is stopped until a budget increase is approved (o4r approvals).`);
        break;
      case "done":
        endLine();
        if (e.run) {
          const tokens = `${e.run.inputTokens} in / ${e.run.outputTokens} out`;
          const status = e.run.status === "completed" ? c.green(e.run.stopReason ?? "") : c.yellow(`${e.run.status}: ${e.run.stopReason ?? ""}`);
          say.info(c.dim(`  [${status}, ${e.run.iterations} iterations, ${tokens}]`));
        }
        turnDone?.();
        break;
      default:
        break;
    }
  });

  function endLine(): void {
    if (streamingLine) {
      stdout.write("\n");
      streamingLine = false;
    }
  }

  const rl = createInterface({ input: stdin, output: stdout, prompt: `${c.bold("you")}: ` });
  const shutdown = () => {
    rl.close();
    socket.close();
  };
  rl.on("SIGINT", () => {
    say.info("");
    shutdown();
    process.exit(0);
  });

  // Lines are read through the iterator: this works both from a terminal and from piped input.
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (line === "/exit" || line === "/quit") break;
    if (line === "/stop") {
      await api(base, `/v1/sessions/${session.id}/interrupt`, { method: "POST" }).catch((error: Error) => say.warn(error.message));
      rl.prompt();
      continue;
    }
    const done = new Promise<void>((resolve) => {
      turnDone = resolve;
    });
    let accepted: { accepted: string };
    try {
      accepted = await api<{ accepted: string }>(base, `/v1/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: line }) });
    } catch (error) {
      say.fail(error instanceof Error ? error.message : String(error));
      rl.prompt();
      continue;
    }
    if (accepted.accepted === "injected") {
      say.info(c.dim("  (message passed to the agent during the turn)"));
      rl.prompt();
      continue;
    }
    await done;
    turnDone = null;
    rl.prompt();
  }
  shutdown();
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

async function printHistory(base: string, sessionId: string): Promise<void> {
  const messages = await api<Array<{ role: string; content: Array<{ type: string; text?: string; name?: string; content?: string }> }>>(base, `/v1/sessions/${sessionId}/messages`);
  for (const m of messages.slice(-12)) {
    for (const part of m.content) {
      if (part.type === "text" && m.role === "user") say.info(`${c.bold("you")}: ${part.text}`);
      else if (part.type === "text") say.info(`${c.cyan("agent")}: ${part.text}`);
      else if (part.type === "tool_call") say.info(c.dim(`  ⚙ ${part.name}`));
    }
  }
  if (messages.length > 12) say.info(c.dim(`  (… ${messages.length - 12} earlier messages)`));
}
