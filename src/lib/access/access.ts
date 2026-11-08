import { isAllowedEmail } from "../auth/email.ts";

export const ACCESS_ROLES = ["executive", "user"] as const;

export type AccessRole = (typeof ACCESS_ROLES)[number];

export const PROJECT_CLASSES = ["executive", "user"] as const;

export type ProjectClass = (typeof PROJECT_CLASSES)[number];

export const CORY_EMAIL = "cm@exp-eng.com";

export const CORY_USER_ID = "091c0a69-b662-40f8-9179-6d86c6c30b79";

export const LAST_EXECUTIVE_ERROR = "The last executive cannot be demoted or removed.";

export type Viewer =
  | { kind: "executive" }
  | { kind: "user" }
  | { kind: "agent" }
  | { kind: "revoked" };

export type DirectoryRecord = {
  email: string;
  role: AccessRole;
  revokedAt: string | null;
};

export type DirectoryPlan =
  | { ok: true; email: string; role: AccessRole; revoked: boolean }
  | { ok: false; error: string };

export type RealtimeSubscription = {
  table: "board_ticks";
  filter?: string;
};

/**
 * Missing directory stays a regular user. A revoked row is removed.
 * Decisions that must not trust a JWT alone should load the directory after getUser().
 */
export function directoryRoleForSession(
  row: { role: AccessRole; revokedAt: string | null } | null,
): { removed: true } | { removed: false; role: AccessRole } {
  const decision = sessionAccess(row);
  if (decision.state === "removed") return { removed: true };
  if (decision.state === "active") return { removed: false, role: decision.role };
  return { removed: false, role: "user" };
}

export function isAccessRole(value: unknown): value is AccessRole {
  return value === "executive" || value === "user";
}

export function isProjectClass(value: unknown): value is ProjectClass {
  return value === "executive" || value === "user";
}

export function normalizeRole(value: unknown): AccessRole {
  return value === "executive" ? "executive" : "user";
}

export function viewerFromRole(role: AccessRole, revokedAt: string | null | undefined): Viewer {
  if (revokedAt) return { kind: "revoked" };
  return role === "executive" ? { kind: "executive" } : { kind: "user" };
}

export function roleLabel(role: AccessRole): string {
  return role === "executive" ? "Executive" : "Regular";
}

export function projectClassLabel(accessClass: ProjectClass): string {
  return accessClass === "executive" ? "Executive" : "Regular";
}

export function personStatus(person: { userId: string | null; revokedAt: string | null }): "Active" | "Invited" | "Removed" {
  if (person.revokedAt) return "Removed";
  if (!person.userId) return "Invited";
  return "Active";
}

/**
 * Directory lookup result. Missing is not removed: a company email with no row
 * is still a regular user. Callers that sign someone in use directoryRoleForSession.
 */
export function sessionAccess(
  row: { role: AccessRole; revokedAt: string | null } | null,
): { state: "active"; role: AccessRole } | { state: "removed" } | { state: "missing" } {
  if (!row) return { state: "missing" };
  if (row.revokedAt) return { state: "removed" };
  return { state: "active", role: normalizeRole(row.role) };
}

/**
 * First login. No directory row becomes a regular user. A pre-assigned row
 * keeps its role. A removed row cannot sign up again until restored.
 */
export function accessOnSignup(
  existing: { role: AccessRole; revokedAt: string | null } | null,
): { ok: true; role: AccessRole } | { ok: false; reason: "removed" } {
  if (existing?.revokedAt) return { ok: false, reason: "removed" };
  return { ok: true, role: existing?.role ?? "user" };
}

export function canAdminister(viewer: Viewer): boolean {
  return viewer.kind === "executive";
}

export function canSeeProject(viewer: Viewer, accessClass: ProjectClass): boolean {
  if (viewer.kind === "executive") return true;
  if (viewer.kind === "user" || viewer.kind === "agent") return accessClass === "user";
  return false;
}

export function resolveProjectClassForWrite(
  viewer: Viewer,
  requested: ProjectClass | undefined,
): { ok: true; accessClass: ProjectClass } | { ok: false; error: string } {
  if (viewer.kind === "agent") {
    return { ok: false, error: "Only people can create projects." };
  }
  if (requested === "executive" && viewer.kind !== "executive") {
    return { ok: false, error: "Only an executive can create an executive project." };
  }
  if (viewer.kind !== "executive") return { ok: true, accessClass: "user" };
  return { ok: true, accessClass: requested ?? "user" };
}

export function resolveProjectClassChange(
  viewer: Viewer,
  current: ProjectClass,
  requested: ProjectClass | undefined,
): { ok: true; accessClass: ProjectClass } | { ok: false; error: string } {
  const next = requested ?? current;
  if (next === current) return { ok: true, accessClass: current };
  if (viewer.kind !== "executive") {
    return { ok: false, error: "Only an executive can change a project's class." };
  }
  return { ok: true, accessClass: next };
}

export function visibleWorkspace<
  TProject extends { id: string; access_class: ProjectClass },
  TTask extends { id: string; project_id: string },
  TDependency extends { task_id: string; waits_on_task_id: string },
>(input: {
  viewer: Viewer;
  projects: TProject[];
  tasks: TTask[];
  dependencies: TDependency[];
}): { projects: TProject[]; tasks: TTask[]; dependencies: TDependency[] } {
  const projects = input.projects.filter((project) => canSeeProject(input.viewer, project.access_class));
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = input.tasks.filter((task) => projectIds.has(task.project_id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const dependencies = input.dependencies.filter(
    (dependency) => taskIds.has(dependency.task_id) && taskIds.has(dependency.waits_on_task_id),
  );
  return { projects, tasks, dependencies };
}

/**
 * Dragging a card writes status and position only. project_id stays put, so a
 * move cannot carry a task into an executive project.
 */
export function taskMoveWrite(
  task: { id: string },
  status: string,
  position: number,
): { id: string; status: string; position: number } {
  return { id: task.id, status, position };
}

/**
 * Live updates are a clock row, not the task body. Regular members subscribe to
 * the regular tick. Row security hides the executive tick from them.
 */
export function realtimeSubscriptions(viewer: Viewer): RealtimeSubscription[] {
  if (viewer.kind === "executive") return [{ table: "board_ticks" }];
  if (viewer.kind === "user") return [{ table: "board_ticks", filter: "scope=eq.regular" }];
  return [{ table: "board_ticks", filter: "scope=eq.none" }];
}

export function activeExecutiveCount(people: readonly DirectoryRecord[]): number {
  return people.filter((person) => person.role === "executive" && person.revokedAt === null).length;
}

export function planDirectoryAction(
  viewer: Viewer,
  people: readonly DirectoryRecord[],
  action:
    | { type: "add"; email: string; role: AccessRole }
    | { type: "set-role"; email: string; role: AccessRole }
    | { type: "remove"; email: string }
    | { type: "restore"; email: string },
): DirectoryPlan {
  if (!canAdminister(viewer)) {
    return { ok: false, error: "Only an executive can change access." };
  }

  if (action.type === "add") {
    const email = normalizeDirectoryEmail(action.email);
    if (!email.ok) return email;
    const existing = people.find((person) => person.email === email.email);
    if (existing && existing.revokedAt === null) {
      return { ok: false, error: "That person is already on the board. Change their role instead." };
    }
    if (!isAccessRole(action.role)) {
      return { ok: false, error: "Choose executive or regular." };
    }
    return { ok: true, email: email.email, role: action.role, revoked: false };
  }

  const existing = people.find((person) => person.email === action.email);
  if (!existing) return { ok: false, error: "That person is not on the board." };

  if (action.type === "set-role") {
    if (!isAccessRole(action.role)) return { ok: false, error: "Choose executive or regular." };
    if (removesLastExecutive(people, existing, { role: action.role, revokedAt: existing.revokedAt })) {
      return { ok: false, error: LAST_EXECUTIVE_ERROR };
    }
    return { ok: true, email: existing.email, role: action.role, revoked: existing.revokedAt !== null };
  }

  if (action.type === "remove") {
    if (existing.revokedAt) return { ok: false, error: "That person is already removed." };
    if (removesLastExecutive(people, existing, { role: existing.role, revokedAt: existing.revokedAt ?? "removed" })) {
      return { ok: false, error: LAST_EXECUTIVE_ERROR };
    }
    return { ok: true, email: existing.email, role: existing.role, revoked: true };
  }

  if (!existing.revokedAt) return { ok: false, error: "That person is already active." };
  return { ok: true, email: existing.email, role: existing.role, revoked: false };
}

function removesLastExecutive(
  people: readonly DirectoryRecord[],
  current: DirectoryRecord,
  next: { role: AccessRole; revokedAt: string | null },
): boolean {
  const wasExecutive = current.role === "executive" && current.revokedAt === null;
  const staysExecutive = next.role === "executive" && next.revokedAt === null;
  if (!wasExecutive || staysExecutive) return false;
  return activeExecutiveCount(people) <= 1;
}

function normalizeDirectoryEmail(email: string): { ok: true; email: string } | { ok: false; error: string } {
  const normalized = email.trim().toLowerCase();
  if (!isAllowedEmail(normalized)) {
    return { ok: false, error: "Only @exp-eng.com addresses can be added." };
  }
  return { ok: true, email: normalized };
}
