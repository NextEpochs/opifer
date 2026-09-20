import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, eventsSocket, type Agent, type AuditEntry, type Company, type Health } from "./api";
import { detectLocale, saveLocale, stringsFor, type Locale } from "./i18n";
import { Chat } from "./Chat";

export function App() {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const t = stringsFor(locale);
  const [health, setHealth] = useState<Health | null | "error">(null);
  const [live, setLive] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<"dashboard" | "chat">("dashboard");

  const refresh = useCallback(async () => {
    try {
      setHealth(await api.health());
      const list = await api.companies();
      setCompanies(list);
      setSelected((current) => current ?? list[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setHealth("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const close = eventsSocket(() => void refresh(), setLive);
    return close;
  }, [refresh]);

  const switchLocale = (next: Locale) => {
    setLocale(next);
    saveLocale(next);
  };

  const selectedCompany = companies.find((c) => c.id === selected) ?? null;

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-brand-600 dark:text-brand-500">Opifer</span>
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t.tagline}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className={`inline-flex items-center gap-1.5 ${live ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}`}>
            <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-400"}`} aria-hidden />
            {live ? t.live : t.offline}
          </span>
          <div className="flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700" role="group" aria-label="Language">
            {(["en", "it"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => switchLocale(l)}
                aria-pressed={locale === l}
                className={`px-2.5 py-1 uppercase ${locale === l ? "bg-brand-600 text-white" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-zinc-200 text-sm dark:border-zinc-800" aria-label="Sections">
        {(["dashboard", "chat"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPage(p)}
            aria-current={page === p ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 ${page === p ? "border-brand-600 font-medium text-brand-700 dark:text-brand-500" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
          >
            {p === "dashboard" ? t.dashboard : t.chat}
          </button>
        ))}
      </nav>

      {error && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {page === "chat" && selectedCompany && <Chat key={selectedCompany.id} company={selectedCompany} t={t} />}
      {page === "chat" && !selectedCompany && <p className="text-sm text-zinc-500">{t.noCompanies}</p>}

      {page === "dashboard" && (
      <section aria-labelledby="status" className="grid gap-4 sm:grid-cols-2">
        <Card title={t.status} id="status">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-zinc-500">{t.server}</dt>
            <dd>{health === null ? "…" : health === "error" ? <Badge tone="red">{t.unreachable}</Badge> : <Badge tone="green">{t.ok}</Badge>}</dd>
            <dt className="text-zinc-500">{t.database}</dt>
            <dd>{typeof health === "object" && health ? <Badge tone={health.database === "ok" ? "green" : "red"}>{health.database === "ok" ? t.ok : t.degraded}</Badge> : "—"}</dd>
            <dt className="text-zinc-500">{t.version}</dt>
            <dd>{typeof health === "object" && health ? health.version : "—"}</dd>
            <dt className="text-zinc-500">{t.mode}</dt>
            <dd>{typeof health === "object" && health ? (t.modes[health.mode] ?? health.mode) : "—"}</dd>
          </dl>
          <p className="mt-3 text-xs text-zinc-400">{t.milestone}</p>
        </Card>

        <Card title={t.companies} id="companies">
          {companies.length === 0 ? (
            <p className="text-sm text-zinc-500">{t.noCompanies}</p>
          ) : (
            <ul className="space-y-1">
              {companies.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    aria-current={selected === c.id ? "true" : undefined}
                    className={`w-full rounded px-2 py-1 text-left text-sm ${selected === c.id ? "bg-brand-50 text-brand-700 dark:bg-zinc-800 dark:text-brand-500" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
                  >
                    {c.name}
                    {c.mission && <span className="block truncate text-xs text-zinc-500">{c.mission}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <CompanyForm t={t} onCreated={refresh} />
        </Card>
      </section>

      )}

      {page === "dashboard" && selectedCompany && <CompanyPanel key={selectedCompany.id} company={selectedCompany} t={t} />}
    </div>
  );
}

type T = ReturnType<typeof stringsFor>;

function Card({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 id={id} className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Badge({ tone, children }: { tone: "green" | "red"; children: React.ReactNode }) {
  const cls = tone === "green" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function CompanyForm({ t, onCreated }: { t: T; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createCompany(name.trim(), mission.trim() || undefined);
      setName("");
      setMission("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <h3 className="text-xs font-semibold uppercase text-zinc-500">{t.newCompany}</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.companyName} aria-label={t.companyName} required className={inputCls} />
      <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder={t.mission} aria-label={t.mission} className={inputCls} />
      <button type="submit" disabled={busy} className={buttonCls}>
        {t.create}
      </button>
    </form>
  );
}

function CompanyPanel({ company, t }: { company: Company; t: T }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setAgents(await api.agents(company.id));
    setAudit(await api.audit(company.id));
  }, [company.id]);

  useEffect(() => {
    void load();
    return eventsSocket((event) => {
      if (event.companyId === company.id) void load();
    }, () => {});
  }, [load, company.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createAgent(company.id, {
        name: name.trim(),
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(reportsTo ? { reportsToAgentId: reportsTo } : {}),
      });
      setName("");
      setRole("");
      setReportsTo("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map(agents.map((a) => [a.id, a]));

  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <Card title={`${t.agents} — ${company.name}`} id="agents">
        {agents.length === 0 ? (
          <p className="text-sm text-zinc-500">{t.noAgents}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {agents.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-2">
                <span>
                  <span className="font-medium">{a.name}</span>
                  {a.role && <span className="text-zinc-500"> · {a.role}</span>}
                </span>
                <span className="text-xs text-zinc-400">
                  {t.reportsTo}: {a.reportsToAgentId ? (byId.get(a.reportsToAgentId)?.name ?? "?") : t.nobody}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="mt-4 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">{t.newAgent}</h3>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.agentName} aria-label={t.agentName} required className={inputCls} />
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t.agentRole} aria-label={t.agentRole} className={inputCls} />
          <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} aria-label={t.reportsTo} className={inputCls}>
            <option value="">{t.reportsTo}: {t.nobody}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {t.reportsTo}: {a.name}
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className={buttonCls}>
            {t.create}
          </button>
        </form>
      </Card>

      <Card title={t.audit} id="audit">
        {audit.length === 0 ? (
          <p className="text-sm text-zinc-500">—</p>
        ) : (
          <ol className="space-y-1 text-xs">
            {audit.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 font-mono">
                <span>
                  <span className="text-zinc-500">{e.actorKind}</span> {e.action}
                </span>
                <time dateTime={e.occurredAt} className="text-zinc-400">
                  {new Date(e.occurredAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-800";
const buttonCls =
  "rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:opacity-50 dark:focus:ring-zinc-700";
