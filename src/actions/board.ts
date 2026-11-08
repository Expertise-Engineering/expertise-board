"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/session";
import type { ProjectClass } from "@/lib/access/access";
import {
  addComment,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  setDependencies,
  setProjectClass,
  updateProject,
  updateTask,
} from "@/lib/board/mutate";
import { loadTaskThread } from "@/lib/board/load";
import { actionError } from "@/lib/http/action-error";
import type { Comment, Project, Status, Task, TaskEvent } from "@/lib/types";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function finish<T>(data: T): ActionResult<T> {
  revalidatePath("/", "layout");
  return { ok: true, data };
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return finish(await work());
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}

export async function createProjectAction(input: {
  name: string;
  description: string;
  accessClass?: ProjectClass;
}): Promise<ActionResult<Project>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return createProject(supabase, actor, input);
  });
}

export async function updateProjectAction(input: {
  id: string;
  name: string;
  description: string;
  accessClass?: ProjectClass;
}): Promise<ActionResult<Project>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return updateProject(supabase, actor, input);
  });
}

export async function setProjectClassAction(input: {
  id: string;
  accessClass: ProjectClass;
}): Promise<ActionResult<Project>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return setProjectClass(supabase, actor, input);
  });
}

export async function deleteProjectAction(id: string): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    await deleteProject(supabase, actor, id);
    return { id };
  });
}

export async function createTaskAction(input: {
  projectId: string;
  title: string;
  description: string;
  status: Status;
  isHuman: boolean;
  url: string;
  tags: string;
  assignee: string;
}): Promise<ActionResult<Task>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return createTask(supabase, actor, {
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status,
      isHuman: input.isHuman,
      url: input.url,
      tags: input.tags.split(","),
      assignee: input.assignee,
    });
  });
}

export async function updateTaskAction(input: {
  id: string;
  title: string;
  description: string;
  url: string;
  tags: string;
  waitsOn: string[];
}): Promise<ActionResult<Task>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    const task = await updateTask(supabase, actor, {
      id: input.id,
      title: input.title,
      description: input.description,
      url: input.url,
      tags: input.tags.split(","),
    });
    await setDependencies(supabase, actor, task.id, input.waitsOn);
    return task;
  });
}

export async function patchTaskAction(input: {
  id: string;
  status?: Status;
  isHuman?: boolean;
  assignee?: string;
  position?: number;
}): Promise<ActionResult<Task>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return updateTask(supabase, actor, input);
  });
}

export async function deleteTaskAction(id: string): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    await deleteTask(supabase, actor, id);
    return { id };
  });
}

export async function addCommentAction(input: {
  taskId: string;
  body: string;
}): Promise<ActionResult<Comment>> {
  return run(async () => {
    const { supabase, actor } = await requireActor();
    return addComment(supabase, actor, input);
  });
}

export async function loadThreadAction(taskId: string): Promise<
  ActionResult<{ comments: Comment[]; events: TaskEvent[] }>
> {
  try {
    await requireActor();
    return { ok: true, data: await loadTaskThread(taskId) };
  } catch (error) {
    return { ok: false, error: actionError(error) };
  }
}
