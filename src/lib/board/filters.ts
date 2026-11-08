import type { Status, Task, TaskDependency } from "../types.ts";

export type TaskFilters = {
  query: string;
  status: Status | "all";
  tag: string;
  human: "all" | "human" | "agent";
  assignee: string;
};

export const EMPTY_FILTERS: TaskFilters = {
  query: "",
  status: "all",
  tag: "all",
  human: "all",
  assignee: "all",
};

export function taskMatches(task: Task, filters: TaskFilters, projectName = ""): boolean {
  if (filters.status !== "all" && task.status !== filters.status) return false;
  if (filters.tag !== "all" && !task.tags.includes(filters.tag)) return false;
  if (filters.human === "human" && !task.is_human) return false;
  if (filters.human === "agent" && task.is_human) return false;
  if (filters.assignee === "unassigned" && (task.assignee_user_id || task.assignee_agent_id)) {
    return false;
  }
  if (filters.assignee.startsWith("user:") && task.assignee_user_id !== filters.assignee.slice(5)) {
    return false;
  }
  if (filters.assignee.startsWith("agent:") && task.assignee_agent_id !== filters.assignee.slice(6)) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = `${task.title}\n${task.description}\n${task.tags.join(" ")}\n${projectName}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

export function sameProjectTasks<T extends Pick<Task, "id" | "project_id">>(
  task: Pick<Task, "id" | "project_id">,
  tasks: T[],
): T[] {
  return tasks.filter((item) => item.id !== task.id && item.project_id === task.project_id);
}

export function isWaiting(
  taskId: string,
  tasks: Pick<Task, "id" | "status">[],
  dependencies: TaskDependency[],
): boolean {
  return dependencies.some((dependency) => {
    if (dependency.task_id !== taskId) return false;
    const blocker = tasks.find((task) => task.id === dependency.waits_on_task_id);
    return !blocker || blocker.status !== "done";
  });
}

export function waitingOn(
  taskId: string,
  dependencies: TaskDependency[],
): string[] {
  return dependencies
    .filter((dependency) => dependency.task_id === taskId)
    .map((dependency) => dependency.waits_on_task_id);
}
