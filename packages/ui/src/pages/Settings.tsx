import { useEffect, useState, type FormEvent } from "react";
import { api, type Company, type Health, type ModelsInfo } from "../api";
import type { Locale, Strings } from "../i18n";
import type { Theme, ViewMode } from "../prefs";
import { Button, Card, CardHeader, Chip, Input, Segmented } from "../ui";

export interface SettingsProps {
  t: Strings;
  companies: Company[];
  company: Company | null;
  onCompanyChange: (id: string) => void;
  onCreated: () => Promise<void>;
  locale: Locale;
  onLocale: (l: Locale) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
}

/** Companies, appearance, and the system's health. Also the first screen when no company exists. */
export function SettingsPage(p: SettingsProps) {
  const { t } = p;
  const [health, setHealth] = useState<Health | null | "error">(null);
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth("error"));
    api
      .models()
      .then(setModels)
      .catch(() => setModels(null));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.createCompany(name.trim(), mission.trim() || undefined);
      setName("");
      setMission("");
      await p.onCreated();
      p.onCompanyChange(created.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header>
        <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{p.companies.length === 0 ? t.createFirstCompany : t.settingsTitle}</h1>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t.companies} />
          <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2">
            {p.companies.length === 0 && <p className="m-0 text-sm text-mute">{t.noCompanies}</p>}
            {p.companies.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => p.onCompanyChange(c.id)}
                aria-pressed={p.company?.id === c.id}
                className={`rounded-control px-3 py-2 text-left text-sm ${p.company?.id === c.id ? "bg-accent-soft text-ink" : "hover:bg-hover"}`}
              >
                <span className="font-bold">{c.name}</span>
                {c.mission && <span className="block truncate text-[13px] text-mute">{c.mission}</span>}
              </button>
            ))}
            <form onSubmit={create} className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
              <h3 className="m-0 text-xs font-bold uppercase tracking-wide text-mute">{t.newCompany}</h3>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.companyName} aria-label={t.companyName} required />
              <Input value={mission} onChange={(e) => setMission(e.target.value)} placeholder={t.mission} aria-label={t.mission} />
              <Button type="submit" variant="primary" disabled={busy} className="self-start">
                {t.create}
              </Button>
            </form>
          </div>
        </Card>

        <Card>
          <CardHeader title={t.appearance} />
          <div className="flex flex-col gap-4 px-[18px] pb-[18px] pt-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-mute">{t.viewMode}</span>
              <Segmented
                value={p.mode}
                onChange={p.onMode}
                label={t.viewMode}
                options={[
                  { value: "simple", label: t.simple },
                  { value: "advanced", label: t.advanced },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-mute">{t.theme}</span>
              <Segmented
                value={p.theme}
                onChange={p.onTheme}
                label={t.theme}
                options={[
                  { value: "dark", label: t.dark },
                  { value: "light", label: t.light },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-mute">{t.language}</span>
              <Segmented
                value={p.locale}
                onChange={p.onLocale}
                label={t.language}
                options={[
                  { value: "en", label: "English" },
                  { value: "it", label: "Italiano" },
                ]}
              />
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader title={t.status} />
          <dl className="grid grid-cols-2 gap-y-1.5 px-[18px] pb-[18px] pt-2 text-sm">
            <dt className="text-mute">{t.server}</dt>
            <dd className="m-0">{health === null ? "…" : health === "error" ? <Chip tone="danger">{t.unreachable}</Chip> : <Chip tone="ok">{t.ok}</Chip>}</dd>
            <dt className="text-mute">{t.database}</dt>
            <dd className="m-0">
              {typeof health === "object" && health ? <Chip tone={health.database === "ok" ? "ok" : "danger"}>{health.database === "ok" ? t.ok : t.degraded}</Chip> : "—"}
            </dd>
            <dt className="text-mute">{t.version}</dt>
            <dd className="m-0 font-mono text-[13px]">{typeof health === "object" && health ? health.version : "—"}</dd>
            <dt className="text-mute">{t.mode}</dt>
            <dd className="m-0">{typeof health === "object" && health ? (t.modes[health.mode] ?? health.mode) : "—"}</dd>
          </dl>
        </Card>

        <Card>
          <CardHeader title={t.providers} />
          <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-sm">
            {models ? (
              <>
                <div>
                  <span className="text-mute">{t.defaultModel}:</span> <strong className="font-mono text-[13px]">{models.default}</strong>
                </div>
                {models.providers.map((pr) => (
                  <div key={pr.id} className="flex items-center gap-2">
                    <Chip tone={pr.enabled ? "ok" : "mute"} dot>
                      {pr.id}
                    </Chip>
                    <span className="truncate text-[13px] text-mute">{pr.detail}</span>
                  </div>
                ))}
              </>
            ) : (
              <p className="m-0 text-mute">—</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
