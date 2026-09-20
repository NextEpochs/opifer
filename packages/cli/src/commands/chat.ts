/**
 * `o4r chat <agente>`: conversazione da terminale. È una vista sugli stessi
 * dati e sulle stesse regole dell'interfaccia web: parla con il server via
 * API e riceve lo streaming dal WebSocket degli eventi.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requireConfig, resolveHome } from "../home.js";
import { c, say } from "../output.js";
import { isPortOpen } from "../database.js";

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
  run?: { status: string; stopReason: string | null; inputTokens: number; outputTokens: number; iterations: number };
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function runChat(options: ChatOptions): Promise<void> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);
  const base = `http://${config.server.host}:${config.server.port}`;
  if (!(await isPortOpen(config.server.port, config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host))) {
    throw new Error(`Il server non è avviato su ${base}: esegui prima o4r up (anche con --detach)`);
  }

  const health = await api<{ runtime: string }>(base, "/v1/health");
  if (health.runtime !== "ok") throw new Error("Il server non ha provider di modelli configurati: imposta ANTHROPIC_API_KEY, OPENAI_API_KEY o un endpoint locale e riavvia");

  let session: Session;
  let agent: Agent;
  if (options.resume) {
    session = await api<Session>(base, `/v1/sessions/${options.resume}`);
    const agents = await api<Agent[]>(base, `/v1/companies/${session.companyId}/agents`);
    agent = agents.find((a) => a.id === session.agentId) ?? { id: session.agentId, name: "agente", role: "" };
    if (session.status !== "attiva") throw new Error(`La sessione è ${session.status}`);
    say.ok(`Sessione ripresa: ${c.bold(session.title ?? session.id)}`);
    await printHistory(base, session.id);
  } else {
    const companies = await api<Company[]>(base, "/v1/companies");
    const company = options.company ? companies.find((co) => co.name.toLowerCase() === options.company!.toLowerCase()) : companies[0];
    if (!company) throw new Error(options.company ? `Azienda "${options.company}" non trovata` : "Nessuna azienda: crea la prima con o4r init --company");
    const agents = await api<Agent[]>(base, `/v1/companies/${company.id}/agents`);
    if (agents.length === 0) throw new Error(`Nessun agente in ${company.name}: creane uno dall'interfaccia web (${base})`);
    const chosen = options.agent ? agents.find((a) => a.name.toLowerCase() === options.agent!.toLowerCase()) : agents[0];
    if (!chosen) throw new Error(`Agente "${options.agent}" non trovato in ${company.name}. Disponibili: ${agents.map((a) => a.name).join(", ")}`);
    agent = chosen;
    session = await api<Session>(base, `/v1/companies/${company.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id, ...(options.model ? { model: options.model } : {}) }),
    });
    say.ok(`Nuova sessione con ${c.bold(agent.name)} (${session.model}) in ${company.name}`);
    say.info(c.dim(`id sessione ${session.id} — riprendi con: o4r chat --resume ${session.id}`));
  }
  say.info(c.dim("Comandi: /stop interrompe il turno, /exit esce. Un messaggio durante un turno viene passato all'agente nel prossimo risultato di tool."));

  const socket = new WebSocket(`${base.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket degli eventi non raggiungibile")), { once: true });
  });

  let turnDone: (() => void) | null = null;
  let streamingLine = false;
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as BusEvent;
    if (event.type !== "sessione.evento" || event.payload.sessionId !== session.id || !event.payload.event) return;
    const e = event.payload.event;
    switch (e.type) {
      case "testo":
        if (!streamingLine) {
          stdout.write(`${c.cyan(agent.name)}: `);
          streamingLine = true;
        }
        stdout.write(e.text ?? "");
        break;
      case "tool_chiamata":
        endLine();
        say.info(c.dim(`  ⚙ ${e.name} ${JSON.stringify(e.arguments ?? {}).slice(0, 200)}`));
        break;
      case "tool_risultato":
        say.info(c.dim(`  ${e.isError ? "✗" : "✓"} ${e.name} (${e.durationMs} ms) ${firstLine(e.content ?? "")}`));
        break;
      case "ritentativo":
        endLine();
        say.warn(`ritentativo ${e.attempt}: ${e.reason}`);
        break;
      case "riserva":
        endLine();
        say.warn(`passo al modello di riserva ${e.to}: ${e.reason}`);
        break;
      case "avviso":
        endLine();
        say.warn(e.message ?? "");
        break;
      case "fine":
        endLine();
        if (e.run) {
          const tokens = `${e.run.inputTokens} in / ${e.run.outputTokens} out`;
          const status = e.run.status === "conclusa" ? c.green(e.run.stopReason ?? "") : c.yellow(`${e.run.status}: ${e.run.stopReason ?? ""}`);
          say.info(c.dim(`  [${status}, ${e.run.iterations} iterazioni, ${tokens}]`));
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

  const rl = createInterface({ input: stdin, output: stdout, prompt: `${c.bold("tu")}: ` });
  const shutdown = () => {
    rl.close();
    socket.close();
  };
  rl.on("SIGINT", () => {
    say.info("");
    shutdown();
    process.exit(0);
  });

  // Le righe vengono lette con l'iteratore: funzionano sia da terminale sia da input a tubo.
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
    if (accepted.accepted === "iniettato") {
      say.info(c.dim("  (messaggio passato all'agente durante il turno)"));
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
      if (part.type === "text" && m.role === "user") say.info(`${c.bold("tu")}: ${part.text}`);
      else if (part.type === "text") say.info(`${c.cyan("agente")}: ${part.text}`);
      else if (part.type === "tool_call") say.info(c.dim(`  ⚙ ${part.name}`));
    }
  }
  if (messages.length > 12) say.info(c.dim(`  (… ${messages.length - 12} messaggi precedenti)`));
}
