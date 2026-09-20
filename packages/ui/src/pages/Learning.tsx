import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pin, PinOff, Plus, Share2, X } from "lucide-react";
import { api, eventsSocket, type LearningReview, type LearningSettings, type Memory, type Scope, type Skill, type SkillDetail } from "../api";
import { fill } from "../i18n";
import { Avatar, Button, Card, Chip, Input, Segmented, Select, Textarea, timeAgo } from "../ui";
import type { Workspace } from "../App";

type Tab = "memory" | "skills" | "reviews" | "settings";

/** The Learning page: memory, skills, what each job taught, and the rules. `#/learning/<agentId>` opens the memory as that agent sees it. */
export function LearningPage({ ws, param }: { ws: Workspace; param: string | null }) {
  const { t, company, overview } = ws;
  const [tab, setTab] = useState<Tab>("memory");
  const agents = (overview?.agents ?? []).filter((a) => a.status !== "archived");
  const [agent, setAgent] = useState<string>(param ?? agents[0]?.id ?? "");
  useEffect(() => {
    if (param) setAgent(param);
    else if (!agent && agents[0]) setAgent(agents[0].id);
  }, [param, agents, agent]);

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{t.learningTitle}</h1>
          <p className="mt-1.5 text-[15px] text-mute">{t.learningSub}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {(tab === "memory" || tab === "skills") && (
            <label className="flex items-center gap-2 text-[13px] text-mute">
              {t.viewAs}
              <div className="w-44">
                <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
                  <option value="">{t.wholeCompany}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </label>
          )}
          <Segmented
            value={tab}
            onChange={setTab}
            label={t.learningTitle}
            options={(["memory", "skills", "reviews", "settings"] as Tab[]).map((v) => ({ value: v, label: t.learningTabs[v] }))}
          />
        </div>
      </header>
      {tab === "memory" && <MemoryTab ws={ws} agent={agent} companyId={company.id} />}
      {tab === "skills" && <SkillsTab ws={ws} agent={agent} companyId={company.id} />}
      {tab === "reviews" && <ReviewsTab ws={ws} companyId={company.id} />}
      {tab === "settings" && <SettingsTab ws={ws} companyId={company.id} />}
    </div>
  );
}

// --- Memory ---------------------------------------------------------------------

function MemoryTab({ ws, agent, companyId }: { ws: Workspace; agent: string; companyId: string }) {
  const { t } = ws;
  const [list, setList] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [retired, setRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    mode: "correct" | "retire";
    text: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const status = retired ? "active,retired,superseded" : "active";
    const q = query.trim();
    if (q && agent) setList(await api.memories(companyId, { agent, q, status, limit: 40 }));
    else if (agent) setList(await api.memories(companyId, { agent, status }));
    else setList(await api.memories(companyId, { scope: "company", status }));
  }, [companyId, agent, query, retired]);

  useEffect(() => {
    const timer = setTimeout(() => void load().catch(() => setList([])), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && (e.type === "memory.saved" || e.type === "learning.reviewed") && void load(),
        () => {},
      ),
    [companyId, load],
  );

  const act = async (m: Memory, action: "pin" | "promote" | "correct" | "retire", body: Record<string, unknown>) => {
    try {
      const result = await api.memoryAction(companyId, m.id, action, body);
      if (action === "promote") setNotice((result as { status: string }).status === "applied" ? t.shared : t.proposedShare);
      setEditing(null);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-80">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchMemory} aria-label={t.searchMemory} disabled={!agent} />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-mute">
          <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> {t.showRetired}
        </label>
        <Button variant="primary" size="sm" className="ml-auto" onClick={() => setAdding((v) => !v)}>
          <Plus size={15} /> {t.addMemory}
        </Button>
      </div>
      {notice && (
        <p className="m-0 flex items-center gap-2 rounded-control border border-line bg-card px-3 py-2 text-[13px]">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="ml-auto text-mute" aria-label={t.cancel}>
            <X size={14} />
          </button>
        </p>
      )}
      {adding && (
        <MemoryForm
          ws={ws}
          agent={agent}
          onDone={async () => {
            setAdding(false);
            await load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {list.length === 0 ? (
        <p className="text-sm text-mute">{t.noMemories}</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 xl:grid-cols-2">
          {list.map((m) => (
            <li key={m.id} className={`flex flex-col gap-2 rounded-[14px] border border-line bg-card p-4 ${m.status !== "active" ? "opacity-60" : ""}`}>
              <div className="flex items-start gap-3">
                <Avatar name={m.scope === "company" ? ws.company.name : ws.agentName(m.scopeAgentId)} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[14px] leading-snug">
                    {m.kind === "profile" && m.subject && <strong>{m.subject}: </strong>}
                    {m.content}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-mute">
                    <Chip tone={m.scope === "company" ? "info" : "mute"}>{t.scopeLabel[m.scope]}</Chip>
                    {m.pinned && <Chip tone="warn">{t.pinned}</Chip>}
                    {m.status !== "active" && <Chip tone="mute">{m.status}</Chip>}
                    <span>
                      {m.authorKind === "agent" ? ws.agentName(m.authorId) : m.authorKind === "person" ? t.you : t.system} · {timeAgo(m.createdAt, t)}
                    </span>
                    {m.sourceTaskId && (
                      <a href={`#/work/${m.sourceTaskId}`} className="font-bold text-accent-text no-underline">
                        {t.learnedFrom} →
                      </a>
                    )}
                    {m.retiredReason && <span>· {m.retiredReason}</span>}
                  </div>
                </div>
                {m.status === "active" && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={m.pinned ? t.unpin : t.pin}
                      aria-label={m.pinned ? t.unpin : t.pin}
                      onClick={() => void act(m, "pin", { pinned: !m.pinned })}
                      className="rounded-md p-1.5 text-mute hover:bg-hover hover:text-ink"
                    >
                      {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                    </button>
                    {m.scope !== "company" && (
                      <button
                        type="button"
                        title={t.share}
                        aria-label={t.share}
                        onClick={() => void act(m, "promote", { toScope: "company" })}
                        className="rounded-md p-1.5 text-mute hover:bg-hover hover:text-ink"
                      >
                        <Share2 size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              {m.status === "active" && editing?.id !== m.id && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing({ id: m.id, mode: "correct", text: m.content })}>
                    {t.correct}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ id: m.id, mode: "retire", text: "" })}>
                    {t.retire}
                  </Button>
                </div>
              )}
              {editing?.id === m.id && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void act(m, editing.mode, editing.mode === "correct" ? { content: editing.text } : { reason: editing.text });
                  }}
                >
                  <Textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    placeholder={editing.mode === "correct" ? t.correctHint : t.retireHint}
                    aria-label={editing.mode === "correct" ? t.correctHint : t.retireHint}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" size="sm" disabled={!editing.text.trim()}>
                      {editing.mode === "correct" ? t.correct : t.retire}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {t.cancel}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryForm({ ws, agent, onDone, onCancel }: { ws: Workspace; agent: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const { t, company, overview } = ws;
  const [content, setContent] = useState("");
  const [subject, setSubject] = useState("");
  const [owner, setOwner] = useState(agent);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.saveMemory(company.id, {
        scope: owner ? "agent" : "company",
        scopeAgentId: owner || null,
        kind: subject.trim() ? "profile" : "note",
        subject: subject.trim(),
        content: content.trim(),
      });
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={t.memoryText} aria-label={t.memoryText} autoFocus />
        <div className="flex flex-wrap gap-3">
          <div className="w-64">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t.memorySubject} aria-label={t.memorySubject} />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-mute">
            {t.memoryFor}
            <div className="w-44">
              <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">{t.wholeCompany}</option>
                {(overview?.agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </label>
          <div className="ml-auto flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !content.trim()}>
              {t.saveMemory}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t.cancel}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

// --- Skills ---------------------------------------------------------------------

function SkillsTab({ ws, agent, companyId }: { ws: Workspace; agent: string; companyId: string }) {
  const { t } = ws;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    setSkills(agent ? await api.skills(companyId, { agent }) : await api.skills(companyId, { scope: "company" }));
  }, [companyId, agent]);
  useEffect(() => {
    void load().catch(() => setSkills([]));
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && (e.type === "skill.created" || e.type === "learning.reviewed" || e.type === "promotion.decided") && void load(),
        () => {},
      ),
    [companyId, load],
  );

  const scopeOf = (s: Skill) =>
    s.scope === "company" ? t.scopeLabel.company : s.scope === "team" ? `${t.scopeLabel.team} · ${ws.agentName(s.scopeAgentId)}` : ws.agentName(s.scopeAgentId);

  return (
    <div className="flex gap-5">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center">
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setCreating((v) => !v)}>
            <Plus size={15} /> {t.newSkill}
          </Button>
        </div>
        {creating && (
          <SkillForm
            ws={ws}
            agent={agent}
            onDone={async () => {
              setCreating(false);
              await load();
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        {skills.length === 0 ? (
          <p className="text-sm text-mute">{t.noSkills}</p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 xl:grid-cols-2">
            {skills.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setOpen(s.id)}
                  className={`flex w-full flex-col gap-2 rounded-[14px] border bg-card p-4 text-left transition hover:border-accent ${open === s.id ? "border-accent" : "border-line"} ${s.status === "archived" ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[14px] font-bold text-accent-text">{s.name}</span>
                    <span className="ml-auto text-[12px] text-mute">v{s.currentVersion}</span>
                  </div>
                  <p className="m-0 text-[13px]">{s.description}</p>
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-mute">
                    <Chip tone={s.scope === "company" ? "info" : "mute"}>{scopeOf(s)}</Chip>
                    <Chip tone="mute">{t.skillOrigin[s.origin]}</Chip>
                    {s.status !== "active" && <Chip tone={s.status === "archived" ? "mute" : "warn"}>{t.skillStatus[s.status]}</Chip>}
                    {s.pinned && <Chip tone="warn">{t.pinned}</Chip>}
                    <span>{fill(t.uses, { n: s.uses })}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && <SkillDrawer ws={ws} companyId={companyId} skillId={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function SkillForm({ ws, agent, onDone, onCancel }: { ws: Workspace; agent: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const { t, company } = ws;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createSkill(company.id, {
        scope: agent ? "agent" : "company",
        scopeAgentId: agent || null,
        name: name.trim(),
        description: description.trim(),
        content,
        pinned: true,
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Card className="mb-3 p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-56">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t.skillName}
              aria-label={t.skillName}
              pattern="[a-z0-9][a-z0-9-]*"
              required
              autoFocus
            />
          </div>
          <div className="min-w-64 flex-1">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.skillDescription} aria-label={t.skillDescription} required />
          </div>
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t.skillContent}
          aria-label={t.skillContent}
          className="min-h-40 font-mono text-[13px]"
          required
        />
        {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!name.trim() || !description.trim() || !content.trim()}>
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

function SkillDrawer({ ws, companyId, skillId, onClose, onChanged }: { ws: Workspace; companyId: string; skillId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const { t } = ws;
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [editing, setEditing] = useState<{
    content: string;
    note: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    version: number;
    content: string;
  } | null>(null);
  const load = useCallback(async () => setDetail(await api.skill(companyId, skillId)), [companyId, skillId]);
  useEffect(() => {
    setEditing(null);
    setViewing(null);
    void load().catch(() => setDetail(null));
  }, [load]);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      const r = await fn();
      if (message) setNotice(message);
      else if (r && typeof r === "object" && "status" in r) setNotice((r as { status: string }).status === "applied" ? t.shared : t.proposedShare);
      await load();
      await onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  if (!detail) return null;
  const s = detail;
  const shown = viewing ?? (s.version ? { version: s.version.version, content: s.version.content } : null);
  return (
    <aside className="flex w-[520px] shrink-0 flex-col rounded-card border border-line bg-panel shadow-card" aria-label={s.name}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="m-0 font-mono text-[18px] font-bold text-accent-text">{s.name}</h2>
            <span className="text-[12px] text-mute">v{s.currentVersion}</span>
            {s.pinned && <Chip tone="warn">{t.pinned}</Chip>}
            {s.status !== "active" && <Chip tone="mute">{t.skillStatus[s.status]}</Chip>}
          </div>
          <p className="m-0 mt-1 text-[13px] text-mute">{s.description}</p>
          <p className="m-0 mt-1 text-[12px] text-mute">
            {t.skillOrigin[s.origin]} · {fill(t.uses, { n: s.uses })} · {fill(t.worked, { ok: s.usage.successes, ko: s.usage.failures })}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label={t.cancel} className="rounded-md p-1.5 text-mute hover:bg-hover hover:text-ink">
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 space-y-4 overflow-auto px-5 py-4 text-sm">
        {notice && <p className="m-0 rounded-control border border-line bg-card px-3 py-2 text-[13px]">{notice}</p>}
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(
                () =>
                  api.updateSkill(companyId, s.id, {
                    content: editing.content,
                    note: editing.note,
                  }),
                undefined,
              ).then(() => setEditing(null));
            }}
          >
            <Textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              className="min-h-72 font-mono text-[13px]"
              aria-label={t.skillContent}
            />
            <Input value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} placeholder={t.noteForVersion} aria-label={t.noteForVersion} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={!editing.content.trim()}>
                {t.improve}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t.cancel}
              </Button>
            </div>
          </form>
        ) : (
          shown && (
            <div>
              {viewing && (
                <p className="m-0 mb-2 text-[12px] text-mute">
                  v{viewing.version} ·{" "}
                  <button type="button" onClick={() => setViewing(null)} className="font-bold text-accent-text">
                    v{s.currentVersion}
                  </button>
                </p>
              )}
              <pre className="m-0 whitespace-pre-wrap rounded-[10px] border border-line bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">{shown.content}</pre>
            </div>
          )
        )}
        <section>
          <h3 className="m-0 mb-1.5 text-[12px] font-bold uppercase tracking-wide text-mute">{t.versions}</h3>
          <ul className="m-0 list-none space-y-1 p-0 text-[13px]">
            {s.versions.map((v) => (
              <li key={v.version} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void api.skillVersion(companyId, s.id, v.version).then((x) => setViewing({ version: x.version, content: x.content }))}
                  className={`font-mono font-bold ${v.version === s.currentVersion ? "text-accent-text" : "text-ink"}`}
                >
                  v{v.version}
                </button>
                <span className="min-w-0 flex-1 truncate text-mute">
                  {v.note || "—"} · {v.createdByKind === "agent" ? ws.agentName(s.scopeAgentId) : v.createdByKind === "person" ? t.you : t.system} · {timeAgo(v.createdAt, t)}
                </span>
                {v.version !== s.currentVersion && (
                  <button type="button" onClick={() => void run(() => api.restoreSkill(companyId, s.id, v.version), t.restored)} className="text-[12px] font-bold text-accent-text">
                    {t.restoreSkill}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {s.status === "archived" && <p className="m-0 text-[12px] text-mute">{t.archivedHint}</p>}
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
        {!editing && s.status !== "archived" && (
          <Button size="sm" onClick={() => setEditing({ content: s.version?.content ?? "", note: "" })}>
            {t.improve}
          </Button>
        )}
        <Button size="sm" onClick={() => void run(() => api.pinSkill(companyId, s.id, !s.pinned), s.pinned ? t.unpin : t.pin)}>
          {s.pinned ? <PinOff size={14} /> : <Pin size={14} />} {s.pinned ? t.unpin : t.pin}
        </Button>
        {s.scope !== "company" && s.status !== "archived" && (
          <Button size="sm" onClick={() => void run(() => api.promoteSkill(companyId, s.id))}>
            <Share2 size={14} /> {t.share}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void run(() => api.skillStatus(companyId, s.id, s.status === "archived" ? "active" : "archived"), s.status === "archived" ? t.unarchive : t.archiveSkill)}
        >
          {s.status === "archived" ? t.unarchive : t.archiveSkill}
        </Button>
      </footer>
    </aside>
  );
}

// --- Reviews --------------------------------------------------------------------

function ReviewsTab({ ws, companyId }: { ws: Workspace; companyId: string }) {
  const { t } = ws;
  const [reviews, setReviews] = useState<LearningReview[]>([]);
  const load = useCallback(async () => setReviews(await api.learningReviews(companyId)), [companyId]);
  useEffect(() => {
    void load().catch(() => setReviews([]));
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && e.type === "learning.reviewed" && void load(),
        () => {},
      ),
    [companyId, load],
  );
  if (reviews.length === 0) return <p className="text-sm text-mute">{t.reviewsEmpty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {reviews.map((r) => {
        const kept =
          r.status === "done"
            ? (r.applied.memoryIds?.length ?? 0) > 0 || r.applied.skill
              ? fill(t.reviewKept, {
                  memories: r.applied.memoryIds?.length ?? 0,
                  skill: r.applied.skill ? fill(t.reviewSkill, { name: r.applied.skill.name }) : "",
                })
              : t.reviewNothing
            : (r.error ?? "");
        return (
          <li key={r.id} className="flex items-center gap-3 rounded-[14px] border border-line bg-card px-4 py-3">
            <Avatar name={ws.agentName(r.agentId)} size={30} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px]">
                <strong>{ws.agentName(r.agentId)}</strong> · {kept}
                {r.proposals.reason && r.status === "done" ? <span className="text-mute"> — {r.proposals.reason}</span> : null}
              </div>
              <div className="text-[12px] text-mute">
                {timeAgo(r.createdAt, t)}
                {r.taskId && (
                  <>
                    {" · "}
                    <a href={`#/work/${r.taskId}`} className="font-bold text-accent-text no-underline">
                      {t.nav.work} →
                    </a>
                  </>
                )}
                {!r.taskId && (
                  <>
                    {" · "}
                    <a href={`#/chat/${r.sessionId}`} className="font-bold text-accent-text no-underline">
                      {t.nav.chat} →
                    </a>
                  </>
                )}
              </div>
            </div>
            <Chip tone={r.status === "done" ? "ok" : r.status === "failed" ? "danger" : "mute"}>{t.reviewStatus[r.status]}</Chip>
          </li>
        );
      })}
    </ul>
  );
}

// --- Settings -------------------------------------------------------------------

function SettingsTab({ ws, companyId }: { ws: Workspace; companyId: string }) {
  const { t } = ws;
  const [s, setS] = useState<LearningSettings | null>(null);
  useEffect(() => {
    void api
      .learningSettings(companyId)
      .then(setS)
      .catch(() => setS(null));
  }, [companyId]);
  if (!s) return null;
  const patch = async (p: Partial<Omit<LearningSettings, "semanticSearch">>) => setS(await api.updateLearningSettings(companyId, p));
  return (
    <Card className="max-w-2xl p-5">
      <div className="flex flex-col gap-4 text-sm">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={s.reviewEnabled} onChange={(e) => void patch({ reviewEnabled: e.target.checked })} />
          {t.ruleReview}
        </label>
        <label className="flex flex-wrap items-center gap-3">
          {t.rulePromotion}
          <div className="w-52">
            <Select
              value={s.promotion}
              onChange={(e) =>
                void patch({
                  promotion: e.target.value as LearningSettings["promotion"],
                })
              }
            >
              {(["automatic", "review", "forbidden"] as const).map((v) => (
                <option key={v} value={v}>
                  {t.promotionPolicy[v]}
                </option>
              ))}
            </Select>
          </div>
        </label>
        <label className="flex items-center gap-3">
          <div className="w-20">
            <Input
              type="number"
              min={1}
              max={100}
              value={s.promotionThreshold}
              onChange={(e) => void patch({ promotionThreshold: Number(e.target.value) || 1 })}
              aria-label={t.ruleThreshold}
            />
          </div>
          {fill(t.ruleThreshold, { n: s.promotionThreshold })}
        </label>
        <label className="flex items-center gap-3">
          <div className="w-28">
            <Input
              type="number"
              min={500}
              max={60000}
              step={500}
              value={s.snapshotMaxChars}
              onChange={(e) => void patch({ snapshotMaxChars: Number(e.target.value) || 6000 })}
              aria-label={t.ruleSnapshot}
            />
          </div>
          {fill(t.ruleSnapshot, { n: s.snapshotMaxChars })}
        </label>
        <p className="m-0 text-mute">
          {fill(t.ruleCurator, {
            inactive: s.inactiveAfterDays,
            archive: s.archiveAfterDays,
          })}
        </p>
        <p className="m-0 text-mute">{s.semanticSearch ? t.semanticOn : t.semanticOff}</p>
      </div>
    </Card>
  );
}

export type { Scope };
