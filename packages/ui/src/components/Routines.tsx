import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Play, Plus } from "lucide-react";
import { api, eventsSocket, type Routine, type RoutineRun } from "../api";
import { fill } from "../i18n";
import { Avatar, Button, Card, Chip, Input, Select, Textarea, timeAgo } from "../ui";
import type { Workspace } from "../App";

type Preset = "daily9" | "weekdays18" | "monday9" | "hourly" | "custom";
const PRESETS: Record<Exclude<Preset, "custom">, { scheduleKind: Routine["scheduleKind"]; schedule: string }> = {
  daily9: { scheduleKind: "cron", schedule: "0 9 * * *" },
  weekdays18: { scheduleKind: "cron", schedule: "0 18 * * 1-5" },
  monday9: { scheduleKind: "cron", schedule: "0 9 * * 1" },
  hourly: { scheduleKind: "interval", schedule: "3600" },
};

function human(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Routines of the company: a list with the next run, a form, and the last runs of one routine. */
export function RoutinesView({ ws }: { ws: Workspace }) {
  const { t, company, overview } = ws;
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const agents = (overview?.agents ?? []).filter((a) => a.status === "active");
  const load = useCallback(async () => setRoutines(await api.routines(company.id)), [company.id]);
  useEffect(() => {
    void load().catch(() => setRoutines([]));
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === company.id && e.type.startsWith("routine.") && void load(),
        () => {},
      ),
    [company.id, load],
  );
  useEffect(() => {
    if (!open) return;
    void api
      .routineRuns(company.id, open)
      .then(setRuns)
      .catch(() => setRuns([]));
    return eventsSocket(
      (e) => e.companyId === company.id && e.type.startsWith("routine.") && void api.routineRuns(company.id, open).then(setRuns),
      () => {},
    );
  }, [company.id, open, routines]);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) setNotice(message);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const scheduleOf = (r: Routine) =>
    r.scheduleKind === "interval"
      ? fill(t.scheduleText.interval, { n: human(Number(r.schedule)) })
      : r.scheduleKind === "cron"
        ? fill(t.scheduleText.cron, { expr: r.schedule, tz: r.timezone })
        : fill(t.scheduleText.once, { when: r.schedule.slice(0, 16).replace("T", " ") });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 text-[13px] text-mute">{t.routinesSub}</p>
        <Button variant="primary" size="sm" className="ml-auto" onClick={() => setCreating((v) => !v)}>
          <Plus size={15} /> {t.newRoutine}
        </Button>
      </div>
      {notice && <p className="m-0 rounded-control border border-line bg-card px-3 py-2 text-[13px]">{notice}</p>}
      {creating && (
        <RoutineForm
          ws={ws}
          onDone={async () => {
            setCreating(false);
            await load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {routines.length === 0 ? (
        <p className="text-sm text-mute">{t.noRoutines}</p>
      ) : (
        <div className="flex gap-4">
          <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-2 p-0">
            {routines.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center gap-3 rounded-[14px] border bg-card px-4 py-3 ${open === r.id ? "border-accent" : "border-line"} ${r.enabled ? "" : "opacity-60"}`}
              >
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Avatar name={ws.agentName(r.agentId)} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate font-bold">{r.name}</span>
                    <span className="block truncate text-[12px] text-mute">
                      {ws.agentName(r.agentId)} · {scheduleOf(r)} ·{" "}
                      {r.enabled ? fill(t.routineNext, { when: r.nextDueAt ? timeAgo(r.nextDueAt, t) : "—" }) : t.connDisable.toLowerCase()} ·{" "}
                      {fill(t.routineLast, { when: r.lastRunAt ? timeAgo(r.lastRunAt, t) : t.routineNever })}
                    </span>
                  </span>
                </button>
                {r.skills.length > 0 && <Chip tone="mute">{r.skills.join(", ")}</Chip>}
                <Button size="sm" onClick={() => void run(() => api.runRoutine(company.id, r.id), t.runQueued)}>
                  <Play size={13} /> {t.runNow}
                </Button>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => void run(() => api.updateRoutine(company.id, r.id, { enabled: e.target.checked }))} />{" "}
                  {r.enabled ? t.connEnable : t.connDisable}
                </label>
                <button type="button" onClick={() => void run(() => api.removeRoutine(company.id, r.id))} className="text-[12px] text-danger">
                  {t.connRemove}
                </button>
              </li>
            ))}
          </ul>
          {open && (
            <aside className="w-[380px] shrink-0 rounded-card border border-line bg-panel p-4">
              <h3 className="m-0 mb-2 text-[12px] font-bold uppercase tracking-wide text-mute">{t.runs}</h3>
              <p className="m-0 mb-3 whitespace-pre-wrap text-[13px] text-mute">{routines.find((r) => r.id === open)?.prompt}</p>
              {runs.length === 0 ? (
                <p className="m-0 text-[13px] text-mute">—</p>
              ) : (
                <ul className="m-0 list-none space-y-2 p-0 text-[13px]">
                  {runs.map((x) => (
                    <li key={x.id} className="rounded-control border border-line bg-card px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Chip
                          tone={x.status === "done" ? "ok" : x.status === "failed" || x.status === "interrupted" ? "danger" : x.status === "skipped" ? "mute" : "info"}
                          dot
                          pulse={x.status === "running"}
                        >
                          {t.runStatus[x.status]}
                        </Chip>
                        <span className="text-[12px] text-mute">{x.dueAt.slice(0, 16).replace("T", " ")}</span>
                        {x.sessionId && (
                          <a href={`#/chat/${x.sessionId}`} className="ml-auto text-[12px] font-bold text-accent-text no-underline">
                            {t.nav.chat} →
                          </a>
                        )}
                      </div>
                      {(x.result || x.error) && <p className="m-0 mt-1 line-clamp-4 whitespace-pre-wrap text-[12px]">{x.result ?? x.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function RoutineForm({ ws, onDone, onCancel }: { ws: Workspace; onDone: () => Promise<void>; onCancel: () => void }) {
  const { t, company, overview } = ws;
  const agents = (overview?.agents ?? []).filter((a) => a.status === "active");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(agents[0]?.id ?? "");
  const [preset, setPreset] = useState<Preset>("monday9");
  const [custom, setCustom] = useState("");
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState("");
  const [deliver, setDeliver] = useState(true);
  const [learn, setLearn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const text = custom.trim().toLowerCase();
      const schedule =
        preset !== "custom"
          ? PRESETS[preset]
          : /^every\s|^\d+$/.test(text)
            ? { scheduleKind: "interval" as const, schedule: text }
            : /\d{4}-\d{2}-\d{2}/.test(text)
              ? { scheduleKind: "once" as const, schedule: new Date(custom).toISOString() }
              : { scheduleKind: "cron" as const, schedule: custom.trim() };
      await api.createRoutine(company.id, {
        name: name.trim(),
        agentId: agent,
        prompt: prompt.trim(),
        ...schedule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        skills: skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        deliverTo: deliver ? ["channels"] : [],
        learn,
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-64">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.routineName} aria-label={t.routineName} required autoFocus />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-mute">
            {t.routineAgent}
            <div className="w-40">
              <Select value={agent} onChange={(e) => setAgent(e.target.value)} required>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-mute">
            {t.routineWhen}
            <div className="w-56">
              <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                {(Object.keys(t.routinePresets) as Preset[]).map((p) => (
                  <option key={p} value={p}>
                    {t.routinePresets[p]}
                  </option>
                ))}
              </Select>
            </div>
          </label>
          {preset === "custom" && (
            <div className="w-64">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t.routineCustom} aria-label={t.routineCustom} required />
            </div>
          )}
        </div>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t.routinePrompt} aria-label={t.routinePrompt} required className="min-h-28" />
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-72">
            <Input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder={t.routineSkills} aria-label={t.routineSkills} />
          </div>
          <label className="flex items-center gap-1.5 text-[13px] text-mute">
            <input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} /> {t.routineDeliver}
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-mute">
            <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} /> {t.routineLearn}
          </label>
        </div>
        {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!name.trim() || !agent || !prompt.trim() || (preset === "custom" && !custom.trim())}>
            {t.saveMemory}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}
