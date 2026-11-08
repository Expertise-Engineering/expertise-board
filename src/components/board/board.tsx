"use client";

import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CardPointerSensor } from "@/components/board/card-pointer-sensor";
import { createTaskAction, deleteProjectAction, patchTaskAction, updateProjectAction } from "@/actions/board";
import { TaskPanel } from "@/components/board/task-panel";
import { useBoard } from "@/components/shell/board-context";
import { STATUS_META, STATUS_ORDER } from "@/lib/board/constants";
import { CARD_DRAG_DISTANCE_PX, createDragClickGate } from "@/lib/board/gestures";
import { EMPTY_FILTERS, isWaiting, taskMatches, type TaskFilters } from "@/lib/board/filters";
import { nextPosition, placeTask } from "@/lib/board/order";
import { assigneeValue, isStatus } from "@/lib/board/text";
import type { Project, Status, Task, TaskDependency } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const controlClass =
  "h-11 rounded-lg border border-input bg-card px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-9 sm:text-sm";

const rails: Record<Status, string> = {
  backlog: "border-l-stone-400",
  todo: "border-l-sky-900",
  doing: "border-l-primary",
  review: "border-l-emerald-800",
  done: "border-l-stone-500",
};

export function Board({
  project,
  initialTasks,
  initialDependencies,
}: {
  project: Project | null;
  initialTasks: Task[];
  initialDependencies: TaskDependency[];
}) {
  const router = useRouter();
  const { profiles, agents, projects: directoryProjects } = useBoard();
  const allProjects = project === null;
  const [tasks, setTasks] = useState(initialTasks);
  const [dependencies, setDependencies] = useState(initialDependencies);
  const [taskSource, setTaskSource] = useState(initialTasks);
  const [dependencySource, setDependencySource] = useState(initialDependencies);
  if (taskSource !== initialTasks) {
    setTaskSource(initialTasks);
    setTasks(initialTasks);
  }
  if (dependencySource !== initialDependencies) {
    setDependencySource(initialDependencies);
    setDependencies(initialDependencies);
  }
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // useState calls this once. The gate mutates; it is not React state.
  const [gestures] = useState(createDragClickGate);
  const sensors = useSensors(
    useSensor(CardPointerSensor, { activationConstraint: { distance: CARD_DRAG_DISTANCE_PX } }),
  );

  useEffect(() => () => gestures.dispose(), [gestures]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      setCreating(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tags = useMemo(() => {
    const values = new Set<string>();
    for (const task of tasks) for (const tag of task.tags) values.add(tag);
    return [...values].sort();
  }, [tasks]);

  const projectChoices = useMemo(
    () => (project === null ? directoryProjects : [project]),
    [project, directoryProjects],
  );
  const projectById = useMemo(() => {
    const values = new Map<string, Project>();
    for (const item of projectChoices) values.set(item.id, item);
    return values;
  }, [projectChoices]);
  const visible = tasks.filter((task) =>
    taskMatches(task, filters, allProjects ? projectById.get(task.project_id)?.name ?? "" : ""),
  );
  const openTask = tasks.find((task) => task.id === openTaskId) ?? null;
  const columns = filters.status === "all" ? STATUS_ORDER : [filters.status];

  function onDragStart(event: DragStartEvent) {
    gestures.onDragStart();
    setActiveId(String(event.active.id));
  }

  function finishDrag() {
    setActiveId(null);
    gestures.onDragFinished();
  }

  function onDragEnd(event: DragEndEvent) {
    const taskId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    finishDrag();
    if (!overId) return;
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;

    let status: Status = task.status;
    let beforeId: string | null = null;
    if (overId.startsWith("column:")) {
      const nextStatus = overId.slice("column:".length);
      if (!isStatus(nextStatus)) return;
      status = nextStatus;
    } else if (overId.startsWith("task:")) {
      const overTask = tasks.find((item) => item.id === overId.slice("task:".length));
      if (!overTask || overTask.id === task.id) return;
      status = overTask.status;
      beforeId = overTask.id;
    } else {
      return;
    }

    const column = tasks
      .filter((item) => item.status === status && item.id !== task.id)
      .map((item) => ({ id: item.id, position: item.position }));
    const position = nextPosition(column, beforeId);
    if (status === task.status && Math.abs(position - task.position) < 0.001) return;

    setTasks((current) => current.map((item) => (item.id === task.id ? placeTask(item, status, position) : item)));
    void patchTaskAction({ id: task.id, status, position }).then((result) => {
      if (!result.ok) {
        toast.error(result.error);
        router.refresh();
      }
    });
  }

  const activeTask = tasks.find((task) => task.id === activeId) ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b bg-card/70 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-medium tracking-tight">{allProjects ? "All projects" : project.name}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {allProjects
                ? "Every customer's tasks. Filter by assignee to see one person's work across all of them."
                : project.description || "Add a short description so the team knows which customer this is."}
            </p>
            <p className="board-touch-hint mt-2 max-w-2xl text-sm leading-5 text-muted-foreground">
              Tap a card to edit it. Drag the Move handle to another column, or change Column inside the card.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {project ? (
              <Button type="button" variant="outline" onClick={() => setEditingProject(true)}>
                Edit project
              </Button>
            ) : null}
            <Button type="button" onClick={() => setCreating(true)}>
              New task
              <kbd className="rounded border bg-primary-foreground/15 px-1 text-[10px]">N</kbd>
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="task-search">Search tasks</label>
          <Input
            id="task-search"
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder={allProjects ? "Search title, description, tags, project" : "Search title, description, tags"}
            className="w-full sm:w-64"
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(status) => setFilters((current) => ({ ...current, status: status as TaskFilters["status"] }))}
          >
            <option value="all">All columns</option>
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>{STATUS_META[status].label}</option>
            ))}
          </FilterSelect>
          <FilterSelect label="Tag" value={filters.tag} onChange={(tag) => setFilters((current) => ({ ...current, tag }))}>
            <option value="all">All tags</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Human"
            value={filters.human}
            onChange={(human) => setFilters((current) => ({ ...current, human: human as TaskFilters["human"] }))}
          >
            <option value="all">People and agents</option>
            <option value="human">Human only</option>
            <option value="agent">Agents can take</option>
          </FilterSelect>
          <FilterSelect
            label="Assignee"
            value={filters.assignee}
            onChange={(assignee) => setFilters((current) => ({ ...current, assignee }))}
          >
            <option value="all">Anyone</option>
            <option value="unassigned">Unassigned</option>
            <optgroup label="People">
              {profiles.map((profile) => (
                <option key={profile.id} value={`user:${profile.id}`}>{profile.display_name}</option>
              ))}
            </optgroup>
            <optgroup label="Agents">
              {agents.filter((agent) => !agent.revoked_at).map((agent) => (
                <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>
              ))}
            </optgroup>
          </FilterSelect>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="mx-auto flex max-w-lg flex-col gap-3 px-6 py-16">
          <h2 className="text-2xl font-medium">{allProjects ? "No tasks yet" : "No tasks on this project"}</h2>
          <p className="text-muted-foreground">
            {allProjects
              ? "Add a task and choose which customer it belongs to. Press N to create one."
              : "Add a task to Backlog when a person should park it, or to Todo when an agent may take it. Press N to create one."}
          </p>
          <Button type="button" className="w-fit" onClick={() => setCreating(true)}>Create the first task</Button>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={finishDrag}>
          <div className="flex flex-1 gap-3 overflow-x-auto overscroll-x-contain px-4 py-4 sm:px-6">
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={visible.filter((task) => task.status === status).sort((a, b) => a.position - b.position)}
                allTasks={tasks}
                dependencies={dependencies}
                projectNameFor={allProjects ? (task) => projectById.get(task.project_id)?.name ?? "Project" : undefined}
                onOpen={(id) => {
                  if (!gestures.shouldOpenFromClick()) return;
                  setOpenTaskId(id);
                }}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? (
              <div className="w-64 rounded-xl border bg-card p-3 text-sm shadow-lg">
                {allProjects ? (
                  <div className="truncate text-xs text-muted-foreground">{projectById.get(activeTask.project_id)?.name}</div>
                ) : null}
                {activeTask.title}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <TaskPanel
        task={openTask}
        tasks={tasks}
        dependencies={dependencies}
        onClose={() => setOpenTaskId(null)}
      />
      <NewTaskDialog
        open={creating}
        projects={projectChoices}
        projectId={project?.id ?? null}
        onOpenChange={setCreating}
        onCreated={(task) => {
          setTasks((current) => [...current, task]);
          setOpenTaskId(task.id);
          router.refresh();
        }}
      />
      {project ? (
        <EditProjectDialog
          open={editingProject}
          project={project}
          onOpenChange={setEditingProject}
        />
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</label>
      <select id={id} className={controlClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </div>
  );
}

function Column({
  status,
  tasks,
  allTasks,
  dependencies,
  projectNameFor,
  onOpen,
}: {
  status: Status;
  tasks: Task[];
  allTasks: Task[];
  dependencies: TaskDependency[];
  projectNameFor?: (task: Task) => string;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  const meta = STATUS_META[status];
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`column-${status}`}
      className={`flex w-[17.5rem] shrink-0 flex-col rounded-2xl border bg-background/70 ${isOver ? "ring-2 ring-ring" : ""}`}
    >
      <header className="px-3 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id={`column-${status}`} className="text-lg font-medium">{meta.label}</h2>
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{meta.hint}</p>
      </header>
      <div className="flex flex-1 flex-col gap-2 p-2">
        {tasks.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing in {meta.label}.</p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              projectLabel={projectNameFor?.(task) ?? null}
              waiting={isWaiting(task.id, allTasks, dependencies)}
              onOpen={() => onOpen(task.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  projectLabel,
  waiting,
  onOpen,
}: {
  task: Task;
  projectLabel: string | null;
  waiting: boolean;
  onOpen: () => void;
}) {
  const { profiles, agents } = useBoard();
  const { listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: task.id });
  const { setNodeRef: setDropRef } = useDroppable({ id: `task:${task.id}` });
  const assignee = task.assignee_user_id
    ? profiles.find((profile) => profile.id === task.assignee_user_id)?.display_name
    : task.assignee_agent_id
      ? agents.find((agent) => agent.id === task.assignee_agent_id)?.name
      : null;

  return (
    <article
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={`flex overflow-hidden rounded-xl border border-l-4 bg-card shadow-sm ${rails[task.status]} ${isDragging ? "opacity-40" : ""}`}
      {...listeners}
    >
      <div
        data-drag-handle=""
        aria-hidden="true"
        title="Drag to move"
        onContextMenu={(event) => event.preventDefault()}
        className="flex w-11 shrink-0 cursor-grab touch-none flex-col items-center justify-center gap-0.5 border-r bg-muted/50 text-xs font-medium text-muted-foreground select-none [-webkit-touch-callout:none] active:cursor-grabbing"
      >
        <GripVertical className="pointer-events-none size-4" />
        <span className="pointer-events-none">Move</span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="block min-w-0 flex-1 touch-manipulation rounded-r-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={
          projectLabel
            ? `Open task ${task.number} on ${projectLabel}, ${task.title}`
            : `Open task ${task.number}, ${task.title}`
        }
      >
        {projectLabel ? (
          <span className="mb-1 block truncate text-xs font-medium tracking-wide text-primary uppercase">{projectLabel}</span>
        ) : null}
        <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>#{task.number}</span>
          {task.is_human ? <Badge variant="secondary">Human</Badge> : null}
        </span>
        <span className="mt-1 block text-sm font-medium leading-5">{task.title}</span>
        {task.tags.length > 0 ? (
          <span className="mt-2 flex flex-wrap gap-1">
            {task.tags.map((tag) => (
              <Badge key={tag} variant="outline">{tag}</Badge>
            ))}
          </span>
        ) : null}
        <span className="mt-2 block text-xs text-muted-foreground">
          {assignee ?? "Unassigned"}
          {waiting ? " · Waiting" : ""}
        </span>
      </button>
    </article>
  );
}

function NewTaskDialog({
  open,
  projects,
  projectId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  projects: Project[];
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: Task) => void;
}) {
  const { profiles, agents } = useBoard();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>("todo");
  const [isHuman, setIsHuman] = useState(false);
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [assignee, setAssignee] = useState("");
  const [chosenProject, setChosenProject] = useState(projectId ?? projects[0]?.id ?? "");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setChosenProject(projectId ?? projects[0]?.id ?? "");
  }

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("todo");
    setIsHuman(false);
    setUrl("");
    setTags("");
    setAssignee("");
    setChosenProject(projectId ?? projects[0]?.id ?? "");
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const destination = projectId ?? chosenProject;
    if (!destination) {
      toast.error("Choose a project.");
      return;
    }
    startTransition(async () => {
      const result = await createTaskAction({
        projectId: destination,
        title,
        description,
        status,
        isHuman,
        url,
        tags,
        assignee,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      reset();
      onOpenChange(false);
      onCreated(result.data);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            {projectId
              ? "Todo is ready for an agent. Backlog stays with people. Mark Human when an agent must not take it."
              : "Choose the customer this task belongs to. Todo is ready for an agent. Backlog stays with people."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid max-h-[70dvh] gap-3 overflow-y-auto pr-1">
          {projectId === null ? (
            <div className="grid gap-1.5">
              <Label htmlFor="task-project">Project</Label>
              <select
                id="task-project"
                className={controlClass}
                value={chosenProject}
                required
                onChange={(event) => setChosenProject(event.target.value)}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea id="task-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="task-status">Column</Label>
              <select id="task-status" className={controlClass} value={status} onChange={(event) => setStatus(event.target.value as Status)}>
                {STATUS_ORDER.map((item) => (
                  <option key={item} value={item}>{STATUS_META[item].label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <select id="task-assignee" className={controlClass} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Unassigned</option>
                <optgroup label="People">
                  {profiles.map((profile) => (
                    <option key={profile.id} value={assigneeValue(profile.id, null)}>{profile.display_name}</option>
                  ))}
                </optgroup>
                <optgroup label="Agents">
                  {agents.filter((agent) => !agent.revoked_at).map((agent) => (
                    <option key={agent.id} value={assigneeValue(null, agent.id)}>{agent.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div>
              <Label htmlFor="task-human">Human only</Label>
              <p className="text-xs text-muted-foreground">Agents will not pick this up.</p>
            </div>
            <Switch id="task-human" checked={isHuman} onCheckedChange={setIsHuman} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-url">URL</Label>
            <Input id="task-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-tags">Tags</Label>
            <Input id="task-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="portal, billing" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add task"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({
  open,
  project,
  onOpenChange,
}: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [pending, startTransition] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(project.name);
      setDescription(project.description);
      setConfirmingDelete(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateProjectAction({ id: project.id, name, description });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  function onDelete() {
    startTransition(async () => {
      const result = await deleteProjectAction(project.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>The address stays the same. Deleting removes every task on this project.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-project-name">Name</Label>
            <Input id="edit-project-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-project-description">Description</Label>
            <Textarea id="edit-project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </div>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>Delete project</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
        {confirmingDelete ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p>Delete {project.name} and all of its tasks?</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="destructive" onClick={onDelete} disabled={pending}>Delete</Button>
              <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function EmptyBoard() {
  const { openNewProject } = useBoard();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
      <h1 className="text-4xl font-medium tracking-tight">No projects yet</h1>
      <p className="text-lg leading-relaxed text-muted-foreground">
        Expertise Board tracks who is doing what. Create a project for a customer or a job, then add tasks.
        People park work in Backlog. Agents pick up Todo cards that are not marked human and are not waiting on unfinished work.
      </p>
      <Button type="button" className="w-fit" onClick={openNewProject}>Create the first project</Button>
    </main>
  );
}
