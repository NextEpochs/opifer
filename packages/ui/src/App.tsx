import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Coins, GraduationCap, Home as HomeIcon, OctagonX, Plug, Inbox as InboxIcon, KanbanSquare, MessageSquare, Settings as SettingsIcon, Users } from "lucide-react";
import { api, eventsSocket, type Approval, type Company, type Overview, type Task } from "./api";
import { detectLocale, fill, saveLocale, stringsFor, type Locale, type Strings } from "./i18n";
import { useDocumentAttributes, usePref, type Theme, type ViewMode } from "./prefs";
import { Avatar, Segmented } from "./ui";
import { HomePage } from "./pages/Home";
import { InboxPage } from "./pages/Inbox";
import { TeamPage } from "./pages/Team";
import { ChatPage } from "./pages/Chat";
import { MoneyPage } from "./pages/Money";
import { SettingsPage } from "./pages/Settings";
import { WorkPage } from "./pages/Work";
import { LearningPage } from "./pages/Learning";
import { ConnectionsPage } from "./pages/Connections";

export type Page = "home" | "inbox" | "team" | "work" | "chat" | "money" | "learning" | "connections" | "settings";

const PAGES: Page[] = ["home", "inbox", "team", "work", "chat", "money", "learning", "connections", "settings"];

function pageFromHash(): { page: Page; param: string | null } {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, param] = raw.split("/");
  const page = PAGES.includes(name as Page) ? (name as Page) : "home";
  return { page, param: param ?? null };
}

/** Everything a page needs from the shell. */
export interface Workspace {
  company: Company;
  companies: Company[];
  overview: Overview | null;
  pending: Approval[];
  /** Tasks that need a person: delivered for review, or blocked. */
  attention: Task[];
  t: Strings;
  locale: Locale;
  mode: ViewMode;
  refresh: () => Promise<void>;
  go: (page: Page, param?: string) => void;
  agentName: (id: string | null) => string;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [mode, setMode] = usePref<ViewMode>("mode", "simple");
  const [theme, setTheme] = usePref<Theme>("theme", "dark");
  useDocumentAttributes(mode, theme);
  const t = stringsFor(locale);

  const [route, setRoute] = useState(pageFromHash);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = usePref<string | null>("company", null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);
  const [attention, setAttention] = useState<Task[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((page: Page, param?: string) => {
    location.hash = param ? `#/${page}/${param}` : `#/${page}`;
  }, []);

  const company = useMemo(() => companies.find((c) => c.id === companyId) ?? companies[0] ?? null, [companies, companyId]);

  const loadCompanies = useCallback(async () => {
    try {
      const list = await api.companies();
      setCompanies(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!company) return;
    try {
      const [o, p, a] = await Promise.all([api.overview(company.id), api.approvals(company.id, "pending"), api.tasks(company.id, { status: "in_review,blocked" })]);
      setOverview(o);
      setPending(p);
      setAttention(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [company]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  // Any event of this company refreshes the overview, coalesced so a busy turn does not hammer the API.
  useEffect(() => {
    return eventsSocket((event) => {
      if (event.type === "company.created" || event.type === "company.stopped" || event.type === "company.resumed") void loadCompanies();
      if (!company || event.companyId !== company.id) return;
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 400);
    }, setLive);
  }, [company, refresh, loadCompanies]);

  const switchLocale = (next: Locale) => {
    setLocale(next);
    saveLocale(next);
  };

  const agentName = useCallback((id: string | null) => overview?.agents.find((a) => a.id === id)?.name ?? "—", [overview]);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const stopAll = async () => {
    if (!company || !window.confirm(fill(t.stopAllConfirm, { company: company.name }))) return;
    try {
      const result = await api.stopCompany(company.id);
      setStopNotice(fill(t.stoppedNotice, { sessions: String(result.interruptedSessions), routines: String(result.routinesSuspended) }));
      await loadCompanies();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const resumeAll = async () => {
    if (!company) return;
    try {
      await api.resumeCompany(company.id);
      setStopNotice(null);
      await loadCompanies();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const nav: Array<{ page: Page; label: string; icon: typeof HomeIcon; badge?: number; disabled?: boolean }> = [
    { page: "home", label: t.nav.home, icon: HomeIcon },
    { page: "inbox", label: t.nav.inbox, icon: InboxIcon, badge: pending.length + attention.length },
    { page: "team", label: t.nav.team, icon: Users },
    { page: "work", label: t.nav.work, icon: KanbanSquare },
    { page: "chat", label: t.nav.chat, icon: MessageSquare },
    { page: "money", label: t.nav.money, icon: Coins },
    { page: "learning", label: t.nav.learning, icon: GraduationCap },
    { page: "connections", label: t.nav.connections, icon: Plug },
  ];

  const ws: Workspace | null = company ? { company, companies, overview, pending, attention, t, locale, mode, refresh, go, agentName } : null;

  return (
    <div className="flex h-full min-h-screen">
      <nav className="flex w-[232px] shrink-0 flex-col gap-1.5 border-r border-line bg-panel px-4 py-6" aria-label={t.nav.home}>
        <a href="#/home" className="mb-4 flex items-center gap-2.5 px-2 font-display text-2xl font-semibold tracking-tight text-ink no-underline">
          <span className="accent-gradient flex h-[30px] w-[30px] items-center justify-center rounded-[9px] font-sans text-[15px] font-extrabold text-white">O</span>
          Opifer
        </a>
        {nav.map(({ page, label, icon: Icon, badge }) => (
          <a
            key={page}
            href={`#/${page}`}
            aria-current={route.page === page ? "page" : undefined}
            className={`flex items-center gap-3 rounded-control px-3 py-[11px] text-[15px] font-semibold no-underline transition ${route.page === page ? "bg-accent-soft text-ink shadow-[inset_2px_0_0_var(--o-accent)]" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
          >
            <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {badge ? (
              <span className="ml-auto flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-white">{badge}</span>
            ) : null}
          </a>
        ))}
        <div className="grow" />
        <a
          href="#/settings"
          aria-current={route.page === "settings" ? "page" : undefined}
          className={`flex items-center gap-3 rounded-control px-3 py-[11px] text-[15px] font-semibold no-underline transition ${route.page === "settings" ? "bg-accent-soft text-ink shadow-[inset_2px_0_0_var(--o-accent)]" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
        >
          <SettingsIcon size={20} strokeWidth={1.8} aria-hidden="true" />
          <span>{t.nav.settings}</span>
        </a>
        {company && company.status === "active" && (
          <button
            type="button"
            onClick={() => void stopAll()}
            className="mt-1 flex items-center gap-3 rounded-control px-3 py-[9px] text-[14px] font-semibold text-danger hover:bg-danger-soft"
          >
            <OctagonX size={20} strokeWidth={1.8} aria-hidden="true" />
            <span>{t.stopAll}</span>
          </button>
        )}
        <Segmented
          value={mode}
          onChange={setMode}
          label={t.viewMode}
          options={[
            { value: "simple", label: t.simple },
            { value: "advanced", label: t.advanced },
          ]}
          className="mt-2"
        />
        <div className="mt-2 flex items-center gap-2.5 px-2 pt-2 text-[13px] text-mute">
          <Avatar name="Mike" colour="#06B6D4" />
          <span>
            <strong className="text-ink">{company?.name ?? "Opifer"}</strong>
            <br />
            <span className={`inline-flex items-center gap-1.5 ${live ? "text-ok" : "text-mute"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-ok" : "bg-faint"}`} aria-hidden="true" />
              {live ? t.live : t.offline}
            </span>
          </span>
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-auto">
        {company && company.status === "suspended" && (
          <div role="alert" className="m-4 flex flex-wrap items-center gap-3 rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
            <OctagonX size={18} aria-hidden="true" />
            <span>
              {fill(t.stoppedBanner, { company: company.name })} {stopNotice}
            </span>
            <button type="button" onClick={() => void resumeAll()} className="ml-auto rounded-control bg-danger px-3 py-1 text-[13px] font-bold text-white">
              {t.resumeAll}
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="m-4 rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        {route.page === "settings" || !ws ? (
          <SettingsPage
            t={t}
            companies={companies}
            company={company}
            onCompanyChange={(id) => setCompanyId(id)}
            onCreated={loadCompanies}
            locale={locale}
            onLocale={switchLocale}
            theme={theme}
            onTheme={setTheme}
            mode={mode}
            onMode={setMode}
          />
        ) : route.page === "home" ? (
          <HomePage ws={ws} />
        ) : route.page === "inbox" ? (
          <InboxPage ws={ws} />
        ) : route.page === "team" ? (
          <TeamPage ws={ws} param={route.param} />
        ) : route.page === "work" ? (
          <WorkPage ws={ws} param={route.param} />
        ) : route.page === "chat" ? (
          <ChatPage ws={ws} param={route.param} />
        ) : route.page === "learning" ? (
          <LearningPage ws={ws} param={route.param} />
        ) : route.page === "connections" ? (
          <ConnectionsPage ws={ws} />
        ) : (
          <MoneyPage ws={ws} />
        )}
      </main>
    </div>
  );
}

/** Greeting for the Home page, by local time. */
export function greeting(t: Strings, company: string, working: number): string {
  const hour = new Date().getHours();
  const word = hour < 12 ? t.greeting.morning : hour < 18 ? t.greeting.afternoon : t.greeting.evening;
  return `${word}. ${fill(working > 0 ? t.atWork : t.quiet, { company })}`;
}
