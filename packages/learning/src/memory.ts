/**
 * Memory: what an agent has learned about how to work and about the people
 * and systems around it. Entries are scoped (agent, team, company), never
 * deleted (retired or superseded), and enter the prompt as a capped
 * snapshot at the start of a session. Search is full-text, with a semantic
 * rerank when an embedder is configured.
 */

import type { Sql } from "postgres";
import type { Embedder } from "@opifer/sdk";
import { audit } from "@opifer/db";
import { LearningError, type Actor, type Memory, type MemoryKind, type Scope } from "./types.js";

interface MemoryRow {
  id: string;
  company_id: string;
  scope: Scope;
  scope_agent_id: string | null;
  kind: MemoryKind;
  subject: string;
  content: string;
  status: Memory["status"];
  supersedes_id: string | null;
  pinned: boolean;
  source_session_id: string | null;
  source_run_id: string | null;
  source_task_id: string | null;
  author_kind: Actor["kind"];
  author_id: string | null;
  has_embedding: boolean;
  retired_reason: string | null;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, company_id, scope, scope_agent_id, kind, subject, content, status, supersedes_id, pinned, source_session_id, source_run_id, source_task_id, author_kind, author_id, (embedding IS NOT NULL) AS has_embedding, retired_reason, retired_at, created_at, updated_at`;

function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    companyId: r.company_id,
    scope: r.scope,
    scopeAgentId: r.scope_agent_id,
    kind: r.kind,
    subject: r.subject,
    content: r.content,
    status: r.status,
    supersedesId: r.supersedes_id,
    pinned: r.pinned,
    sourceSessionId: r.source_session_id,
    sourceRunId: r.source_run_id,
    sourceTaskId: r.source_task_id,
    authorKind: r.author_kind,
    authorId: r.author_id,
    hasEmbedding: r.has_embedding,
    retiredReason: r.retired_reason,
    retiredAt: r.retired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface RememberInput {
  companyId: string;
  scope: Scope;
  /** The agent (scope agent) or the root of the team (scope team). */
  scopeAgentId?: string | null;
  kind?: MemoryKind;
  subject?: string;
  content: string;
  source?: {
    sessionId?: string | null;
    runId?: string | null;
    taskId?: string | null;
  };
  pinned?: boolean;
}

export interface MemorySearchHit {
  memory: Memory;
  score: number;
}

/** The scopes an agent reads: its own, the teams it belongs to (every ancestor's), the company. */
export async function visibleScopes(sql: Sql, companyId: string, agentId: string): Promise<{ agentIds: string[] }> {
  const rows = await sql<{ id: string; reports_to_agent_id: string | null }[]>`SELECT id, reports_to_agent_id FROM agents WHERE company_id = ${companyId}`;
  const parents = new Map(rows.map((r) => [r.id, r.reports_to_agent_id]));
  const chain: string[] = [];
  let current: string | null | undefined = agentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parents.get(current);
  }
  return { agentIds: chain };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export class MemoryService {
  constructor(
    private readonly sql: Sql,
    private readonly embedder: Embedder | null = null,
  ) {}

  /** Whether semantic search is on. */
  get semantic(): boolean {
    return this.embedder !== null;
  }

  async remember(input: RememberInput, actor: Actor): Promise<Memory> {
    const content = input.content.trim();
    if (!content) throw new LearningError("invalid_input", "an empty memory");
    if (content.length > 4000) throw new LearningError("invalid_input", "a memory is a note, not a document: keep it under 4000 characters");
    const scopeAgentId = input.scope === "company" ? null : (input.scopeAgentId ?? null);
    if (input.scope !== "company" && !scopeAgentId) throw new LearningError("invalid_input", `scope ${input.scope} needs an agent`);
    const embedding = await this.embed(`${input.subject ?? ""} ${content}`);
    const [row] = await this.sql<MemoryRow[]>`
      INSERT INTO memories (company_id, scope, scope_agent_id, kind, subject, content, pinned, source_session_id, source_run_id, source_task_id, author_kind, author_id, embedding)
      VALUES (${input.companyId}, ${input.scope}, ${scopeAgentId}, ${input.kind ?? "note"}, ${input.subject ?? ""}, ${content}, ${input.pinned ?? false},
              ${input.source?.sessionId ?? null}, ${input.source?.runId ?? null}, ${input.source?.taskId ?? null}, ${actor.kind}, ${actor.id ?? null}, ${embedding})
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    const memory = toMemory(row!);
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "memory.saved",
      subjectKind: "memory",
      subjectId: memory.id,
      after: {
        scope: memory.scope,
        kind: memory.kind,
        subject: memory.subject,
        preview: content.slice(0, 120),
      },
    });
    return memory;
  }

  async get(companyId: string, id: string): Promise<Memory | null> {
    const [row] = await this.sql<MemoryRow[]>`SELECT ${this.sql.unsafe(COLUMNS)} FROM memories WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toMemory(row) : null;
  }

  async list(
    companyId: string,
    filter: {
      scope?: Scope;
      scopeAgentId?: string | null;
      status?: Memory["status"][];
      agentView?: string;
      limit?: number;
    } = {},
  ): Promise<Memory[]> {
    const statuses = filter.status ?? ["active"];
    let scopeFilter = this.sql``;
    if (filter.agentView) {
      const { agentIds } = await visibleScopes(this.sql, companyId, filter.agentView);
      scopeFilter = this.sql`AND ((scope = 'agent' AND scope_agent_id = ${filter.agentView}) OR (scope = 'team' AND scope_agent_id = ANY(${agentIds})) OR scope = 'company')`;
    } else if (filter.scope) {
      scopeFilter = filter.scope === "company" ? this.sql`AND scope = 'company'` : this.sql`AND scope = ${filter.scope} AND scope_agent_id = ${filter.scopeAgentId ?? null}`;
    }
    const rows = await this.sql<MemoryRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM memories
      WHERE company_id = ${companyId} AND status = ANY(${statuses}) ${scopeFilter}
      ORDER BY pinned DESC, created_at DESC LIMIT ${filter.limit ?? 200}
    `;
    return rows.map(toMemory);
  }

  /** A correction: the new entry supersedes the old one, which stays readable. */
  async correct(companyId: string, id: string, content: string, actor: Actor): Promise<Memory> {
    const old = await this.get(companyId, id);
    if (!old) throw new LearningError("not_found", "memory not found");
    if (old.status !== "active") throw new LearningError("conflict", `memory is ${old.status}`);
    const trimmed = content.trim();
    if (!trimmed) throw new LearningError("invalid_input", "an empty correction");
    const embedding = await this.embed(`${old.subject} ${trimmed}`);
    const next = await this.sql.begin(async (tx) => {
      const [row] = await tx<MemoryRow[]>`
        INSERT INTO memories (company_id, scope, scope_agent_id, kind, subject, content, pinned, supersedes_id, source_session_id, source_run_id, source_task_id, author_kind, author_id, embedding)
        VALUES (${companyId}, ${old.scope}, ${old.scopeAgentId}, ${old.kind}, ${old.subject}, ${trimmed}, ${old.pinned}, ${old.id}, ${old.sourceSessionId}, ${old.sourceRunId}, ${old.sourceTaskId}, ${actor.kind}, ${actor.id ?? null}, ${embedding})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      await tx`UPDATE memories SET status = 'superseded', retired_at = now() WHERE id = ${old.id}`;
      await audit(tx, {
        companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "memory.corrected",
        subjectKind: "memory",
        subjectId: old.id,
        before: { content: old.content.slice(0, 200) },
        after: { replacedBy: row!.id, content: trimmed.slice(0, 200) },
      });
      return row!;
    });
    return toMemory(next);
  }

  /** Retires an entry with a reason; it stays in the record. */
  async retire(companyId: string, id: string, reason: string, actor: Actor): Promise<Memory> {
    const old = await this.get(companyId, id);
    if (!old) throw new LearningError("not_found", "memory not found");
    if (old.status !== "active") return old;
    if (!reason.trim()) throw new LearningError("invalid_input", "say why the memory is retired");
    const [row] = await this.sql<MemoryRow[]>`
      UPDATE memories SET status = 'retired', retired_reason = ${reason.trim()}, retired_at = now() WHERE id = ${id} RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "memory.retired",
      subjectKind: "memory",
      subjectId: id,
      after: { reason: reason.trim(), preview: old.content.slice(0, 120) },
    });
    return toMemory(row!);
  }

  async pin(companyId: string, id: string, pinned: boolean, actor: Actor): Promise<Memory> {
    const [row] = await this.sql<MemoryRow[]>`UPDATE memories SET pinned = ${pinned} WHERE id = ${id} AND company_id = ${companyId} RETURNING ${this.sql.unsafe(COLUMNS)}`;
    if (!row) throw new LearningError("not_found", "memory not found");
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: pinned ? "memory.pinned" : "memory.unpinned",
      subjectKind: "memory",
      subjectId: id,
    });
    return toMemory(row);
  }

  /** Changes the scope of an entry (a promotion writes a copy instead; this is for corrections by a person). */
  async rescope(companyId: string, id: string, scope: Scope, scopeAgentId: string | null, actor: Actor): Promise<Memory> {
    const [row] = await this.sql<MemoryRow[]>`
      UPDATE memories SET scope = ${scope}, scope_agent_id = ${scope === "company" ? null : scopeAgentId} WHERE id = ${id} AND company_id = ${companyId} RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!row) throw new LearningError("not_found", "memory not found");
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "memory.rescoped",
      subjectKind: "memory",
      subjectId: id,
      after: { scope, scopeAgentId },
    });
    return toMemory(row);
  }

  /**
   * The text that enters the prompt: the agent's own entries first, then its
   * teams', then the company's; pinned first, newest first; cut at the cap.
   */
  async snapshot(companyId: string, agentId: string, maxChars: number): Promise<{ text: string; count: number; truncated: boolean }> {
    const entries = await this.list(companyId, {
      agentView: agentId,
      limit: 500,
    });
    const order: Record<Scope, number> = { agent: 0, team: 1, company: 2 };
    entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || order[a.scope] - order[b.scope] || b.createdAt.getTime() - a.createdAt.getTime());
    const lines: string[] = [];
    let used = 0;
    let count = 0;
    let truncated = false;
    for (const m of entries) {
      const prefix = m.scope === "agent" ? "" : m.scope === "team" ? "[team] " : "[company] ";
      const subject = m.kind === "profile" && m.subject ? `${m.subject}: ` : "";
      const line = `- ${prefix}${subject}${m.content.replace(/\s+/g, " ").trim()}`;
      if (used + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      count++;
    }
    const text = lines.join("\n") + (truncated ? `\n(${entries.length - count} more entries: use memory_search)` : "");
    return { text, count, truncated };
  }

  /** Full-text search over the agent's visible memories, reranked semantically when possible. */
  async search(companyId: string, agentId: string, query: string, options: { limit?: number; includeRetired?: boolean } = {}): Promise<MemorySearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = options.limit ?? 8;
    const { agentIds } = await visibleScopes(this.sql, companyId, agentId);
    const statuses = options.includeRetired ? ["active", "retired", "superseded"] : ["active"];
    const visible = this
      .sql`company_id = ${companyId} AND status = ANY(${statuses}) AND ((scope = 'agent' AND scope_agent_id = ${agentId}) OR (scope = 'team' AND scope_agent_id = ANY(${agentIds})) OR scope = 'company')`;
    const textual = await this.sql<(MemoryRow & { rank: number })[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}, ts_rank(search, websearch_to_tsquery('english', ${q})) AS rank
      FROM memories WHERE ${visible} AND search @@ websearch_to_tsquery('english', ${q})
      ORDER BY rank DESC, created_at DESC LIMIT ${Math.max(limit * 4, 40)}
    `;
    if (!this.embedder) return textual.slice(0, limit).map((r) => ({ memory: toMemory(r), score: Number(r.rank) }));

    // Semantic pass: the textual candidates plus the most recent entries, scored by cosine.
    const [vector] = await this.embedder.embed([q]);
    const candidates = await this.sql<(MemoryRow & { embedding: number[] | null })[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}, embedding FROM memories
      WHERE ${visible} AND embedding IS NOT NULL AND (id = ANY(${textual.map((r) => r.id)}) OR created_at > now() - interval '180 days')
      ORDER BY created_at DESC LIMIT 400
    `;
    const textRank = new Map(textual.map((r) => [r.id, Number(r.rank)]));
    const scored = candidates.map((r) => {
      const sim = r.embedding && vector ? cosine(vector, r.embedding) : 0;
      const t = textRank.get(r.id) ?? 0;
      return { memory: toMemory(r), score: sim * 0.7 + Math.min(t, 1) * 0.3 };
    });
    for (const r of textual)
      if (!candidates.some((c) => c.id === r.id))
        scored.push({
          memory: toMemory(r),
          score: Math.min(Number(r.rank), 1) * 0.3,
        });
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0.05).slice(0, limit);
  }

  /** Embeds the entries that have no vector yet (after an embedder is configured). */
  async backfillEmbeddings(companyId: string, batch = 50): Promise<number> {
    if (!this.embedder) return 0;
    const rows = await this.sql<
      { id: string; subject: string; content: string }[]
    >`SELECT id, subject, content FROM memories WHERE company_id = ${companyId} AND embedding IS NULL AND status = 'active' LIMIT ${batch}`;
    if (rows.length === 0) return 0;
    const vectors = await this.embedder.embed(rows.map((r) => `${r.subject} ${r.content}`));
    for (let i = 0; i < rows.length; i++) await this.sql`UPDATE memories SET embedding = ${vectors[i]!} WHERE id = ${rows[i]!.id}`;
    return rows.length;
  }

  private async embed(text: string): Promise<number[] | null> {
    if (!this.embedder) return null;
    try {
      const [v] = await this.embedder.embed([text]);
      return v ?? null;
    } catch {
      // A failed embedding never blocks a memory: the entry stays searchable by text.
      return null;
    }
  }
}
