/**
 * Persistenza delle sessioni: ogni messaggio ed evento è scritto appena
 * esiste, così una conversazione sopravvive a un riavvio e riprende dalla
 * cronologia salvata, senza rieseguire azioni già compiute.
 */

import type { Sql } from "postgres";
import type { ContentPart, Usage } from "@opifer/sdk";
import type { RunRecord, RunStatus, SessionKind, SessionRecord, StoredMessage, StoredRole } from "./types.js";

interface SessionRow {
  id: string;
  company_id: string;
  agent_id: string;
  kind: SessionKind;
  title: string | null;
  system_prompt: string;
  system_prompt_hash: string;
  model: string;
  fallback_model: string | null;
  status: SessionRecord["status"];
  workdir: string | null;
  last_seq: number;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  seq: number;
  role: StoredRole;
  content: ContentPart[];
  usage: Usage | null;
  created_at: Date;
}

interface RunRow {
  id: string;
  company_id: string;
  session_id: string;
  agent_id: string;
  status: RunStatus;
  stop_reason: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    companyId: r.company_id,
    agentId: r.agent_id,
    kind: r.kind,
    title: r.title,
    systemPrompt: r.system_prompt,
    systemPromptHash: r.system_prompt_hash,
    model: r.model,
    fallbackModel: r.fallback_model,
    status: r.status,
    workdir: r.workdir,
    lastSeq: r.last_seq,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    usage: r.usage,
    createdAt: r.created_at.toISOString(),
  };
}

function toRun(r: RunRow): RunRecord {
  return {
    id: r.id,
    companyId: r.company_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    status: r.status,
    stopReason: r.stop_reason,
    iterations: r.iterations,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens,
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export interface CreateSessionInput {
  companyId: string;
  agentId: string;
  kind?: SessionKind;
  title?: string | null;
  systemPrompt: string;
  systemPromptHash: string;
  model: string;
  fallbackModel?: string | null;
  workdir?: string | null;
}

export class SessionStore {
  constructor(private readonly sql: Sql) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const [row] = await this.sql<SessionRow[]>`
      INSERT INTO sessions (company_id, agent_id, kind, title, system_prompt, system_prompt_hash, model, fallback_model, workdir)
      VALUES (
        ${input.companyId}, ${input.agentId}, ${input.kind ?? "chat"}, ${input.title ?? null},
        ${input.systemPrompt}, ${input.systemPromptHash}, ${input.model}, ${input.fallbackModel ?? null}, ${input.workdir ?? null}
      )
      RETURNING *
    `;
    return toSession(row!);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const [row] = await this.sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${id}`;
    return row ? toSession(row) : null;
  }

  async listSessions(companyId: string, agentId?: string): Promise<SessionRecord[]> {
    const rows = agentId
      ? await this.sql<SessionRow[]>`SELECT * FROM sessions WHERE company_id = ${companyId} AND agent_id = ${agentId} ORDER BY created_at DESC`
      : await this.sql<SessionRow[]>`SELECT * FROM sessions WHERE company_id = ${companyId} ORDER BY created_at DESC`;
    return rows.map(toSession);
  }

  async setSessionStatus(id: string, status: SessionRecord["status"]): Promise<void> {
    await this.sql`UPDATE sessions SET status = ${status} WHERE id = ${id}`;
  }

  async setSessionTitle(id: string, title: string): Promise<void> {
    await this.sql`UPDATE sessions SET title = ${title} WHERE id = ${id} AND title IS NULL`;
  }

  async listMessages(sessionId: string): Promise<StoredMessage[]> {
    const rows = await this.sql<MessageRow[]>`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY seq`;
    return rows.map(toMessage);
  }

  async lastMessage(sessionId: string): Promise<StoredMessage | null> {
    const [row] = await this.sql<MessageRow[]>`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1`;
    return row ? toMessage(row) : null;
  }

  /** Aggiunge un messaggio con il prossimo numero di sequenza, in una sola transazione. */
  async appendMessage(session: { id: string; companyId: string }, role: StoredRole, content: ContentPart[], options: { runId?: string | null; usage?: Usage | null } = {}): Promise<StoredMessage> {
    return this.sql.begin(async (tx) => {
      const [next] = await tx<{ last_seq: number }[]>`
        UPDATE sessions SET last_seq = last_seq + 1 WHERE id = ${session.id} RETURNING last_seq
      `;
      if (!next) throw new Error(`Sessione ${session.id} non trovata`);
      const [row] = await tx<MessageRow[]>`
        INSERT INTO messages (company_id, session_id, run_id, seq, role, content, usage)
        VALUES (
          ${session.companyId}, ${session.id}, ${options.runId ?? null}, ${next.last_seq}, ${role},
          ${content as never}::jsonb, ${(options.usage ?? null) as never}::jsonb
        )
        RETURNING *
      `;
      return toMessage(row!);
    });
  }

  /** Aggiunge testo a un messaggio utente esistente (al confine del turno, per rispettare l'alternanza). */
  async appendToMessage(messageId: string, parts: ContentPart[]): Promise<StoredMessage> {
    const [row] = await this.sql<MessageRow[]>`
      UPDATE messages SET content = content || ${parts as never}::jsonb WHERE id = ${messageId} RETURNING *
    `;
    if (!row) throw new Error(`Messaggio ${messageId} non trovato`);
    return toMessage(row);
  }

  async createRun(session: { id: string; companyId: string; agentId: string }): Promise<RunRecord> {
    const [row] = await this.sql<RunRow[]>`
      INSERT INTO runs (company_id, session_id, agent_id) VALUES (${session.companyId}, ${session.id}, ${session.agentId}) RETURNING *
    `;
    return toRun(row!);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const [row] = await this.sql<RunRow[]>`SELECT * FROM runs WHERE id = ${id}`;
    return row ? toRun(row) : null;
  }

  async activeRun(sessionId: string): Promise<RunRecord | null> {
    const [row] = await this.sql<RunRow[]>`
      SELECT * FROM runs WHERE session_id = ${sessionId} AND status = 'in_corso' ORDER BY started_at DESC LIMIT 1
    `;
    return row ? toRun(row) : null;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`SELECT * FROM runs WHERE session_id = ${sessionId} ORDER BY started_at`;
    return rows.map(toRun);
  }

  async updateRunProgress(id: string, progress: { iterations: number; usage: Usage }): Promise<void> {
    await this.sql`
      UPDATE runs SET
        iterations = ${progress.iterations},
        input_tokens = input_tokens + ${progress.usage.inputTokens},
        output_tokens = output_tokens + ${progress.usage.outputTokens},
        cached_input_tokens = cached_input_tokens + ${progress.usage.cachedInputTokens ?? 0}
      WHERE id = ${id}
    `;
  }

  async finishRun(id: string, outcome: { status: RunStatus; stopReason: string; error?: string | null }): Promise<RunRecord> {
    const [row] = await this.sql<RunRow[]>`
      UPDATE runs SET status = ${outcome.status}, stop_reason = ${outcome.stopReason}, error = ${outcome.error ?? null}, finished_at = now()
      WHERE id = ${id} RETURNING *
    `;
    return toRun(row!);
  }

  /** Segna come interrotte le esecuzioni rimaste "in corso" (per esempio dopo un crash). */
  async markStaleRunsInterrupted(sessionId: string): Promise<RunRecord[]> {
    const rows = await this.sql<RunRow[]>`
      UPDATE runs SET status = 'interrotta', stop_reason = 'riavvio', finished_at = now()
      WHERE session_id = ${sessionId} AND status = 'in_corso' RETURNING *
    `;
    return rows.map(toRun);
  }

  async appendRunEvent(run: { id: string; companyId: string }, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.sql`
      INSERT INTO run_events (company_id, run_id, seq, type, payload)
      VALUES (
        ${run.companyId}, ${run.id},
        (SELECT coalesce(max(seq), 0) + 1 FROM run_events WHERE run_id = ${run.id}),
        ${type}, ${payload as never}::jsonb
      )
    `;
  }

  async listRunEvents(runId: string): Promise<Array<{ seq: number; type: string; payload: Record<string, unknown>; occurredAt: string }>> {
    const rows = await this.sql<{ seq: number; type: string; payload: Record<string, unknown>; occurred_at: Date }[]>`
      SELECT seq, type, payload, occurred_at FROM run_events WHERE run_id = ${runId} ORDER BY seq
    `;
    return rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload, occurredAt: r.occurred_at.toISOString() }));
  }
}
