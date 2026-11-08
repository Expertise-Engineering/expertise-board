export const STATUSES = ["backlog", "todo", "doing", "review", "done"] as const;

export type Status = (typeof STATUSES)[number];

export type Profile = {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
};

export type Agent = {
  id: string;
  name: string;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
  created_at: string;
  created_by: string | null;
};

export type Task = {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  is_human: boolean;
  url: string | null;
  tags: string[];
  position: number;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string;
  task_id: string;
  body: string;
  author_user_id: string | null;
  author_agent_id: string | null;
  created_at: string;
};

export type TaskEventKind = "created" | "moved" | "assigned" | "commented" | "updated";

export type TaskEvent = {
  id: string;
  task_id: string;
  kind: TaskEventKind;
  from_status: Status | null;
  to_status: Status | null;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export type TaskDependency = {
  task_id: string;
  waits_on_task_id: string;
};

export type Actor =
  | { kind: "user"; id: string; name: string }
  | { kind: "agent"; id: string; name: string };
