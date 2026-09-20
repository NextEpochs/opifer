import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, eventsSocket, type Agent, type Approval, type Company, type CostReport, type ToolPermissionView } from "./api";
import { Card, buttonCls, inputCls } from "./ui";
import type { stringsFor } from "./i18n";

type T = ReturnType<typeof stringsFor>;

/** Minimal governance page (M2): the inbox, costs and budgets, tool permissions per agent. */
export function Governance({ company, t }: { company: Company; t: T }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [costs, setCosts] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, p, c] = await Promise.all([api.agents(company.id), api.approvals(company.id, "pending"), api.costs(company.id)]);
      setAgents(a);
      setApprovals(p);
      setCosts(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [company.id]);

  useEffect(() => {
    void load();
    return eventsSocket((event) => {
      if (event.companyId === company.id && event.type !== "session.event") void load();
    }, () => {});
  }, [load, company.id]);

  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name ?? "—";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {error && (
        <p role="alert" className="sm:col-span-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <Inbox approvals={approvals} agentName={agentName} t={t} onChanged={load} />
      </div>
      <Costs company={company} costs={costs} agents={agents} t={t} onChanged={load} />
      <Permissions company={company} agents={agents} t={t} onChanged={load} />
    </div>
  );
}

function describe(a: Approval, t: T): string {
  const s = a.subject;
  if (a.kind === "tool_use" || a.kind === "dangerous_command") {
    const args = (s["arguments"] ?? {}) as Record<string, unknown>;
    const detail = typeof args["command"] === "string" ? args["command"] : JSON.stringify(args);
    return `${String(s["tool"])}: ${String(detail).slice(0, 200)}`;
  }
  if (a.kind === "budget_increase") return `${String(s["scope"])}: ${Number(s["spent"]).toFixed(2)} / ${String(s["cap"])} ${String(s["currency"])}`;
  return t.kinds[a.kind] ?? a.kind;
}

function Inbox({ approvals, agentName, t, onChanged }: { approvals: Approval[]; agentName: (id: string | null) => string; t: T; onChanged: () => Promise<void> }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (a: Approval, status: "approved" | "denied") => {
    setBusy(a.id);
    try {
      const cap = a.kind === "budget_increase" && status === "approved" ? Number(a.subject["cap"]) * 2 : undefined;
      await api.decide(a.id, status, notes[a.id]?.trim() || undefined, cap);
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t.inbox} id="inbox">
      {approvals.length === 0 ? (
        <p className="text-sm text-zinc-500">{t.nothingToDecide}</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {approvals.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-medium ${a.risk === "high" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"}`}>
                    {t.kinds[a.kind] ?? a.kind}
                  </span>
                  <span className="font-medium">{agentName(a.agentId)}</span>
                  <span className="text-zinc-500"> · {new Date(a.createdAt).toLocaleString()}</span>
                </p>
                <p className="mt-1 break-all font-mono text-xs">{describe(a, t)}</p>
                {a.reason && <p className="text-xs text-zinc-500">{a.reason}</p>}
                <input value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder={t.decisionNote} aria-label={t.decisionNote} className={`${inputCls} mt-2`} />
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy === a.id} onClick={() => void decide(a, "approved")} className={buttonCls}>
                  {t.approve}
                </button>
                <button
                  type="button"
                  disabled={busy === a.id}
                  onClick={() => void decide(a, "denied")}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {t.deny}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Costs({ company, costs, agents, t, onChanged }: { company: Company; costs: CostReport | null; agents: Agent[]; t: T; onChanged: () => Promise<void> }) {
  const [cap, setCap] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amount = Number(cap);
    if (!Number.isFinite(amount) || amount < 0) return;
    setBusy(true);
    try {
      await api.setBudget(company.id, scope ? { scopeKind: "agent", scopeId: scope, cap: amount } : { scopeKind: "company", cap: amount });
      setCap("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const eur = (n: number) => `${n.toFixed(4)} €`;

  return (
    <Card title={`${t.costs} — ${t.thisMonth}`} id="costs">
      {!costs ? (
        <p className="text-sm text-zinc-500">…</p>
      ) : (
        <>
          <p className="text-2xl font-semibold">{eur(costs.total.eur)}</p>
          {costs.byAgent.length === 0 ? (
            <p className="text-sm text-zinc-500">{t.noCosts}</p>
          ) : (
            <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <h3 className="font-semibold uppercase text-zinc-500">{t.byAgent}</h3>
                <ul>
                  {costs.byAgent.map((a) => (
                    <li key={a.agentId ?? "none"} className="flex justify-between">
                      <span>{a.agentName ?? "—"}</span>
                      <span className="font-mono">
                        {eur(a.eur)} · {a.calls} {t.calls}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold uppercase text-zinc-500">{t.byModel}</h3>
                <ul>
                  {costs.byModel.map((m) => (
                    <li key={m.model ?? "none"} className="flex justify-between">
                      <span>{m.model ?? "—"}</span>
                      <span className="font-mono">
                        {eur(m.eur)} · {m.inputTokens}/{m.outputTokens}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <h3 className="mt-4 text-xs font-semibold uppercase text-zinc-500">{t.budgets}</h3>
          {costs.policies.length === 0 ? (
            <p className="text-sm text-zinc-500">{t.noBudgets}</p>
          ) : (
            <ul className="text-sm">
              {costs.policies.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span>
                    {p.scopeKind === "company" ? t.wholeCompany : `${agents.find((a) => a.id === p.scopeId)?.name ?? p.scopeKind}`} · {p.window} · {p.cap} {p.currency}
                  </span>
                  <button type="button" onClick={() => void api.removeBudget(company.id, p.id).then(onChanged)} className="text-xs text-red-600 hover:underline">
                    {t.remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t.newBudget} className={`${inputCls} w-auto flex-1`}>
          <option value="">{t.wholeCompany}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input value={cap} onChange={(e) => setCap(e.target.value)} type="number" min="0" step="0.01" placeholder={t.cap} aria-label={t.cap} required className={`${inputCls} w-28`} />
        <button type="submit" disabled={busy} className={buttonCls}>
          {t.newBudget}
        </button>
      </form>
    </Card>
  );
}

function Permissions({ company, agents, t, onChanged }: { company: Company; agents: Agent[]; t: T; onChanged: () => Promise<void> }) {
  const [agentId, setAgentId] = useState("");
  const [tools, setTools] = useState<ToolPermissionView[]>([]);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;

  const load = useCallback(async () => {
    if (!agent) return setTools([]);
    setTools(await api.permissions(agent.id));
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (tool: string, permission: string) => {
    if (!agent) return;
    await api.setToolPolicy(company.id, { targetKind: "agent", targetId: agent.id, toolName: tool, permission });
    await load();
  };

  const toggleStatus = async () => {
    if (!agent) return;
    await api.setAgentStatus(agent.id, agent.status === "active" ? "paused" : "active");
    await onChanged();
  };

  return (
    <Card title={t.permissions} id="permissions">
      {agents.length === 0 ? (
        <p className="text-sm text-zinc-500">{t.noAgents}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={agent?.id ?? ""} onChange={(e) => setAgentId(e.target.value)} aria-label={t.pickAgent} className={`${inputCls} w-auto flex-1`}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {agent && (
              <span className="text-xs text-zinc-500">
                {t.agentStatus}: <span className={agent.status === "active" ? "text-emerald-600" : "text-amber-600"}>{agent.status}</span>
              </span>
            )}
            {agent && agent.status !== "archived" && (
              <button type="button" onClick={() => void toggleStatus()} className="text-xs text-brand-600 hover:underline">
                {agent.status === "active" ? t.pause : t.resume}
              </button>
            )}
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-1">{t.tool}</th>
                <th className="py-1">{t.risk}</th>
                <th className="py-1">{t.permission}</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 font-mono text-xs">{tool.name}</td>
                  <td className="py-1 text-xs">{tool.risk}</td>
                  <td className="py-1">
                    <select value={tool.permission} onChange={(e) => void change(tool.name, e.target.value)} aria-label={`${t.permission} ${tool.name}`} className={`${inputCls} w-auto py-0.5`}>
                      {(["automatic", "approval", "blocked"] as const).map((p) => (
                        <option key={p} value={p}>
                          {t.permissionNames[p]}
                        </option>
                      ))}
                    </select>
                    <span className="ml-2 text-xs text-zinc-400">
                      {t.from} {t.sources[tool.source] ?? tool.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
