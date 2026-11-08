"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addCommentAction, deleteTaskAction, loadThreadAction, patchTaskAction, updateTaskAction } from "@/actions/board";
import { useBoard } from "@/components/shell/board-context";
import { STATUS_META, STATUS_ORDER } from "@/lib/board/constants";
import { sameProjectTasks, waitingOn } from "@/lib/board/filters";
import { assigneeValue, formatStamp } from "@/lib/board/text";
import type { Comment, Status, Task, TaskDependency, TaskEvent } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const controlClass =
  "h-11 w-full rounded-lg border border-input bg-card px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-9 sm:text-sm";

export function TaskPanel({
  task,
  tasks,
  dependencies,
  onClose,
}: {
  task: Task | null;
  tasks: Task[];
  dependencies: TaskDependency[];
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full max-w-full overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))] data-[side=right]:w-full data-[side=right]:max-w-none sm:data-[side=right]:max-w-xl"
      >
        {task ? (
          <TaskForm key={task.id} task={task} tasks={tasks} dependencies={dependencies} onClose={onClose} />
        ) : (
          <SheetHeader>
            <SheetTitle>Task</SheetTitle>
            <SheetDescription>Select a card.</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function TaskForm({
  task,
  tasks,
  dependencies,
  onClose,
}: {
  task: Task;
  tasks: Task[];
  dependencies: TaskDependency[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { profiles, agents } = useBoard();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [url, setUrl] = useState(task.url ?? "");
  const [tags, setTags] = useState(task.tags.join(", "));
  const [waits, setWaits] = useState<string[]>(() => waitingOn(task.id, dependencies));
  const [waitSource, setWaitSource] = useState({ id: task.id, dependencies });
  if (waitSource.id !== task.id || waitSource.dependencies !== dependencies) {
    setWaitSource({ id: task.id, dependencies });
    setWaits(waitingOn(task.id, dependencies));
  }
  const [comment, setComment] = useState("");
  const [thread, setThread] = useState<{ comments: Comment[]; events: TaskEvent[] }>({ comments: [], events: [] });
  const [threadError, setThreadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadThreadAction(task.id).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setThreadError(result.error);
        return;
      }
      setThreadError(null);
      setThread(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.updated_at]);

  function patch(input: { status?: Status; isHuman?: boolean; assignee?: string }) {
    startTransition(async () => {
      const result = await patchTaskAction({ id: task.id, ...input });
      if (!result.ok) toast.error(result.error);
      else router.refresh();
    });
  }

  function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateTaskAction({
        id: task.id,
        title,
        description,
        url,
        tags,
        waitsOn: waits,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Task saved");
      router.refresh();
    });
  }

  function sendComment(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addCommentAction({ taskId: task.id, body: comment });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setComment("");
      setThread((current) => ({ ...current, comments: [...current.comments, result.data] }));
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteTaskAction(task.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  const others = sameProjectTasks(task, tasks);

  return (
    <div className="flex flex-col gap-5 p-1">
      <SheetHeader className="pr-8">
        <SheetTitle>#{task.number}</SheetTitle>
        <SheetDescription>Updated {formatStamp(task.updated_at)}</SheetDescription>
      </SheetHeader>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="panel-status">Column</Label>
          <select
            id="panel-status"
            className={controlClass}
            value={task.status}
            onChange={(event) => patch({ status: event.target.value as Status })}
          >
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>{STATUS_META[status].label}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="panel-assignee">Assignee</Label>
          <select
            id="panel-assignee"
            className={controlClass}
            value={assigneeValue(task.assignee_user_id, task.assignee_agent_id)}
            onChange={(event) => patch({ assignee: event.target.value })}
          >
            <option value="">Unassigned</option>
            <optgroup label="People">
              {profiles.filter((profile) => !profile.revoked_at || profile.id === task.assignee_user_id).map((profile) => (
                <option key={profile.id} value={assigneeValue(profile.id, null)}>
                  {profile.display_name}{profile.revoked_at ? " (removed)" : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="Agents">
              {agents.filter((agent) => !agent.revoked_at || agent.id === task.assignee_agent_id).map((agent) => (
                <option key={agent.id} value={assigneeValue(null, agent.id)}>
                  {agent.name}{agent.revoked_at ? " (revoked)" : ""}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div>
            <Label htmlFor="panel-human">Human only</Label>
            <p className="text-xs text-muted-foreground">Agents skip this, including next_task.</p>
          </div>
          <Switch id="panel-human" checked={task.is_human} onCheckedChange={(checked) => patch({ isHuman: checked })} />
        </div>
      </div>

      <form onSubmit={saveDetails} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="panel-title">Title</Label>
          <Input id="panel-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="panel-description">Description</Label>
          <Textarea id="panel-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={5} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="panel-url">URL</Label>
          <Input id="panel-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="panel-tags">Tags</Label>
          <Input id="panel-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="portal, billing" />
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Waits on</legend>
          <p className="text-xs text-muted-foreground">Agents skip this task until every selected task is Done.</p>
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other tasks in this project.</p>
          ) : (
            <div className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border p-2">
              {others.map((item) => {
                const checked = waits.includes(item.id);
                return (
                  <label key={item.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      onChange={(event) => {
                        setWaits((current) =>
                          event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                        );
                      }}
                    />
                    <span>
                      #{item.number} {item.title}
                      <span className="text-muted-foreground"> · {STATUS_META[item.status].label}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save details"}</Button>
      </form>

      <section aria-labelledby="comments-heading" className="grid gap-3">
        <h2 id="comments-heading" className="text-lg font-medium">Comments</h2>
        {threadError ? <p className="text-sm text-destructive">{threadError}</p> : null}
        <ol className="grid gap-3">
          {thread.comments.length === 0 ? (
            <li className="text-sm text-muted-foreground">No comments yet.</li>
          ) : (
            thread.comments.map((item) => (
              <li key={item.id} className="rounded-lg border bg-card px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {actorName(item.author_user_id, item.author_agent_id, profiles, agents)} · {formatStamp(item.created_at)}
                </p>
                <p className="mt-1 text-sm whitespace-pre-wrap">{item.body}</p>
              </li>
            ))
          )}
        </ol>
        <form onSubmit={sendComment} className="grid gap-2">
          <Label htmlFor="panel-comment">Add a comment</Label>
          <Textarea id="panel-comment" value={comment} onChange={(event) => setComment(event.target.value)} rows={3} />
          <Button type="submit" variant="secondary" disabled={pending || !comment.trim()}>Comment</Button>
        </form>
      </section>

      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="text-lg font-medium">Activity</h2>
        <ol className="mt-2 grid gap-2">
          {thread.events.length === 0 ? (
            <li className="text-sm text-muted-foreground">No activity yet.</li>
          ) : (
            thread.events.map((event) => (
              <li key={event.id} className="text-sm text-muted-foreground">
                <span className="text-foreground">{describeEvent(event, profiles, agents)}</span>
                {" · "}
                {formatStamp(event.created_at)}
              </li>
            ))
          )}
        </ol>
      </section>

      <div className="border-t pt-3">
        {confirmDelete ? (
          <div className="grid gap-2">
            <p className="text-sm">Delete #{task.number} {task.title}?</p>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" onClick={remove} disabled={pending}>Delete task</Button>
              <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete task</Button>
        )}
      </div>
    </div>
  );
}

function actorName(
  userId: string | null,
  agentId: string | null,
  profiles: { id: string; display_name: string }[],
  agents: { id: string; name: string }[],
  fallback?: string,
) {
  if (userId) return profiles.find((profile) => profile.id === userId)?.display_name ?? fallback ?? "Teammate";
  if (agentId) return agents.find((agent) => agent.id === agentId)?.name ?? fallback ?? "Agent";
  return fallback ?? "Someone";
}

function describeEvent(
  event: TaskEvent,
  profiles: { id: string; display_name: string }[],
  agents: { id: string; name: string }[],
) {
  const metaName = typeof event.meta.actor_name === "string" ? event.meta.actor_name : undefined;
  const name = actorName(event.actor_user_id, event.actor_agent_id, profiles, agents, metaName);
  if (event.kind === "created") return `${name} created this task`;
  if (event.kind === "moved") {
    return `${name} moved it from ${label(event.from_status)} to ${label(event.to_status)}`;
  }
  if (event.kind === "assigned") return `${name} changed the assignee`;
  if (event.kind === "commented") return `${name} commented`;
  return `${name} updated the details`;
}

function label(status: string | null) {
  if (status && status in STATUS_META) return STATUS_META[status as Status].label;
  return status ?? "none";
}
