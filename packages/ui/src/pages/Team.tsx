import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { api, type AgentView, type ModelsInfo, type ToolPermissionView } from "../api";
import { fill } from "../i18n";
import { ActivityChip, Avatar, Button, Card, Input, Segmented, Select, Textarea, money } from "../ui";
import { OrgChart, type HireRequest } from "../components/OrgChart";
import { usePref } from "../prefs";
import type { Workspace } from "../App";

type Tab = "overview" | "permissions" | "budget" | "history";

/** The team: agents as colleagues. Step 2 turns this grid into the org chart. */
export function TeamPage({ ws, param }: { ws: Workspace; param: string | null }) {
  const { t, overview } = ws;
  const agents = overview?.agents ?? [];
  const selected = agents.find((a) => a.id === param) ?? null;
  const hiring = param === "new";
  const [view, setView] = usePref<"chart" | "cards">("team.view", "chart");
  const [hireDefaults, setHireDefaults] = useState<HireRequest | null>(null);
  const hire = (r: HireRequest) => {
    setHireDefaults(r);
    ws.go("team", "new");
  };

  return (
    <div className="flex h-full min-h-screen">
      <div className="flex min-w-0 flex-1 flex-col gap-6 p-6 sm:p-9">
        <header className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{t.teamTitle}</h1>
            <p className="mt-1.5 text-[15px] text-mute">{t.teamSub}</p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented value={view} onChange={setView} label={t.teamTitle} options={[{ value: "chart", label: t.orgChart }, { value: "cards", label: t.cards }]} className="w-48" />
            <Button variant="primary" onClick={() => hire({ role: "", reportsToAgentId: null })}>
              <Plus size={16} /> {t.hireAgent}
            </Button>
          </div>
        </header>
        {agents.length === 0 && !hiring && view === "cards" && <p className="text-sm text-mute">{t.nobodyWorking}</p>}
        {view === "chart" && (
          <Card className="min-h-[560px] flex-1 overflow-hidden">
            <OrgChart ws={ws} selectedId={selected?.id ?? null} onHire={hire} />
          </Card>
        )}
        <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3 ${view === "chart" ? "hidden" : ""}`}>
          {agents.map((a) => (
            <button key={a.id} type="button" onClick={() => ws.go("team", a.id)} className={`flex flex-col gap-3 rounded-card border bg-card p-4 text-left shadow-card transition hover:border-accent ${selected?.id === a.id ? "border-accent" : "border-line"}`}>
              <div className="flex items-center gap-3">
                <Avatar name={a.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{a.name}</div>
                  <div className="truncate text-[13px] text-mute">{a.role || "—"}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[13px] text-mute">
                <ActivityChip activity={a.activity} t={t} />
                <span className="ml-auto">
                  {money(a.spend.eur, a.spend.currency)} {a.spend.cap ? `/ ${money(a.spend.cap, a.spend.currency, 0)}` : ""}
                </span>
              </div>
              {a.reportsToAgentId && (
                <div className="text-[12px] text-faint">
                  {t.reportsTo}: {ws.agentName(a.reportsToAgentId)}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
      {(selected || hiring) && (
        <aside className="m-4 flex w-[400px] shrink-0 flex-col overflow-hidden rounded-[22px] border border-line bg-card shadow-card" aria-label={selected ? selected.name : t.newAgent}>
          {hiring ? <HireForm ws={ws} defaults={hireDefaults} /> : selected ? <AgentDrawer key={selected.id} ws={ws} agent={selected} /> : null}
        </aside>
      )}
    </div>
  );
}

function HireForm({ ws, defaults }: { ws: Workspace; defaults: HireRequest | null }) {
  const { t, company, overview } = ws;
  const [name, setName] = useState("");
  const [role, setRole] = useState(defaults?.role ?? "");
  const [model, setModel] = useState("");
  const [reportsTo, setReportsTo] = useState(defaults?.reportsToAgentId ?? "");
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.models().then(setModels).catch(() => setModels(null));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createAgent(company.id, { name: name.trim(), ...(role.trim() ? { role: role.trim() } : {}), ...(model ? { model } : {}), ...(reportsTo ? { reportsToAgentId: reportsTo } : {}) });
      await ws.refresh();
      ws.go("team", created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-5">
      <div className="flex items-center">
        <h2 className="m-0 font-display text-2xl font-semibold">{t.hireAgent}</h2>
        <button type="button" aria-label={t.remove} onClick={() => ws.go("team")} className="ml-auto rounded p-1 text-faint hover:bg-hover hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.agentName}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.agentRole}</span>
        <Textarea value={role} onChange={(e) => setRole(e.target.value)} placeholder={t.agentRoleHint} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.model}</span>
        <Select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">{t.defaultModel}{models ? ` (${models.default})` : ""}</option>
          {models?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.reportsTo}</span>
        <Select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
          <option value="">{t.you}</option>
          {overview?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>
      {error && (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || !name.trim()} className="mt-2">
        {t.hire}
      </Button>
    </form>
  );
}

function AgentDrawer({ ws, agent }: { ws: Workspace; agent: AgentView }) {
  const { t, company } = ws;
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: Tab[] = ["overview", "permissions", "budget", "history"];

  const toggleStatus = async () => {
    await api.setAgentStatus(agent.id, agent.status === "active" ? "paused" : "active");
    await ws.refresh();
  };

  return (
    <>
      <div className="flex items-center gap-3 px-5 pt-5">
        <Avatar name={agent.name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-2xl font-semibold leading-tight">{agent.name}</div>
          <div className="truncate text-[13px] text-mute">
            {agent.model ?? t.defaultModel} · rev {agent.currentRevision}
          </div>
        </div>
        {agent.status !== "archived" && (
          <Button variant="ghost" size="sm" onClick={() => void toggleStatus()}>
            {agent.status === "active" ? t.pause : t.resume}
          </Button>
        )}
        <button type="button" aria-label={t.remove} onClick={() => ws.go("team")} className="rounded p-1 text-faint hover:bg-hover hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2 px-5">
        <ActivityChip activity={agent.activity} t={t} />
        {agent.doing && <span className="truncate text-[13px] text-mute">{agent.doing}</span>}
      </div>
      <div role="tablist" className="mt-4 flex gap-0.5 border-b border-line px-5">
        {tabs.map((tb) => (
          <button key={tb} type="button" role="tab" aria-selected={tab === tb} onClick={() => setTab(tb)} className={`border-b-2 px-2.5 py-2 text-[13px] font-bold ${tab === tb ? "border-accent text-ink" : "border-transparent text-mute hover:text-ink"}`}>
            {t.tabs[tb]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-5">
        {tab === "overview" && <OverviewTab ws={ws} agent={agent} />}
        {tab === "permissions" && <PermissionsTab ws={ws} agent={agent} />}
        {tab === "budget" && <BudgetTab ws={ws} agent={agent} />}
        {tab === "history" && <HistoryTab ws={ws} agent={agent} />}
      </div>
      <div className="border-t border-line px-5 py-3 text-[12px] text-faint">
        {company.name} · {agent.id.slice(0, 8)}
      </div>
    </>
  );
}

function OverviewTab({ ws, agent }: { ws: Workspace; agent: AgentView }) {
  const { t } = ws;
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [model, setModel] = useState(agent.model ?? "");
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.models().then(setModels).catch(() => setModels(null));
  }, []);
  const dirty = name !== agent.name || role !== agent.role || model !== (agent.model ?? "");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, { name: name.trim(), role, model: model || null });
      await ws.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.agentName}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.agentRole}</span>
        <Textarea value={role} onChange={(e) => setRole(e.target.value)} placeholder={t.agentRoleHint} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.model}</span>
        <Select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">{t.defaultModel}{models ? ` (${models.default})` : ""}</option>
          {models?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </Select>
      </label>
      <div className="text-[13px] text-mute">
        {money(agent.spend.eur, agent.spend.currency)} {t.spentThisMonth} · {agent.spend.calls} {t.calls}
      </div>
      {error && (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={!dirty || busy} className="self-start">
        {t.save}
      </Button>
    </form>
  );
}

function PermissionsTab({ ws, agent }: { ws: Workspace; agent: AgentView }) {
  const { t, company } = ws;
  const [tools, setTools] = useState<ToolPermissionView[]>([]);
  const load = useCallback(() => api.permissions(agent.id).then(setTools).catch(() => setTools([])), [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (tool: string, permission: "automatic" | "approval" | "blocked") => {
    await api.setToolPolicy(company.id, { targetKind: "agent", targetId: agent.id, toolName: tool, permission });
    await load();
  };
  const labels = t.tools as Record<string, string>;
  const blurbs = t.toolBlurbs as Record<string, string>;
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-mute">{fill(t.permissionsIntro, { agent: agent.name })}</p>
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-center gap-2.5 rounded-control border border-line px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold">{labels[tool.name] ?? tool.name}</div>
            <div className="truncate text-[12px] text-mute">
              {blurbs[tool.name] ?? tool.description} · {t.from[tool.source]}
            </div>
          </div>
          <Segmented value={tool.permission} onChange={(v) => void change(tool.name, v)} label={`${labels[tool.name] ?? tool.name}`} options={[{ value: "automatic", label: t.perm.automatic }, { value: "approval", label: t.perm.approval }, { value: "blocked", label: t.perm.blocked }]} className="w-44" />
        </div>
      ))}
      <p className="m-0 text-[12px] text-faint">{t.dangerousAlwaysAsk}</p>
    </div>
  );
}

function BudgetTab({ ws, agent }: { ws: Workspace; agent: AgentView }) {
  const { t, company } = ws;
  const [cap, setCap] = useState(agent.spend.cap ?? 10);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.setBudget(company.id, { scopeKind: "agent", scopeId: agent.id, cap });
      await ws.refresh();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const report = await api.costs(company.id);
    const policy = report.policies.find((p) => p.scopeKind === "agent" && p.scopeId === agent.id);
    if (policy) await api.removeBudget(company.id, policy.id);
    await ws.refresh();
  };
  const ratio = agent.spend.cap ? Math.min(1, agent.spend.eur / agent.spend.cap) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-display text-[32px] font-bold leading-none">{money(agent.spend.eur, agent.spend.currency)}</div>
        <div className="mt-1 text-[13px] text-mute">{agent.spend.cap ? fill(t.ofCap, { cap: money(agent.spend.cap, agent.spend.currency, 0) }) : t.noCap}</div>
        {agent.spend.cap ? (
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: ratio >= 1 ? "var(--o-danger)" : ratio >= 0.8 ? "var(--o-warn)" : "var(--o-accent)" }} />
          </div>
        ) : null}
      </div>
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-mute">{t.monthlyCap}</span>
        <div className="flex items-center gap-3">
          <input type="range" min="1" max="200" step="1" value={cap} onChange={(e) => setCap(Number(e.target.value))} className="flex-1" />
          <strong className="w-20 text-right">{money(cap, agent.spend.currency, 0)}</strong>
        </div>
      </label>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          {t.setCap}
        </Button>
        {agent.spend.cap ? (
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            {t.removeCap}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function HistoryTab({ ws, agent }: { ws: Workspace; agent: AgentView }) {
  const { t } = ws;
  const [revisions, setRevisions] = useState<Awaited<ReturnType<typeof api.revisions>>>([]);
  const load = useCallback(() => api.revisions(agent.id).then(setRevisions).catch(() => setRevisions([])), [agent.id]);
  useEffect(() => {
    void load();
  }, [load, agent.currentRevision]);
  const restore = async (revision: number) => {
    await api.restoreRevision(agent.id, revision);
    await ws.refresh();
    await load();
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-mute">{t.revisions}</p>
      {revisions.map((r) => (
        <div key={r.revision} className="flex items-center gap-3 rounded-control border border-line px-3 py-2.5 text-sm">
          <span className="w-10 font-mono text-[12px] text-mute">#{r.revision}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">{r.config.name}</div>
            <div className="truncate text-[12px] text-mute">
              {r.config.role || "—"} · {r.config.model ?? t.defaultModel}
              {r.note ? ` · ${r.note}` : ""}
            </div>
          </div>
          {r.revision === agent.currentRevision ? (
            <span className="text-[12px] font-bold text-accent-text">{t.current}</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void restore(r.revision)}>
              {t.restore}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
