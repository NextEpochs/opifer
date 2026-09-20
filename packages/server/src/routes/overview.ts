/**
 * Company overview for the Home board: who is working on what, what needs a
 * person, spend against the cap, what was done recently. One call, so the
 * interface can render a whole screen without stitching endpoints.
 */

import type { AgentRuntime } from "@opifer/runtime";
import type { FastifyInstance } from "fastify";
import type { Governance } from "../governance.js";

export interface OverviewRoutesOptions {
  runtime: AgentRuntime;
  governance: Governance | null;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  model: string | null;
  reports_to_agent_id: string | null;
  current_revision: number;
}

interface RunRow {
  id: string;
  session_id: string;
  agent_id: string;
  status: string;
  stop_reason: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  title: string | null;
  preview: string | null;
}

interface AuditRow {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  subject_kind: string;
  subject_id: string | null;
  after: Record<string, unknown> | null;
  occurred_at: Date;
}

function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function registerOverviewRoutes(app: FastifyInstance, options: OverviewRoutesOptions): Promise<void> {
  const { runtime, governance } = options;
  const { sql } = app.opifer.db;

  app.get<{ Params: { id: string } }>("/companies/:id/overview", async (request, reply) => {
    const companyId = request.params.id;
    const [company] = await sql<{ id: string; name: string; mission: string | null }[]>`SELECT id, name, mission FROM companies WHERE id = ${companyId}`;
    if (!company) return reply.code(404).send({ error: "company not found" });

    const since = monthStart();
    const agents = await sql<AgentRow[]>`SELECT id, name, role, status, model, reports_to_agent_id, current_revision FROM agents WHERE company_id = ${companyId} ORDER BY created_at`;
    const sessions = await runtime.store.listSessions(companyId);
    const spendRows = await sql<{ agent_id: string | null; eur: string; usd: string; calls: string }[]>`
      SELECT agent_id, coalesce(sum(amount_eur), 0)::text AS eur, coalesce(sum(amount_usd), 0)::text AS usd, count(*)::text AS calls
      FROM cost_events WHERE company_id = ${companyId} AND occurred_at >= ${since} GROUP BY agent_id
    `;
    const pendingRows = await sql<{ agent_id: string | null; n: string }[]>`
      SELECT agent_id, count(*)::text AS n FROM approvals WHERE company_id = ${companyId} AND status = 'pending' GROUP BY agent_id
    `;
    const runs = await sql<RunRow[]>`
      SELECT r.id, r.session_id, r.agent_id, r.status, r.stop_reason, r.error, r.started_at, r.finished_at, s.title,
        (SELECT left(p->>'text', 240) FROM messages m, jsonb_array_elements(m.content) p
          WHERE m.run_id = r.id AND m.role = 'assistant' AND p->>'type' = 'text' ORDER BY m.seq DESC LIMIT 1) AS preview
      FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE r.company_id = ${companyId} AND r.status <> 'running'
      ORDER BY coalesce(r.finished_at, r.started_at) DESC LIMIT 12
    `;
    const activity = await sql<AuditRow[]>`
      SELECT id, actor_kind, actor_id, action, subject_kind, subject_id, after, occurred_at FROM audit_log
      WHERE company_id = ${companyId} ORDER BY occurred_at DESC LIMIT 15
    `;

    const spendByAgent = new Map(spendRows.map((r) => [r.agent_id, { eur: Number(r.eur), usd: Number(r.usd), calls: Number(r.calls) }]));
    const pendingByAgent = new Map(pendingRows.map((r) => [r.agent_id, Number(r.n)]));
    const runningSessions = sessions.filter((s) => runtime.isRunning(s.id));
    const latestBySession = new Map<string, RunRow>();
    for (const run of runs) if (!latestBySession.has(run.session_id)) latestBySession.set(run.session_id, run);

    const policies = governance ? await governance.budget.listPolicies(companyId) : [];
    const companyCap = policies.find((p) => p.scopeKind === "company" && p.window === "monthly") ?? null;
    const capByAgent = new Map(policies.filter((p) => p.scopeKind === "agent" && p.window === "monthly").map((p) => [p.scopeId, p]));

    const agentViews = agents.map((a) => {
      const running = runningSessions.find((s) => s.agentId === a.id);
      const lastRun = runs.find((r) => r.agent_id === a.id);
      const waitingRun = runs.find((r) => r.agent_id === a.id && r.status === "waiting");
      const spend = spendByAgent.get(a.id) ?? { eur: 0, usd: 0, calls: 0 };
      const cap = capByAgent.get(a.id);
      const activity: "working" | "waiting" | "idle" | "paused" | "stopped" =
        a.status === "budget_stopped" ? "stopped" : a.status === "paused" || a.status === "archived" ? "paused" : running ? "working" : (pendingByAgent.get(a.id) ?? 0) > 0 ? "waiting" : "idle";
      const doing = running?.title ?? waitingRun?.title ?? null;
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        model: a.model,
        reportsToAgentId: a.reports_to_agent_id,
        currentRevision: a.current_revision,
        activity,
        doing,
        pendingApprovals: pendingByAgent.get(a.id) ?? 0,
        spend: { ...spend, cap: cap ? cap.cap : null, currency: cap?.currency ?? "EUR" },
        lastActiveAt: (running ? new Date() : lastRun ? (lastRun.finished_at ?? lastRun.started_at) : null)?.toISOString() ?? null,
      };
    });
    const totalEur = [...spendByAgent.values()].reduce((n, s) => n + s.eur, 0);
    const totalUsd = [...spendByAgent.values()].reduce((n, s) => n + s.usd, 0);
    const pending = [...pendingByAgent.values()].reduce((n, c) => n + c, 0);

    return {
      company,
      agents: agentViews,
      pending,
      spend: { eur: totalEur, usd: totalUsd, cap: companyCap ? companyCap.cap : null, currency: companyCap?.currency ?? "EUR", since: since.toISOString() },
      recentRuns: runs.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        sessionTitle: r.title,
        agentId: r.agent_id,
        status: r.status,
        stopReason: r.stop_reason,
        error: r.error,
        startedAt: r.started_at.toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
        preview: r.preview,
      })),
      activity: activity.map((e) => ({ id: e.id, actorKind: e.actor_kind, actorId: e.actor_id, action: e.action, subjectKind: e.subject_kind, subjectId: e.subject_id, after: e.after, occurredAt: e.occurred_at.toISOString() })),
      working: runningSessions.length,
    };
  });
}
