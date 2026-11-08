import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Agent, Comment, Profile, Project, Task, TaskDependency, TaskEvent } from "@/lib/types";

function explain(message: string): string {
  if (/relation|schema cache|could not find the table/i.test(message)) {
    return `The database schema is not ready. Apply supabase/migrations, then reload. (${message})`;
  }
  return message;
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }, fallback: T): T {
  if (result.error) throw new Error(explain(result.error.message));
  return result.data ?? fallback;
}

export const loadDirectory = cache(async (userId: string) => {
  const supabase = await createClient();
  const [profileResult, projectsResult, profilesResult, agentsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, display_name, created_at")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("projects")
      .select("id, name, slug, description, sort_order, created_at, created_by")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, email, display_name, created_at")
      .order("display_name", { ascending: true }),
    supabase
      .from("agents")
      .select("id, name, revoked_at, created_by, created_at")
      .order("name", { ascending: true }),
  ]);

  return {
    profile: unwrap(profileResult, null) as Profile | null,
    projects: unwrap(projectsResult, []) as Project[],
    profiles: unwrap(profilesResult, []) as Profile[],
    agents: unwrap(agentsResult, []) as Agent[],
  };
});

export async function loadCompanyBoard() {
  const supabase = await createClient();
  const [taskResult, dependencyResult] = await Promise.all([
    supabase.from("tasks").select("*").order("position", { ascending: true }),
    supabase.from("task_dependencies").select("task_id, waits_on_task_id"),
  ]);
  return {
    tasks: unwrap(taskResult, []) as Task[],
    dependencies: unwrap(dependencyResult, []) as TaskDependency[],
  };
}

export async function loadProjectBoard(slug: string) {
  const supabase = await createClient();
  const projectResult = await supabase
    .from("projects")
    .select("id, name, slug, description, sort_order, created_at, created_by")
    .eq("slug", slug)
    .maybeSingle();
  const project = unwrap(projectResult, null) as Project | null;
  if (!project) return null;

  const taskResult = await supabase
    .from("tasks")
    .select("*")
    .eq("project_id", project.id)
    .order("position", { ascending: true });
  const tasks = unwrap(taskResult, []) as Task[];
  const ids = tasks.map((task) => task.id);
  let dependencies: TaskDependency[] = [];
  if (ids.length > 0) {
    const dependencyResult = await supabase
      .from("task_dependencies")
      .select("task_id, waits_on_task_id")
      .in("task_id", ids);
    dependencies = unwrap(dependencyResult, []) as TaskDependency[];
  }
  return { project, tasks, dependencies };
}

export async function loadTaskThread(taskId: string) {
  const supabase = await createClient();
  const [commentsResult, eventsResult] = await Promise.all([
    supabase.from("comments").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
    supabase.from("task_events").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
  ]);
  return {
    comments: unwrap(commentsResult, []) as Comment[],
    events: unwrap(eventsResult, []) as TaskEvent[],
  };
}
