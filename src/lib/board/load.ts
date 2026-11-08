import "server-only";

import { cache } from "react";
import { normalizeRole, visibleWorkspace, type Viewer } from "@/lib/access/access";
import { loadOwnAccess } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { Agent, Comment, Profile, Project, SessionProfile, Task, TaskDependency, TaskEvent } from "@/lib/types";

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

const projectColumns = "id, name, slug, description, access_class, sort_order, created_at, created_by";

export const loadDirectory = cache(async (userId: string) => {
  const supabase = await createClient();
  const [profileResult, access, projectsResult, profilesResult, agentsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, display_name, created_at, revoked_at")
      .eq("id", userId)
      .maybeSingle(),
    loadOwnAccess(userId),
    supabase
      .from("projects")
      .select(projectColumns)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, email, display_name, created_at, revoked_at")
      .order("display_name", { ascending: true }),
    supabase
      .from("agents")
      .select("id, name, revoked_at, created_by, created_at")
      .order("name", { ascending: true }),
  ]);

  const profileRow = unwrap(profileResult, null) as Profile | null;
  const role = access ? normalizeRole(access.role) : "user";
  const revokedAt = access ? access.revoked_at : (profileRow?.revoked_at ?? null);
  const profile: SessionProfile | null = profileRow
    ? { ...profileRow, revoked_at: revokedAt, role }
    : null;

  return {
    profile,
    projects: unwrap(projectsResult, []) as Project[],
    profiles: unwrap(profilesResult, []) as Profile[],
    agents: unwrap(agentsResult, []) as Agent[],
  };
});

export type AccessPerson = {
  email: string;
  role: "executive" | "user";
  revoked_at: string | null;
  user_id: string | null;
  display_name: string | null;
  created_at: string;
};

export async function loadAccessDirectory(): Promise<AccessPerson[]> {
  const supabase = await createClient();
  const [directoryResult, profilesResult] = await Promise.all([
    supabase.from("directory").select("email, role, revoked_at, user_id, created_at").order("email", { ascending: true }),
    supabase.from("profiles").select("id, email, display_name"),
  ]);
  const rows = unwrap(directoryResult, []) as {
    email: string;
    role: string;
    revoked_at: string | null;
    user_id: string | null;
    created_at: string;
  }[];
  const profiles = unwrap(profilesResult, []) as { id: string; email: string; display_name: string }[];
  const byEmail = new Map(profiles.map((profile) => [profile.email, profile.display_name]));
  const byId = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  return rows.map((row) => ({
    email: row.email,
    role: normalizeRole(row.role),
    revoked_at: row.revoked_at,
    user_id: row.user_id,
    display_name: (row.user_id ? byId.get(row.user_id) : null) ?? byEmail.get(row.email) ?? null,
    created_at: row.created_at,
  }));
}

export async function loadCompanyBoard(viewer: Viewer, projects: Project[]) {
  const supabase = await createClient();
  const [taskResult, dependencyResult] = await Promise.all([
    supabase.from("tasks").select("*").order("position", { ascending: true }),
    supabase.from("task_dependencies").select("task_id, waits_on_task_id"),
  ]);
  return visibleWorkspace({
    viewer,
    projects,
    tasks: unwrap(taskResult, []) as Task[],
    dependencies: unwrap(dependencyResult, []) as TaskDependency[],
  });
}

export async function loadProjectBoard(slug: string, viewer: Viewer) {
  const supabase = await createClient();
  const projectResult = await supabase.from("projects").select(projectColumns).eq("slug", slug).maybeSingle();
  const project = unwrap(projectResult, null) as Project | null;
  if (!project) return null;

  const visibleProject = visibleWorkspace({
    viewer,
    projects: [project],
    tasks: [],
    dependencies: [],
  }).projects[0];
  if (!visibleProject) return null;

  const taskResult = await supabase
    .from("tasks")
    .select("*")
    .eq("project_id", visibleProject.id)
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
  const visible = visibleWorkspace({
    viewer,
    projects: [visibleProject],
    tasks,
    dependencies,
  });
  return { project: visibleProject, tasks: visible.tasks, dependencies: visible.dependencies };
}

export async function loadTaskThread(taskId: string) {
  const supabase = await createClient();
  const taskResult = await supabase.from("tasks").select("id").eq("id", taskId).maybeSingle();
  if (taskResult.error) throw new Error(explain(taskResult.error.message));
  if (!taskResult.data) throw new Error("Task not found.");
  const [commentsResult, eventsResult] = await Promise.all([
    supabase.from("comments").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
    supabase.from("task_events").select("*").eq("task_id", taskId).order("created_at", { ascending: true }),
  ]);
  return {
    comments: unwrap(commentsResult, []) as Comment[],
    events: unwrap(eventsResult, []) as TaskEvent[],
  };
}
