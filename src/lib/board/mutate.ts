import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor, Comment, Project, Status, Task, TaskEventKind } from "@/lib/types";
import {
  assigneeValue,
  cleanUrl,
  errorMessage,
  isStatus,
  isUuid,
  normalizeTags,
  parseAssignee,
  slugify,
  uniqueSlug,
} from "@/lib/board/text";

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

type Db = SupabaseClient;

function fail(error: { message: string } | null): asserts error is null {
  if (error) throw new BoardError(errorMessage(new Error(error.message)));
}

function actorIds(actor: Actor) {
  return actor.kind === "user"
    ? { actor_user_id: actor.id, actor_agent_id: null }
    : { actor_user_id: null, actor_agent_id: actor.id };
}

async function logEvent(
  supabase: Db,
  event: {
    task_id: string;
    kind: TaskEventKind;
    from_status?: Status | null;
    to_status?: Status | null;
    actor: Actor;
    meta?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("task_events").insert({
    task_id: event.task_id,
    kind: event.kind,
    from_status: event.from_status ?? null,
    to_status: event.to_status ?? null,
    ...actorIds(event.actor),
    meta: { actor_name: event.actor.name, ...(event.meta ?? {}) },
  });
  fail(error);
}

async function readTask(supabase: Db, id: string): Promise<Task> {
  if (!isUuid(id)) throw new BoardError("Task id is not a uuid.");
  const { data, error } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  fail(error);
  if (!data) throw new BoardError("Task not found.");
  return data as Task;
}

function assertAgentMayChangeStatus(actor: Actor, existing: Task, status: Status) {
  if (actor.kind !== "agent" || status === existing.status) return;
  if (existing.status === "backlog") {
    throw new BoardError("Agents cannot move tasks out of Backlog.");
  }
  if (existing.is_human) {
    throw new BoardError("Agents cannot change the status of a task marked human.");
  }
}

export async function createProject(
  supabase: Db,
  actor: Actor,
  input: { name: string; description?: string },
): Promise<Project> {
  if (actor.kind !== "user") throw new BoardError("Only people can create projects.");
  const name = input.name.trim();
  if (!name || name.length > 120) throw new BoardError("Give the project a name of 120 characters or fewer.");
  const description = input.description?.trim() ?? "";
  const { data: existing, error: existingError } = await supabase.from("projects").select("slug, sort_order");
  fail(existingError);
  const rows = (existing ?? []) as { slug: string; sort_order: number }[];
  const slug = uniqueSlug(slugify(name), rows.map((row) => row.slug));
  const sortOrder = rows.reduce((max, row) => Math.max(max, row.sort_order), 0) + 1;
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      slug,
      description,
      sort_order: sortOrder,
      created_by: actor.id,
    })
    .select("*")
    .single();
  fail(error);
  return data as Project;
}

export async function updateProject(
  supabase: Db,
  input: { id: string; name: string; description: string },
): Promise<Project> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new BoardError("Give the project a name of 120 characters or fewer.");
  const { data, error } = await supabase
    .from("projects")
    .update({ name, description: input.description.trim() })
    .eq("id", input.id)
    .select("*")
    .single();
  fail(error);
  return data as Project;
}

export async function deleteProject(supabase: Db, id: string) {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  fail(error);
}

async function columnEnd(supabase: Db, projectId: string, status: Status, exceptId?: string) {
  let query = supabase
    .from("tasks")
    .select("position")
    .eq("project_id", projectId)
    .eq("status", status)
    .order("position", { ascending: false })
    .limit(1);
  if (exceptId) query = query.neq("id", exceptId);
  const { data, error } = await query.maybeSingle();
  fail(error);
  const position = (data as { position: number } | null)?.position;
  return typeof position === "number" ? position + 1024 : 1024;
}

export async function createTask(
  supabase: Db,
  actor: Actor,
  input: {
    projectId: string;
    title: string;
    description?: string;
    status?: Status;
    isHuman?: boolean;
    url?: string | null;
    tags?: string[];
    assignee?: string | null;
    position?: number;
  },
): Promise<Task> {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new BoardError("Task title must be 1–200 characters.");
  const status = input.status ?? "todo";
  if (!isStatus(status)) throw new BoardError("Unknown status.");
  const isHuman = input.isHuman ?? false;
  if (actor.kind === "agent") {
    if (status === "backlog") {
      throw new BoardError("Agents cannot create Backlog tasks. A person parks work there.");
    }
    if (isHuman && status === "doing") {
      throw new BoardError("Agents cannot start a task marked human.");
    }
  }
  const assignee = parseAssignee(input.assignee);
  const description = input.description?.trim() ?? "";
  if (description.length > 20000) throw new BoardError("Description is too long.");
  const url = cleanUrl(input.url);
  const tags = normalizeTags(input.tags ?? []);
  const position =
    typeof input.position === "number" && Number.isFinite(input.position)
      ? input.position
      : await columnEnd(supabase, input.projectId, status);

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      project_id: input.projectId,
      title,
      description,
      status,
      is_human: isHuman,
      url,
      tags,
      position,
      assignee_user_id: assignee.userId,
      assignee_agent_id: assignee.agentId,
      created_by_user_id: actor.kind === "user" ? actor.id : null,
      created_by_agent_id: actor.kind === "agent" ? actor.id : null,
    })
    .select("*")
    .single();
  fail(error);
  const task = data as Task;
  await logEvent(supabase, {
    task_id: task.id,
    kind: "created",
    to_status: task.status,
    actor,
    meta: { title: task.title },
  });
  if (assignee.userId || assignee.agentId) {
    await logEvent(supabase, {
      task_id: task.id,
      kind: "assigned",
      actor,
      meta: { assignee: assigneeValue(assignee.userId, assignee.agentId) },
    });
  }
  return task;
}

export async function updateTask(
  supabase: Db,
  actor: Actor,
  input: {
    id: string;
    title?: string;
    description?: string;
    status?: Status;
    isHuman?: boolean;
    url?: string | null;
    tags?: string[];
    assignee?: string | null;
    position?: number;
  },
): Promise<Task> {
  const existing = await readTask(supabase, input.id);
  const title = input.title !== undefined ? input.title.trim() : existing.title;
  if (!title || title.length > 200) throw new BoardError("Task title must be 1–200 characters.");
  const description = input.description !== undefined ? input.description.trim() : existing.description;
  if (description.length > 20000) throw new BoardError("Description is too long.");
  const status = input.status ?? existing.status;
  if (!isStatus(status)) throw new BoardError("Unknown status.");
  assertAgentMayChangeStatus(actor, existing, status);
  const isHuman = input.isHuman ?? existing.is_human;
  if (actor.kind === "agent" && isHuman && status === "doing" && existing.status !== "doing") {
    throw new BoardError("Agents cannot start a task marked human.");
  }
  const assignee =
    input.assignee !== undefined
      ? parseAssignee(input.assignee)
      : { userId: existing.assignee_user_id, agentId: existing.assignee_agent_id };
  const url = input.url !== undefined ? cleanUrl(input.url) : existing.url;
  const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
  const position =
    typeof input.position === "number" && Number.isFinite(input.position)
      ? input.position
      : status !== existing.status
        ? await columnEnd(supabase, existing.project_id, status, existing.id)
        : existing.position;

  const { data, error } = await supabase
    .from("tasks")
    .update({
      title,
      description,
      status,
      is_human: isHuman,
      url,
      tags,
      position,
      assignee_user_id: assignee.userId,
      assignee_agent_id: assignee.agentId,
    })
    .eq("id", existing.id)
    .select("*")
    .single();
  fail(error);
  const task = data as Task;

  if (existing.status !== task.status) {
    await logEvent(supabase, {
      task_id: task.id,
      kind: "moved",
      from_status: existing.status,
      to_status: task.status,
      actor,
    });
  }
  if (
    existing.assignee_user_id !== task.assignee_user_id ||
    existing.assignee_agent_id !== task.assignee_agent_id
  ) {
    await logEvent(supabase, {
      task_id: task.id,
      kind: "assigned",
      actor,
      meta: { assignee: assigneeValue(task.assignee_user_id, task.assignee_agent_id) },
    });
  }
  const detailsChanged =
    existing.title !== task.title ||
    existing.description !== task.description ||
    existing.url !== task.url ||
    existing.is_human !== task.is_human ||
    existing.tags.join("\u0000") !== task.tags.join("\u0000");
  if (detailsChanged) {
    await logEvent(supabase, {
      task_id: task.id,
      kind: "updated",
      actor,
      meta: {
        title: existing.title !== task.title,
        description: existing.description !== task.description,
        url: existing.url !== task.url,
        is_human: existing.is_human !== task.is_human,
        tags: existing.tags.join("\u0000") !== task.tags.join("\u0000"),
      },
    });
  }
  return task;
}

export async function deleteTask(supabase: Db, id: string) {
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  fail(error);
}

export async function addComment(
  supabase: Db,
  actor: Actor,
  input: { taskId: string; body: string },
): Promise<Comment> {
  const body = input.body.trim();
  if (!body || body.length > 8000) throw new BoardError("Write a comment of 8000 characters or fewer.");
  await readTask(supabase, input.taskId);
  const { data, error } = await supabase
    .from("comments")
    .insert({
      task_id: input.taskId,
      body,
      author_user_id: actor.kind === "user" ? actor.id : null,
      author_agent_id: actor.kind === "agent" ? actor.id : null,
    })
    .select("*")
    .single();
  fail(error);
  const comment = data as Comment;
  await logEvent(supabase, {
    task_id: input.taskId,
    kind: "commented",
    actor,
    meta: { comment_id: comment.id },
  });
  return comment;
}

export async function setDependencies(supabase: Db, taskId: string, waitsOnIds: string[]) {
  const task = await readTask(supabase, taskId);
  const unique = [...new Set(waitsOnIds.filter((id) => id && id !== taskId))];
  for (const id of unique) {
    if (!isUuid(id)) throw new BoardError("A dependency id is not a uuid.");
  }
  if (unique.length > 0) {
    const { data, error } = await supabase.from("tasks").select("id, project_id").in("id", unique);
    fail(error);
    const rows = (data ?? []) as { id: string; project_id: string }[];
    if (rows.length !== unique.length || rows.some((row) => row.project_id !== task.project_id)) {
      throw new BoardError("A task can only wait on another task in the same project.");
    }
  }
  const { error: deleteError } = await supabase.from("task_dependencies").delete().eq("task_id", taskId);
  fail(deleteError);
  if (unique.length > 0) {
    const { error } = await supabase.from("task_dependencies").insert(
      unique.map((id) => ({ task_id: taskId, waits_on_task_id: id })),
    );
    fail(error);
  }
  const { error: touchError } = await supabase
    .from("tasks")
    .update({ position: task.position })
    .eq("id", taskId);
  fail(touchError);
}

export async function resolveProject(supabase: Db, project: string): Promise<Project> {
  const query = supabase.from("projects").select("*");
  const { data, error } = isUuid(project)
    ? await query.eq("id", project).maybeSingle()
    : await query.eq("slug", project).maybeSingle();
  fail(error);
  if (!data) throw new BoardError(`No project matches "${project}".`);
  return data as Project;
}
