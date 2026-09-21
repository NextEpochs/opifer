import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { api, eventsSocket, type TaskDetail } from "../api";
import { fill } from "../i18n";
import { Avatar, Button, Chip, Input, Select, money, timeAgo } from "../ui";
import { StatusChip, TaskForm, priorityTone } from "./TaskBits";
import type { Workspace } from "../App";

/** Everything about one task: the why, the state, the results, the conversation, the actions. */
export function TaskDrawer({ ws, taskId, onClose }: { ws: Workspace; taskId: string; onClose: () => void }) {
  const { t, company } = ws;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [comment, setComment] = useState("");
  const [note, setNote] = useState("");
  const [subtask, setSubtask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; size: number; modifiedAt: string }>>([]);

  const load = useCallback(
    () =>
      Promise.all([api.task(taskId), api.taskFiles(taskId).catch(() => ({ folder: "", files: [] }))])
        .then(([detail, listing]) => {
          setTask(detail);
          setFiles(listing.files);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [taskId],
  );
  useEffect(() => {
    void load();
    return eventsSocket(
      (event) => {
        const p = event.payload as { taskId?: string } | undefined;
        if (event.companyId === company.id && (p?.taskId === taskId || event.type === "session.event")) void load();
      },
      () => {},
    );
  }, [load, company.id, taskId]);

  const act = async (action: Parameters<typeof api.taskAction>[1], body: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.taskAction(taskId, action, body);
      setNote("");
      await load();
      await ws.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await api.commentTask(taskId, comment.trim());
      setComment("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!task) return <div className="p-5 text-sm text-mute">{error ?? "…"}</div>;
  const assignee = task.assigneeAgentId ? ws.agentName(task.assigneeAgentId) : null;
  const authorName = (kind: string, id: string | null) => (kind === "agent" ? ws.agentName(id) : kind === "person" ? t.you : t.system);
  const live = task.sessions.find((s) => s.running);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={task.status} ws={ws} />
            {task.priority !== "normal" && <Chip tone={priorityTone(task.priority)}>{t.priorities[task.priority]}</Chip>}
            {live && (
              <a href={`#/chat/${live.id}`} className="text-[12px] font-bold text-ok no-underline">
                ● {t.working}
              </a>
            )}
          </div>
          <h2 className="mb-0 mt-2 font-display text-[22px] font-semibold leading-tight">{task.title}</h2>
          <div className="mt-1 text-[13px] text-mute">{t.taskStatusHint[task.status]}</div>
        </div>
        <button type="button" aria-label={t.cancel} onClick={onClose} className="rounded p-1 text-faint hover:bg-hover hover:text-ink">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-sm">
        {task.description && <p className="m-0 whitespace-pre-wrap leading-relaxed">{task.description}</p>}
        {task.acceptance && (
          <div className="rounded-control border border-line bg-raised px-3 py-2">
            <span className="text-[12px] font-bold uppercase tracking-wide text-mute">{t.taskAcceptance}</span>
            <p className="m-0 mt-0.5">{task.acceptance}</p>
          </div>
        )}

        <section>
          <h3 className="m-0 mb-1.5 text-[12px] font-bold uppercase tracking-wide text-mute">{t.why}</h3>
          <div className="flex flex-wrap gap-1.5">
            {task.why.mission && (
              <Chip tone="accent">
                {t.missionLabel}: {task.why.mission}
              </Chip>
            )}
            {task.why.goals.map((g) => (
              <Chip key={g.id} tone="info">
                {t.goal}: {g.title}
              </Chip>
            ))}
            {task.why.project && (
              <Chip tone="mute">
                {t.project}: {task.why.project.name}
              </Chip>
            )}
            {task.why.parents.map((p) => (
              <a key={p.id} href={`#/work/${p.id}`} className="no-underline">
                <Chip tone="mute">
                  {t.partOf}: {p.title}
                </Chip>
              </a>
            ))}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 text-[13px]">
          <div>
            <span className="text-mute">{t.assignee}</span>
            <div className="mt-1 flex items-center gap-2">
              {assignee ? (
                <>
                  <Avatar name={assignee} size={22} />
                  <span className="font-bold">{assignee}</span>
                </>
              ) : (
                <Select value="" onChange={(e) => void act("assign", { agentId: e.target.value || null })} aria-label={t.assignee}>
                  <option value="">{t.nobodyYet}</option>
                  {ws.overview?.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </div>
          <div>
            <span className="text-mute">{t.costSoFar}</span>
            <div className="mt-1 font-bold">
              {money(task.cost.eur)}{" "}
              <span className="font-normal text-mute">
                · {task.cost.calls} {t.calls}
              </span>
            </div>
            {task.failures > 0 && (
              <div className="text-[12px] text-warn">
                {task.failures} {t.attempts}
              </div>
            )}
          </div>
        </section>

        {task.blockedReason && task.status === "blocked" && (
          <p className="m-0 rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">{task.blockedReason}</p>
        )}

        {task.result && (
          <section>
            <h3 className="m-0 mb-1.5 text-[12px] font-bold uppercase tracking-wide text-mute">{t.results}</h3>
            <p className="m-0 rounded-control border border-line bg-raised px-3 py-2">{task.result.summary}</p>
            {task.result.verification && (
              <p className="m-0 mt-1 text-[12px] text-mute">
                {t.verifyHint} {task.result.verification}
              </p>
            )}
          </section>
        )}
        {(task.products.length > 0 || files.length > 0) && (
          <section>
            <h3 className="m-0 mb-1.5 text-[12px] font-bold uppercase tracking-wide text-mute">{t.artifacts}</h3>
            <ul className="m-0 list-none space-y-1.5 p-0 text-[13px]">
              {task.products.map((p) => {
                const file = p.kind === "file" && files.some((f) => f.path === p.ref.replace(/^\.?\//, ""));
                const link = p.kind === "link" && /^https?:\/\//.test(p.ref);
                return (
                  <li key={p.id} className="flex min-w-0 items-center gap-2">
                    <Chip tone="mute">{p.kind}</Chip>
                    <span className="shrink-0 font-bold">{p.title}</span>
                    {file ? (
                      <>
                        <a href={api.taskFileUrl(taskId, p.ref.replace(/^\.?\//, ""))} target="_blank" rel="noopener" className="min-w-0 truncate font-mono text-[12px]">
                          {p.ref}
                        </a>
                        <a href={api.taskFileUrl(taskId, p.ref.replace(/^\.?\//, ""), true)} className="shrink-0 text-[12px] font-bold text-accent-text no-underline">
                          {t.download}
                        </a>
                      </>
                    ) : link ? (
                      <a href={p.ref} target="_blank" rel="noopener" className="min-w-0 truncate font-mono text-[12px]">
                        {p.ref}
                      </a>
                    ) : (
                      <span className="min-w-0 truncate font-mono text-[12px] text-mute" title={p.ref}>
                        {p.ref}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {files.length > 0 && (
              <details className="mt-2 text-[13px]">
                <summary className="cursor-pointer text-mute">{fill(t.filesInFolder, { n: String(files.length) })}</summary>
                <ul className="m-0 mt-1 list-none space-y-1 p-0">
                  {files.map((f) => (
                    <li key={f.path} className="flex min-w-0 items-center gap-2">
                      <a href={api.taskFileUrl(taskId, f.path)} target="_blank" rel="noopener" className="min-w-0 truncate font-mono text-[12px]">
                        {f.path}
                      </a>
                      <span className="shrink-0 text-[11px] text-faint">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} kB`}</span>
                      <a href={api.taskFileUrl(taskId, f.path, true)} className="shrink-0 text-[12px] font-bold text-accent-text no-underline">
                        {t.download}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        <section>
          <div className="mb-1.5 flex items-center">
            <h3 className="m-0 text-[12px] font-bold uppercase tracking-wide text-mute">{t.subtasks}</h3>
            <button type="button" onClick={() => setSubtask((v) => !v)} className="ml-auto inline-flex items-center gap-1 text-[12px] font-bold text-accent-text">
              <Plus size={12} /> {t.createSubtask}
            </button>
          </div>
          {subtask && (
            <div className="mb-3 rounded-control border border-line p-3">
              <TaskForm
                ws={ws}
                parentId={task.id}
                defaults={{ assigneeAgentId: task.assigneeAgentId }}
                onCreated={() => {
                  setSubtask(false);
                  void load();
                }}
                onCancel={() => setSubtask(false)}
              />
            </div>
          )}
          {task.children.length === 0 && !subtask && <p className="m-0 text-[13px] text-mute">—</p>}
          {task.children.map((c) => (
            <a key={c.id} href={`#/work/${c.id}`} className="flex items-center gap-2 rounded-control px-2 py-1.5 text-ink no-underline hover:bg-hover">
              <StatusChip status={c.status} ws={ws} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{c.title}</span>
              <span className="text-[12px] text-mute">{c.assigneeAgentId ? ws.agentName(c.assigneeAgentId) : t.unassigned}</span>
            </a>
          ))}
        </section>

        <section>
          <h3 className="m-0 mb-1.5 text-[12px] font-bold uppercase tracking-wide text-mute">{t.comments}</h3>
          <div className="space-y-2">
            {task.comments.map((c) => (
              <div key={c.id} className="flex gap-2">
                <Avatar name={authorName(c.authorKind, c.authorId)} size={24} colour={c.authorKind === "person" ? "#06B6D4" : c.authorKind === "system" ? "#9a9ab4" : undefined} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-mute">
                    <strong className="text-ink">{authorName(c.authorKind, c.authorId)}</strong> · {timeAgo(c.createdAt, t)}
                  </div>
                  <p className="m-0 whitespace-pre-wrap text-[13px]">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={post} className="mt-2 flex gap-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t.writeComment} aria-label={t.comments} />
            <Button type="submit" variant="primary" size="md" disabled={busy || !comment.trim()}>
              {t.post}
            </Button>
          </form>
        </section>
        {error && (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
        {(task.status === "in_review" || task.status === "in_progress" || task.status === "todo" || task.status === "blocked") && (
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={task.status === "in_review" ? t.changesNote : task.status === "blocked" ? t.blockReason : t.verifyHint}
            aria-label={t.changesNote}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {task.status === "in_review" && (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act("complete", {
                    summary: task.result?.summary ?? "Verified",
                    verification: note.trim() || "checked by a person",
                  })
                }
              >
                {t.verify}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act("request-changes", {
                    note: note.trim() || "please revise",
                  })
                }
              >
                {t.requestChanges}
              </Button>
            </>
          )}
          {(task.status === "todo" || task.status === "in_progress") && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !note.trim()}
              onClick={() =>
                void act("complete", {
                  summary: note.trim(),
                  verification: "closed by a person",
                })
              }
            >
              {t.verify}
            </Button>
          )}
          {task.status === "todo" && task.assigneeAgentId && (
            <Button variant="soft" size="sm" disabled={busy} onClick={() => void act("wake")}>
              {t.wakeAgent}
            </Button>
          )}
          {task.status === "in_progress" && (
            <Button variant="soft" size="sm" disabled={busy} onClick={() => void act("release", { reason: note.trim() })}>
              {t.releaseTask}
            </Button>
          )}
          {(task.status === "todo" || task.status === "in_progress" || task.status === "in_review") && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act("block", {
                  reason: note.trim() || "blocked by a person",
                })
              }
            >
              {t.blockTask}
            </Button>
          )}
          {task.status === "blocked" && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void act("unblock")}>
              {t.unblockTask}
            </Button>
          )}
          {task.status !== "done" && task.status !== "cancelled" && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void act("cancel", { reason: note.trim() })} className="ml-auto">
              {t.cancelTask}
            </Button>
          )}
          {task.sessions.length > 0 && (
            <a
              href={`#/chat/${task.sessions[task.sessions.length - 1]!.id}`}
              className="inline-flex h-9 items-center rounded-control px-3 text-[13px] font-bold text-accent-text no-underline hover:bg-hover"
            >
              {fill(t.openConversation, {})} →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
