import { useEffect, useState, type FormEvent } from "react";
import { api, type Task, type TaskPriority, type TaskStatus } from "../api";
import { fill } from "../i18n";
import { Avatar, Button, Chip, Input, Select, Textarea, money, timeAgo, type Tone } from "../ui";
import type { Workspace } from "../App";

export const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "in_review", "blocked", "done"];

export function statusTone(status: TaskStatus): Tone {
  switch (status) {
    case "in_progress":
      return "ok";
    case "in_review":
      return "warn";
    case "blocked":
      return "danger";
    case "done":
      return "accent";
    default:
      return "mute";
  }
}

export function priorityTone(priority: TaskPriority): Tone {
  return priority === "urgent" ? "danger" : priority === "high" ? "warn" : "mute";
}

export function StatusChip({ status, ws }: { status: TaskStatus; ws: Workspace }) {
  return (
    <Chip tone={statusTone(status)} dot pulse={status === "in_progress"}>
      {ws.t.taskStatus[status]}
    </Chip>
  );
}

/** A compact task card for boards and lists. */
export function TaskCard({ task, ws, onOpen, dragging = false }: { task: Task; ws: Workspace; onOpen: (id: string) => void; dragging?: boolean }) {
  const { t } = ws;
  const assignee = task.assigneeAgentId ? ws.agentName(task.assigneeAgentId) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className={`flex w-full flex-col gap-2 rounded-[14px] border border-line bg-card p-3 text-left shadow-card transition hover:border-accent ${dragging ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-bold leading-snug">{task.title}</span>
        {task.priority !== "normal" && <Chip tone={priorityTone(task.priority)}>{t.priorities[task.priority]}</Chip>}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-mute">
        {assignee ? (
          <>
            <Avatar name={assignee} size={20} />
            <span>{assignee}</span>
          </>
        ) : (
          <span>{t.unassigned}</span>
        )}
        <span className="ml-auto">{timeAgo(task.updatedAt, t)}</span>
      </div>
      {task.status === "blocked" && task.blockedReason && <p className="m-0 text-[12px] text-danger">{task.blockedReason}</p>}
      {task.status === "in_review" && task.result && <p className="m-0 line-clamp-2 text-[12px] text-ink-2">{task.result.summary}</p>}
    </button>
  );
}

/** Creating a task: title, what to do, done when, who, priority, project. */
export function TaskForm({
  ws,
  parentId,
  defaults,
  onCreated,
  onCancel,
}: {
  ws: Workspace;
  parentId?: string | null;
  defaults?: { assigneeAgentId?: string | null; projectId?: string | null };
  onCreated: (task: Task) => void;
  onCancel?: () => void;
}) {
  const { t, company, overview } = ws;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [assignee, setAssignee] = useState(defaults?.assigneeAgentId ?? overview?.agents.find((a) => a.status === "active")?.id ?? "");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [projectId, setProjectId] = useState(defaults?.projectId ?? "");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .projects(company.id)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [company.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask(company.id, {
        title: title.trim(),
        description: description.trim(),
        acceptance: acceptance.trim(),
        priority,
        parentId: parentId ?? null,
        assigneeAgentId: assignee || null,
        projectId: projectId || null,
      });
      await ws.refresh();
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.taskTitle}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.taskDescription}</span>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-mute">{t.taskAcceptance}</span>
        <Input value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder={t.taskAcceptanceHint} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-mute">{t.assignee}</span>
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t.nobodyYet}</option>
            {overview?.agents
              .filter((a) => a.status !== "archived")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-mute">{t.priority}</span>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {(["low", "normal", "high", "urgent"] as TaskPriority[]).map((p) => (
              <option key={p} value={p}>
                {t.priorities[p]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {!parentId && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-mute">{t.project}</span>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t.noProject}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {error && (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          {fill(t.giveTask, {})}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}

/** A delivered task waiting for a person's verdict (Inbox and Home). */
export function ReviewCard({ task, ws, compact = false }: { task: Task; ws: Workspace; compact?: boolean }) {
  const { t } = ws;
  const agent = ws.agentName(task.assigneeAgentId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = task.status === "blocked";
  const act = async (action: "complete" | "request-changes" | "unblock" | "cancel") => {
    setBusy(true);
    try {
      if (action === "complete") await api.taskAction(task.id, "complete", { summary: task.result?.summary ?? "Verified", verification: note.trim() || "checked by a person" });
      else if (action === "request-changes") await api.taskAction(task.id, "request-changes", { note: note.trim() || "please revise" });
      else if (action === "unblock") await api.taskAction(task.id, "unblock");
      else await api.taskAction(task.id, "cancel", { reason: note.trim() });
      await ws.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`flex flex-col gap-3 rounded-[14px] border ${blocked ? "border-danger/50" : "border-line"} bg-card p-4`}>
      <div className="flex items-center gap-3">
        <Avatar name={agent} size={compact ? 30 : 38} />
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-tight">{blocked ? fill(t.blockedTitle, { task: task.title }) : fill(t.reviewTitle, { agent, task: task.title })}</div>
          <div className="text-[13px] text-mute">{timeAgo(task.updatedAt, t)}</div>
        </div>
        <Chip tone={blocked ? "danger" : "warn"}>{t.taskStatus[task.status]}</Chip>
      </div>
      {blocked ? <p className="m-0 text-[13px] text-danger">{task.blockedReason}</p> : task.result && <p className="m-0 text-[14px]">{task.result.summary}</p>}
      {!blocked && task.result?.verification && !compact && (
        <p className="m-0 text-[13px] text-mute">
          {t.verifyHint} {task.result.verification}
        </p>
      )}
      {task.acceptance && !compact && (
        <p className="m-0 text-[13px] text-mute">
          <strong>{t.taskAcceptance}:</strong> {task.acceptance}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {blocked ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void act("unblock")}>
              {t.unblockTask}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("cancel")}>
              {t.cancelTask}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void act("complete")}>
              {t.verify}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("request-changes")}>
              {t.requestChanges}
            </Button>
          </>
        )}
        <a href={`#/work/${task.id}`} className="ml-auto text-[13px] font-bold text-accent-text no-underline">
          {t.workTitle} →
        </a>
        {!compact && (
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={blocked ? t.blockReason : t.changesNote} aria-label={t.changesNote} className="basis-full" />
        )}
      </div>
    </article>
  );
}

export function costLine(eur: number, calls: number, t: Workspace["t"]): string {
  return `${money(eur)} · ${calls} ${t.calls}`;
}
