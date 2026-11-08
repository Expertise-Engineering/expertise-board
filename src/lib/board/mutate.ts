import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canSeeProject,
  resolveProjectClassChange,
  resolveProjectClassForWrite,
  viewerFromRole,
  type ProjectClass,
  type Viewer,
} from "@/lib/access/access";
import type { Actor, Comment, Project, Status, Task } from "@/lib/types";
import {
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

function viewerFor(actor: Actor): Viewer {
  if (actor.kind === "agent") return { kind: "agent" };
  return viewerFromRole(actor.role, null);
}

async function readVisibleProject(supabase: Db, id: string, actor: Actor): Promise<Project> {
  if (!isUuid(id)) throw new BoardError("Project id is not a uuid.");
  const { data, error } = await supabase.from("projects").select("*").eq("id", id).maybeSingle();
  fail(error);
  const project = (data as Project | null) ?? null;
  if (!project || !isProjectClass(project.access_class) || !canSeeProject(viewerFor(actor), project.access_class)) {
    throw new BoardError("Project not found.");
  }
  return project;
}

function isProjectClass(value: unknown): value is ProjectClass {
  return value === "executive" || value === "user";
}

function writer(actor: Actor) {
  return {
    p_agent_id: actor.kind === "agent" ? actor.id : null,
    p_actor_name: actor.name,
  };
}

async function readTask(supabase: Db, id: string, actor: Actor): Promise<Task> {
  if (!isUuid(id)) throw new BoardError("Task id is not a uuid.");
  const { data, error } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  fail(error);
  if (!data) throw new BoardError("Task not found.");
  const task = data as Task;
  const project = await readVisibleProject(supabase, task.project_id, actor).catch((error: unknown) => {
    if (error instanceof BoardError) throw new BoardError("Task not found.");
    throw error;
  });
  if (project.id !== task.project_id) throw new BoardError("Task not found.");
  return task;
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
  input: { name: string; description?: string; accessClass?: ProjectClass },
): Promise<Project> {
  const classResult = resolveProjectClassForWrite(viewerFor(actor), input.accessClass);
  if (!classResult.ok) throw new BoardError(classResult.error);
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
      access_class: classResult.accessClass,
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
  actor: Actor,
  input: { id: string; name: string; description: string; accessClass?: ProjectClass },
): Promise<Project> {
  const existing = await readVisibleProject(supabase, input.id, actor);
  const classResult = resolveProjectClassChange(viewerFor(actor), existing.access_class, input.accessClass);
  if (!classResult.ok) throw new BoardError(classResult.error);
  const name = input.name.trim();
  if (!name || name.length > 120) throw new BoardError("Give the project a name of 120 characters or fewer.");
  const { data, error } = await supabase
    .from("projects")
    .update({
      name,
      description: input.description.trim(),
      access_class: classResult.accessClass,
    })
    .eq("id", existing.id)
    .select("*")
    .single();
  fail(error);
  return data as Project;
}

export async function setProjectClass(
  supabase: Db,
  actor: Actor,
  input: { id: string; accessClass: ProjectClass },
): Promise<Project> {
  const existing = await readVisibleProject(supabase, input.id, actor);
  const classResult = resolveProjectClassChange(viewerFor(actor), existing.access_class, input.accessClass);
  if (!classResult.ok) throw new BoardError(classResult.error);
  const { data, error } = await supabase
    .from("projects")
    .update({ access_class: classResult.accessClass })
    .eq("id", existing.id)
    .select("*")
    .single();
  fail(error);
  return data as Project;
}

export async function deleteProject(supabase: Db, actor: Actor, id: string) {
  const existing = await readVisibleProject(supabase, id, actor);
  const { error } = await supabase.from("projects").delete().eq("id", existing.id);
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
  await readVisibleProject(supabase, input.projectId, actor);
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

  const { data, error } = await supabase.rpc("create_board_task", {
    ...writer(actor),
    p_project_id: input.projectId,
    p_title: title,
    p_description: description,
    p_status: status,
    p_is_human: isHuman,
    p_url: url,
    p_tags: tags,
    p_position: position,
    p_assignee_user_id: assignee.userId,
    p_assignee_agent_id: assignee.agentId,
  });
  fail(error);
  if (!data) throw new BoardError("Task not found.");
  return data as Task;
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
  const extra = input as { projectId?: unknown; project_id?: unknown; accessClass?: unknown };
  if (extra.projectId !== undefined || extra.project_id !== undefined || extra.accessClass !== undefined) {
    throw new BoardError("A task cannot change project.");
  }
  const existing = await readTask(supabase, input.id, actor);
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

  const { data, error } = await supabase.rpc("update_board_task", {
    ...writer(actor),
    p_task_id: existing.id,
    p_title: title,
    p_description: description,
    p_status: status,
    p_is_human: isHuman,
    p_url: url,
    p_tags: tags,
    p_position: position,
    p_assignee_user_id: assignee.userId,
    p_assignee_agent_id: assignee.agentId,
  });
  fail(error);
  if (!data) throw new BoardError("Task not found.");
  return data as Task;
}

export async function deleteTask(supabase: Db, actor: Actor, id: string) {
  const existing = await readTask(supabase, id, actor);
  const { error } = await supabase.from("tasks").delete().eq("id", existing.id);
  fail(error);
}

export async function addComment(
  supabase: Db,
  actor: Actor,
  input: { taskId: string; body: string },
): Promise<Comment> {
  const body = input.body.trim();
  if (!body || body.length > 8000) throw new BoardError("Write a comment of 8000 characters or fewer.");
  await readTask(supabase, input.taskId, actor);
  const { data, error } = await supabase.rpc("add_board_comment", {
    ...writer(actor),
    p_task_id: input.taskId,
    p_body: body,
  });
  fail(error);
  if (!data) throw new BoardError("Task not found.");
  return data as Comment;
}

export async function setDependencies(supabase: Db, actor: Actor, taskId: string, waitsOnIds: string[]) {
  const task = await readTask(supabase, taskId, actor);
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
  const { error } = await supabase.rpc("replace_task_dependencies", {
    p_agent_id: actor.kind === "agent" ? actor.id : null,
    p_task_id: task.id,
    p_waits_on: unique,
  });
  fail(error);
}

export async function resolveProject(supabase: Db, actor: Actor, project: string): Promise<Project> {
  const query = supabase.from("projects").select("*");
  const { data, error } = isUuid(project)
    ? await query.eq("id", project).maybeSingle()
    : await query.eq("slug", project).maybeSingle();
  fail(error);
  const row = (data as Project | null) ?? null;
  if (!row || !isProjectClass(row.access_class) || !canSeeProject(viewerFor(actor), row.access_class)) {
    throw new BoardError(`No project matches "${project}".`);
  }
  return row;
}
