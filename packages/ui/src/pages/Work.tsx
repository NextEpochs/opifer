import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Plus, X } from "lucide-react";
import {
  api,
  eventsSocket,
  type Goal,
  type Project,
  type Task,
  type TaskStatus,
} from "../api";
import { Button, Card, Chip, Input, Segmented } from "../ui";
import { STATUS_ORDER, TaskCard, TaskForm } from "../components/TaskBits";
import { TaskDrawer } from "../components/TaskDrawer";
import type { Workspace } from "../App";

/** The Work page: a board by state (drag by hand only where a person decides), a list, goals and projects. */
export function WorkPage({
  ws,
  param,
}: {
  ws: Workspace;
  param: string | null;
}) {
  const { t, company } = ws;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<"board" | "list">("board");
  const [creating, setCreating] = useState(param === "new");
  const [projectFilter, setProjectFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Task | null>(null);
  const selected = param && param !== "new" ? param : null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const load = useCallback(async () => {
    const [ts, gs, ps] = await Promise.all([
      api.tasks(company.id, projectFilter ? { projectId: projectFilter } : {}),
      api.goals(company.id),
      api.projects(company.id),
    ]);
    setTasks(ts);
    setGoals(gs);
    setProjects(ps);
  }, [company.id, projectFilter]);

  useEffect(() => {
    void load();
    return eventsSocket(
      (event) => {
        if (event.companyId === company.id && event.type.startsWith("task."))
          void load();
        if (
          event.companyId === company.id &&
          (event.type.startsWith("goal.") || event.type.startsWith("project."))
        )
          void load();
      },
      () => {},
    );
  }, [load, company.id]);

  useEffect(() => {
    setCreating(param === "new");
  }, [param]);

  const byStatus = (s: TaskStatus) =>
    tasks.filter(
      (x) =>
        x.status === s &&
        (s !== "done" ||
          !x.finishedAt ||
          Date.now() - new Date(x.finishedAt).getTime() < 7 * 86_400_000),
    );
  const open = (id: string) => ws.go("work", id);

  const onDragStart = (e: DragStartEvent) =>
    setDragging(tasks.find((x) => x.id === e.active.id) ?? null);
  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const task = tasks.find((x) => x.id === e.active.id);
    const to = e.over?.id as TaskStatus | undefined;
    if (!task || !to || to === task.status) return;
    try {
      if (to === "done") {
        const summary = window.prompt(t.verifyHint, task.result?.summary ?? "");
        if (summary === null) return;
        await api.taskAction(task.id, "complete", {
          summary: summary || task.result?.summary || "Verified by a person",
          verification: "moved to done on the board",
        });
      } else if (to === "blocked") {
        const reason = window.prompt(t.blockReason, "");
        if (reason === null) return;
        await api.taskAction(task.id, "block", {
          reason: reason || "blocked by a person",
        });
      } else if (to === "todo" && task.status === "blocked") {
        await api.taskAction(task.id, "unblock");
      } else if (to === "todo" && task.status === "in_review") {
        const note = window.prompt(t.changesNote, "");
        if (note === null) return;
        await api.taskAction(task.id, "request-changes", {
          note: note || "please revise",
        });
      } else if (to === "todo" && task.status === "in_progress") {
        await api.taskAction(task.id, "release", {});
      } else {
        setNotice(t.cannotDrop);
        setTimeout(() => setNotice(null), 4000);
        return;
      }
      await load();
      await ws.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setTimeout(() => setNotice(null), 5000);
    }
  };

  return (
    <div className="flex h-full min-h-screen">
      <div className="flex min-w-0 flex-1 flex-col gap-5 p-6 sm:p-9">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">
              {t.workTitle}
            </h1>
            <p className="mt-1.5 text-[15px] text-mute">{t.workSub}</p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              value={view}
              onChange={setView}
              label={t.workTitle}
              options={[
                { value: "board", label: t.views.board },
                { value: "list", label: t.views.list },
              ]}
              className="w-44"
            />
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label={t.project}
              className="h-10 rounded-control border border-line-strong bg-bg px-2 text-sm"
            >
              <option value="">{t.projects}: —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={() => ws.go("work", "new")}>
              <Plus size={16} /> {t.newTask}
            </Button>
          </div>
        </header>
        {notice && (
          <p className="m-0 rounded-control border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-warn">
            {notice}
          </p>
        )}
        {tasks.length === 0 && !creating && (
          <p className="text-sm text-mute">{t.noTasks}</p>
        )}

        {view === "board" ? (
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={(e) => void onDragEnd(e)}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 2xl:grid-cols-5">
              {STATUS_ORDER.map((status) => (
                <Column
                  key={status}
                  status={status}
                  ws={ws}
                  tasks={byStatus(status)}
                  onOpen={open}
                  active={dragging !== null}
                />
              ))}
            </div>
            <DragOverlay>
              {dragging ? (
                <TaskCard task={dragging} ws={ws} onOpen={() => {}} dragging />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <ListView ws={ws} tasks={tasks} projects={projects} onOpen={open} />
        )}

        <GoalsPanel
          ws={ws}
          goals={goals}
          projects={projects}
          onChanged={load}
        />
      </div>

      {(selected || creating) && (
        <aside
          className="m-4 flex w-[440px] shrink-0 flex-col overflow-hidden rounded-[22px] border border-line bg-card shadow-card"
          aria-label={t.workTitle}
        >
          {creating ? (
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center">
                <h2 className="m-0 font-display text-2xl font-semibold">
                  {t.newTask}
                </h2>
                <button
                  type="button"
                  aria-label={t.cancel}
                  onClick={() => ws.go("work")}
                  className="ml-auto rounded p-1 text-faint hover:bg-hover hover:text-ink"
                >
                  <X size={16} />
                </button>
              </div>
              <TaskForm
                ws={ws}
                onCreated={(task) => ws.go("work", task.id)}
                onCancel={() => ws.go("work")}
              />
            </div>
          ) : selected ? (
            <TaskDrawer
              key={selected}
              ws={ws}
              taskId={selected}
              onClose={() => ws.go("work")}
            />
          ) : null}
        </aside>
      )}
    </div>
  );
}

function Column({
  status,
  ws,
  tasks,
  onOpen,
  active,
}: {
  status: TaskStatus;
  ws: Workspace;
  tasks: Task[];
  onOpen: (id: string) => void;
  active: boolean;
}) {
  const { t } = ws;
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-40 flex-col gap-2 rounded-card border p-2.5 transition ${isOver ? "border-accent bg-accent-soft" : active ? "border-dashed border-line-strong bg-panel" : "border-line bg-panel"}`}
    >
      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="shrink-0 whitespace-nowrap text-[13px] font-bold">
          {t.taskStatus[status]}
        </span>
        <span className="text-[12px] text-faint">{tasks.length}</span>
        <span
          className="ml-auto min-w-0 truncate text-[11px] text-faint"
          title={t.taskStatusHint[status]}
        >
          {t.taskStatusHint[status]}
        </span>
      </div>
      {tasks.map((task) => (
        <Draggable key={task.id} task={task} ws={ws} onOpen={onOpen} />
      ))}
      {isOver && (
        <div className="rounded-control border-2 border-dashed border-accent py-3 text-center text-[12px] font-bold text-accent-text">
          {t.dropToChange}
        </div>
      )}
    </div>
  );
}

function Draggable({
  task,
  ws,
  onOpen,
}: {
  task: Task;
  ws: Workspace;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={isDragging ? "opacity-40" : ""}
    >
      <TaskCard task={task} ws={ws} onOpen={onOpen} />
    </div>
  );
}

function ListView({
  ws,
  tasks,
  projects,
  onOpen,
}: {
  ws: Workspace;
  tasks: Task[];
  projects: Project[];
  onOpen: (id: string) => void;
}) {
  const { t } = ws;
  const groups = [
    ...projects.map((p) => ({ id: p.id, name: p.name })),
    { id: null, name: t.noProject },
  ];
  const roots = tasks.filter((x) => !x.parentId);
  const childrenOf = (id: string) => tasks.filter((x) => x.parentId === id);
  const row = (task: Task, depth: number) => (
    <div key={task.id}>
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-hover"
        style={{ paddingLeft: 8 + depth * 24 }}
      >
        <Chip
          tone={
            task.status === "in_progress"
              ? "ok"
              : task.status === "in_review"
                ? "warn"
                : task.status === "blocked"
                  ? "danger"
                  : task.status === "done"
                    ? "accent"
                    : "mute"
          }
          dot
          pulse={task.status === "in_progress"}
        >
          {t.taskStatus[task.status]}
        </Chip>
        <span
          className={`min-w-0 flex-1 truncate text-sm font-bold ${task.status === "done" || task.status === "cancelled" ? "text-mute line-through" : ""}`}
        >
          {task.title}
        </span>
        <span className="text-[12px] text-mute">
          {task.assigneeAgentId
            ? ws.agentName(task.assigneeAgentId)
            : t.unassigned}
        </span>
        <span className="w-16 text-right text-[12px] text-faint">
          {t.priorities[task.priority]}
        </span>
      </button>
      {childrenOf(task.id).map((c) => row(c, depth + 1))}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        const items = roots.filter((x) => x.projectId === g.id);
        if (items.length === 0) return null;
        return (
          <Card key={g.id ?? "none"} className="p-2">
            <div className="px-2 pb-1 pt-1 text-[12px] font-bold uppercase tracking-wide text-mute">
              {g.name}
            </div>
            {items.map((x) => row(x, 0))}
          </Card>
        );
      })}
    </div>
  );
}

function GoalsPanel({
  ws,
  goals,
  projects,
  onChanged,
}: {
  ws: Workspace;
  goals: Goal[];
  projects: Project[];
  onChanged: () => Promise<void>;
}) {
  const { t, company } = ws;
  const [goalTitle, setGoalTitle] = useState("");
  const [goalMeasure, setGoalMeasure] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectGoal, setProjectGoal] = useState("");

  const addGoal = async (e: FormEvent) => {
    e.preventDefault();
    if (!goalTitle.trim()) return;
    await api.createGoal(company.id, {
      title: goalTitle.trim(),
      measure: goalMeasure.trim(),
    });
    setGoalTitle("");
    setGoalMeasure("");
    await onChanged();
  };
  const addProject = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) return;
    await api.createProject(company.id, {
      name: projectName.trim(),
      goalId: projectGoal || null,
    });
    setProjectName("");
    await onChanged();
  };
  const roots = goals.filter((g) => !g.parentId);
  const childrenOf = (id: string) => goals.filter((g) => g.parentId === id);
  const goalRow = (g: Goal, depth: number): ReactNode => (
    <Fragment key={g.id}>
      <div
        className="flex items-center gap-2 py-1 text-sm"
        style={{ paddingLeft: depth * 18 }}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${g.status === "reached" ? "bg-ok" : g.status === "dropped" ? "bg-faint" : "bg-accent"}`}
          aria-hidden="true"
        />
        <span
          className={`min-w-0 flex-1 truncate ${g.status !== "active" ? "text-mute line-through" : "font-bold"}`}
        >
          {g.title}
        </span>
        {g.measure && (
          <span className="hidden min-w-0 max-w-[40%] truncate text-[12px] text-mute xl:inline">
            {g.measure}
          </span>
        )}
        {g.status === "active" && (
          <button
            type="button"
            onClick={() =>
              void api
                .updateGoal(company.id, g.id, { status: "reached" })
                .then(onChanged)
            }
            className="shrink-0 text-[12px] font-bold text-accent-text"
          >
            {t.markReached}
          </button>
        )}
      </div>
      {childrenOf(g.id).map((c) => goalRow(c, depth + 1))}
    </Fragment>
  );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card className="p-4">
        <h2 className="m-0 mb-2 text-[15px] font-bold">{t.goals}</h2>
        {roots.length === 0 && <p className="m-0 text-[13px] text-mute">—</p>}
        {roots.map((g) => goalRow(g, 0))}
        <form
          onSubmit={addGoal}
          className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3"
        >
          <div className="min-w-40 flex-1">
            <Input
              value={goalTitle}
              onChange={(e) => setGoalTitle(e.target.value)}
              placeholder={t.newGoal}
              aria-label={t.newGoal}
            />
          </div>
          <div className="min-w-40 flex-1">
            <Input
              value={goalMeasure}
              onChange={(e) => setGoalMeasure(e.target.value)}
              placeholder={t.goalMeasure}
              aria-label={t.goalMeasure}
            />
          </div>
          <Button type="submit" variant="soft" disabled={!goalTitle.trim()}>
            <Plus size={14} /> {t.newGoal}
          </Button>
        </form>
      </Card>
      <Card className="p-4">
        <h2 className="m-0 mb-2 text-[15px] font-bold">{t.projects}</h2>
        {projects.length === 0 && (
          <p className="m-0 text-[13px] text-mute">—</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="flex items-center gap-2 py-1 text-sm">
            <span className="font-bold">{p.name}</span>
            {p.goalId && (
              <span className="truncate text-[12px] text-mute">
                → {goals.find((g) => g.id === p.goalId)?.title}
              </span>
            )}
            <Chip
              tone={p.status === "active" ? "ok" : "mute"}
              className="ml-auto"
            >
              {p.status}
            </Chip>
          </div>
        ))}
        <form
          onSubmit={addProject}
          className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3"
        >
          <div className="min-w-40 flex-1">
            <Input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t.newProject}
              aria-label={t.newProject}
            />
          </div>
          <select
            value={projectGoal}
            onChange={(e) => setProjectGoal(e.target.value)}
            aria-label={t.goal}
            className="h-10 min-w-40 flex-1 rounded-control border border-line-strong bg-bg px-2 text-sm"
          >
            <option value="">{t.goal}: —</option>
            {goals
              .filter((g) => g.status === "active")
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
          <Button type="submit" variant="soft" disabled={!projectName.trim()}>
            <Plus size={14} /> {t.newProject}
          </Button>
        </form>
      </Card>
    </div>
  );
}
