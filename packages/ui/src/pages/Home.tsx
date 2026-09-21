import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";
import { api, eventsSocket, type CostReport, type LearningReview, type ModelsInfo } from "../api";
import { fill, plural } from "../i18n";
import { DEFAULT_LAYOUT, usePref, type WidgetPlacement, type WidgetSize } from "../prefs";
import { ActivityChip, Avatar, Button, Card, CardHeader, Chip, EmptyState, money, timeAgo } from "../ui";
import { ApprovalCard } from "../components/ApprovalCard";
import { ReviewCard } from "../components/TaskBits";
import { greeting, type Workspace } from "../App";

type WidgetId = "needsYou" | "spend" | "team" | "done" | "activity" | "models" | "costByAgent" | "learned";

const ALL_WIDGETS: WidgetId[] = ["needsYou", "spend", "team", "done", "learned", "activity", "costByAgent", "models"];

const span: Record<WidgetSize, string> = {
  s: "xl:col-span-4",
  m: "xl:col-span-6",
  l: "xl:col-span-8",
};

export function HomePage({ ws }: { ws: Workspace }) {
  const { t, company, overview, pending } = ws;
  const [layout, setLayout] = usePref<WidgetPlacement[]>(`layout.${company.id}`, DEFAULT_LAYOUT);
  const [picker, setPicker] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLayout((current) => {
      const from = current.findIndex((w) => w.id === active.id);
      const to = current.findIndex((w) => w.id === over.id);
      return arrayMove(current, from, to);
    });
  };
  const resize = (id: string, size: WidgetSize) => setLayout((current) => current.map((w) => (w.id === id ? { ...w, size } : w)));
  const remove = (id: string) => setLayout((current) => current.filter((w) => w.id !== id));
  const add = (id: WidgetId) => {
    setLayout((current) => (current.some((w) => w.id === id) ? current : [...current, { id, size: id === "needsYou" || id === "done" ? "l" : "m" }]));
    setPicker(false);
  };
  const missing = ALL_WIDGETS.filter((id) => !layout.some((w) => w.id === id));
  const firstAgent = overview?.agents.find((a) => a.status === "active") ?? overview?.agents[0];

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{greeting(t, company.name, overview?.working ?? 0)}</h1>
          <p className="mt-1.5 text-[15px] text-mute">
            {overview
              ? fill(t.summary, {
                  agents: plural(t.summaryAgents, overview.agents.length, ws.locale),
                  working: plural(t.summaryWorking, overview.working, ws.locale),
                  pending: plural(t.summaryPending, overview.pending + ws.attention.length, ws.locale),
                })
              : "…"}
          </p>
        </div>
        <div className="flex gap-2">
          {firstAgent && (
            <Button variant="ghost" onClick={() => ws.go("chat", `new-${firstAgent.id}`)}>
              {fill(t.talkTo, { agent: firstAgent.name })}
            </Button>
          )}
          <Button variant="primary" onClick={() => ws.go("work", "new")}>
            {t.giveTask}
          </Button>
        </div>
      </header>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={layout.map((w) => w.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            {layout.map((w) => (
              <SortableWidget key={w.id} placement={w} title={t.widgets[w.id as WidgetId] ?? w.id} t={t} onResize={(size) => resize(w.id, size)} onRemove={() => remove(w.id)}>
                <WidgetBody id={w.id as WidgetId} ws={ws} />
              </SortableWidget>
            ))}
            {missing.length > 0 && (
              <div className="xl:col-span-12">
                {picker ? (
                  <Card className="p-4">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {missing.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => add(id)}
                          className="flex flex-col gap-1 rounded-[14px] border border-line bg-raised p-3 text-left hover:border-accent hover:bg-hover"
                        >
                          <span className="font-bold">{t.widgets[id]}</span>
                          <span className="text-[13px] text-mute">{t.widgetBlurbs[id]}</span>
                        </button>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" className="mt-3" onClick={() => setPicker(false)}>
                      <X size={14} /> {t.remove}
                    </Button>
                  </Card>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPicker(true)}
                    className="flex h-16 w-full items-center justify-center gap-2 rounded-card border-2 border-dashed border-line-strong text-sm font-bold text-mute hover:border-accent hover:text-ink"
                  >
                    <Plus size={16} /> {t.addWidget}
                  </button>
                )}
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
      {!overview && pending.length === 0 && null}
    </div>
  );
}

function SortableWidget({
  placement,
  title,
  t,
  onResize,
  onRemove,
  children,
}: {
  placement: WidgetPlacement;
  title: string;
  t: Workspace["t"];
  onResize: (s: WidgetSize) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: placement.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={`${span[placement.size]} ${isDragging ? "z-10 opacity-90 shadow-lift" : ""}`}>
      <Card className="flex h-full flex-col">
        <CardHeader
          title={title}
          aside={
            <>
              <div role="group" aria-label={t.widgetSize} className="flex gap-0.5 rounded-md bg-raised p-0.5">
                {(["s", "m", "l"] as WidgetSize[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={placement.size === s}
                    aria-label={t.sizes[s]}
                    onClick={() => onResize(s)}
                    className={`h-6 w-6 rounded text-[11px] font-bold uppercase ${placement.size === s ? "bg-hover text-ink" : "text-faint hover:text-ink"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <button type="button" aria-label={t.removeWidget} onClick={onRemove} className="rounded p-1 text-faint hover:bg-hover hover:text-ink">
                <X size={14} />
              </button>
              <button
                ref={setActivatorNodeRef}
                type="button"
                aria-label={t.dragToReorder}
                className="cursor-grab rounded p-1 text-faint hover:bg-hover hover:text-ink active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <GripVertical size={16} />
              </button>
            </>
          }
        />
        <div className="flex-1">{children}</div>
      </Card>
    </div>
  );
}

function WidgetBody({ id, ws }: { id: WidgetId; ws: Workspace }) {
  switch (id) {
    case "needsYou":
      return <NeedsYou ws={ws} />;
    case "spend":
      return <Spend ws={ws} />;
    case "team":
      return <Team ws={ws} />;
    case "done":
      return <Done ws={ws} />;
    case "activity":
      return <Activity ws={ws} />;
    case "models":
      return <Models ws={ws} />;
    case "costByAgent":
      return <CostByAgent ws={ws} />;
    case "learned":
      return <Learned ws={ws} />;
  }
}

/** What the background reviews kept lately: memories and skills, per agent. */
function Learned({ ws }: { ws: Workspace }) {
  const { t, company } = ws;
  const [reviews, setReviews] = useState<LearningReview[]>([]);
  const load = useCallback(
    () =>
      api
        .learningReviews(company.id)
        .then((r) => setReviews(r.filter((x) => x.status === "done" && ((x.applied.memoryIds?.length ?? 0) > 0 || x.applied.skill)).slice(0, 6)))
        .catch(() => setReviews([])),
    [company.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === company.id && e.type === "learning.reviewed" && void load(),
        () => {},
      ),
    [company.id, load],
  );
  if (reviews.length === 0) return <EmptyState>{t.reviewsEmpty}</EmptyState>;
  return (
    <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-sm">
      {reviews.map((r) => (
        <a key={r.id} href="#/learning" className="flex gap-2.5 rounded-control px-1 py-1 text-ink no-underline hover:bg-hover">
          <Avatar name={ws.agentName(r.agentId)} size={26} />
          <span className="min-w-0">
            <strong>{ws.agentName(r.agentId)}</strong> ·{" "}
            {fill(t.reviewKept, {
              memories: r.applied.memoryIds?.length ?? 0,
              skill: r.applied.skill ? fill(t.reviewSkill, { name: r.applied.skill.name }) : "",
            })}
            {r.proposals.reason && <span className="block truncate text-[13px] text-mute">{r.proposals.reason}</span>}
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-faint">{timeAgo(r.createdAt, t)}</span>
        </a>
      ))}
    </div>
  );
}

function NeedsYou({ ws }: { ws: Workspace }) {
  const { t, pending, attention } = ws;
  const total = pending.length + attention.length;
  if (total === 0) return <EmptyState>{t.nothingToDecide}</EmptyState>;
  return (
    <div className="flex flex-col gap-3 px-[18px] pb-[18px] pt-3">
      {pending.slice(0, 2).map((a) => (
        <ApprovalCard key={a.id} approval={a} agentName={ws.agentName} companyId={ws.company.id} t={t} onDecided={ws.refresh} compact />
      ))}
      {attention.slice(0, 3 - Math.min(2, pending.length)).map((task) => (
        <ReviewCard key={task.id} task={task} ws={ws} compact />
      ))}
      {total > 3 && (
        <a href="#/inbox" className="text-[13px] font-bold text-accent-text no-underline">
          {fill(t.waitingCount, { n: total })} →
        </a>
      )}
    </div>
  );
}

function Spend({ ws }: { ws: Workspace }) {
  const { t, overview } = ws;
  if (!overview) return <EmptyState>…</EmptyState>;
  const { eur, cap, currency } = overview.spend;
  const ratio = cap ? Math.min(1, eur / cap) : 0;
  const dash = Math.round(ratio * 301);
  const tone = ratio >= 1 ? "var(--o-danger)" : ratio >= 0.8 ? "var(--o-warn)" : "var(--o-accent)";
  return (
    <div className="flex items-center gap-5 px-[18px] pb-[18px] pt-2">
      <svg viewBox="0 0 120 120" width="112" height="112" role="img" aria-label={`${money(eur, currency)} ${cap ? fill(t.ofCap, { cap: money(cap, currency, 0) }) : t.noCap}`}>
        <circle cx="60" cy="60" r="48" fill="none" stroke="var(--o-raised)" strokeWidth="14" />
        {cap ? (
          <circle cx="60" cy="60" r="48" fill="none" stroke={tone} strokeWidth="14" strokeDasharray={`${dash} 301`} strokeLinecap="round" transform="rotate(-90 60 60)" />
        ) : null}
        <text x="60" y="66" textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--o-ink)" fontFamily="inherit">
          {cap ? `${Math.round(ratio * 100)}%` : "—"}
        </text>
      </svg>
      <div>
        <div className="font-display text-[34px] font-bold leading-none">{money(eur, currency)}</div>
        <div className="mt-1.5 text-[13px] text-mute">{cap ? fill(t.ofCap, { cap: money(cap, currency, 0) }) : t.noCap}</div>
        <div className="mt-2.5 text-[13px]">
          {overview.agents
            .filter((a) => a.spend.eur > 0)
            .slice(0, 4)
            .map((a) => `${a.name} ${money(a.spend.eur, currency)}`)
            .join(" · ")}
        </div>
        <a href="#/money" className="mt-2 inline-block text-[13px] font-bold text-accent-text no-underline">
          {t.seeMoney} →
        </a>
      </div>
    </div>
  );
}

function Team({ ws }: { ws: Workspace }) {
  const { t, overview } = ws;
  const agents = overview?.agents ?? [];
  return (
    <div className="flex flex-col gap-2.5 px-[18px] pb-[18px] pt-2">
      {agents.length === 0 && <p className="m-0 text-sm text-mute">{t.nobodyWorking}</p>}
      {agents.map((a) => (
        <a key={a.id} href={`#/team/${a.id}`} className="flex items-center gap-2.5 rounded-control px-1 py-1 text-ink no-underline hover:bg-hover">
          <Avatar name={a.name} />
          <div className="min-w-0 flex-1">
            <strong>{a.name}</strong> <span className="text-[13px] text-mute">{a.role.split(/[.\n]/)[0]}</span>
            <div className="truncate text-[13px] text-mute">{a.doing ?? (a.activity === "waiting" ? t.activity.waiting : a.lastActiveAt ? timeAgo(a.lastActiveAt, t) : "")}</div>
          </div>
          <ActivityChip activity={a.activity} t={t} />
        </a>
      ))}
      <a
        href="#/team/new"
        className="mt-1 inline-flex h-9 items-center gap-2 self-start rounded-control border border-line-strong px-3 text-[13px] font-bold text-ink no-underline hover:bg-hover"
      >
        <Plus size={14} /> {t.hireAgent}
      </a>
    </div>
  );
}

function Done({ ws }: { ws: Workspace }) {
  const { t, overview } = ws;
  const runs = (overview?.recentRuns ?? []).filter((r) => r.preview).slice(0, 6);
  if (runs.length === 0) return <EmptyState>{t.noResults}</EmptyState>;
  return (
    <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-sm">
      {runs.map((r) => (
        <a key={r.id} href={`#/chat/${r.sessionId}`} className="flex gap-2.5 rounded-control px-1 py-1 text-ink no-underline hover:bg-hover">
          <span className={`font-extrabold ${r.status === "completed" ? "text-ok" : r.status === "failed" ? "text-danger" : "text-warn"}`} aria-hidden="true">
            {r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "…"}
          </span>
          <span className="min-w-0">
            <strong>{ws.agentName(r.agentId)}</strong> · {r.sessionTitle ?? t.untitled}
            <span className="block truncate text-[13px] text-mute">{r.preview}</span>
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-faint">{timeAgo(r.finishedAt ?? r.startedAt, t)}</span>
        </a>
      ))}
    </div>
  );
}

function Activity({ ws }: { ws: Workspace }) {
  const { t, overview, mode } = ws;
  const entries = overview?.activity ?? [];
  const describe = (e: (typeof entries)[number]) => {
    const actor = e.actorKind === "agent" ? ws.agentName(e.actorId) : e.actorKind === "person" ? t.you : t.system;
    const subject = e.subjectKind === "agent" ? ws.agentName(e.subjectId) : "";
    const template = t.actions[e.action];
    return template ? fill(template, { actor, subject }) : `${actor} · ${e.action}`;
  };
  return (
    <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-[13px] text-mute">
      {entries.slice(0, mode === "advanced" ? 12 : 6).map((e) => (
        <div key={e.id} className="flex gap-2">
          <span className="w-16 shrink-0 text-faint">{timeAgo(e.occurredAt, t)}</span>
          <span className="text-ink-2">
            {describe(e)}
            {mode === "advanced" && <span className="ml-1 font-mono text-[11px] text-faint">{e.action}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Models({ ws }: { ws: Workspace }) {
  const { t } = ws;
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  useEffect(() => {
    api
      .models()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  if (!info) return <EmptyState>…</EmptyState>;
  return (
    <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-sm">
      <div>
        <span className="text-mute">{t.defaultModel}:</span>{" "}
        {info.default ? <strong className="font-mono text-[13px]">{info.default}</strong> : <span className="text-warn">{t.noModel}</span>}
      </div>
      {info.providers.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <Chip tone={p.enabled ? "ok" : "mute"} dot>
            {p.id}
          </Chip>
          <span className="truncate text-[13px] text-mute">{p.detail}</span>
        </div>
      ))}
    </div>
  );
}

function CostByAgent({ ws }: { ws: Workspace }) {
  const { t, company } = ws;
  const [report, setReport] = useState<CostReport | null>(null);
  useEffect(() => {
    api
      .costs(company.id)
      .then(setReport)
      .catch(() => setReport(null));
  }, [company.id, ws.overview]);
  if (!report) return <EmptyState>…</EmptyState>;
  if (report.byAgent.length === 0) return <EmptyState>{t.noCosts}</EmptyState>;
  const max = Math.max(...report.byAgent.map((a) => a.eur), 0.0001);
  return (
    <div className="flex flex-col gap-2.5 px-[18px] pb-[18px] pt-2 text-sm">
      {report.byAgent.map((a) => (
        <div key={a.agentId ?? "none"} className="flex items-center gap-3">
          <span className="w-28 truncate">{a.agentName ?? "—"}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (a.eur / max) * 100)}%`,
                background: "var(--o-accent)",
              }}
            />
          </div>
          <span className="w-24 text-right font-mono text-[12px]">{money(a.eur, "EUR", 4)}</span>
          <span className="w-16 text-right text-[12px] text-mute">
            {a.calls} {t.calls}
          </span>
        </div>
      ))}
    </div>
  );
}
