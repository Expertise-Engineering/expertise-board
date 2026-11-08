import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { taskMatches } from "../board/filters.ts";
import { placeTask } from "../board/order.ts";
import type { Task } from "../types.ts";
import {
  CORY_EMAIL,
  CORY_USER_ID,
  LAST_EXECUTIVE_ERROR,
  accessOnSignup,
  activeExecutiveCount,
  canAdminister,
  canSeeProject,
  personStatus,
  planDirectoryAction,
  realtimeSubscriptions,
  resolveProjectClassChange,
  resolveProjectClassForWrite,
  directoryRoleForSession,
  sessionAccess,
  taskMoveWrite,
  visibleWorkspace,
  type DirectoryRecord,
} from "./access.ts";

const REGULAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXECUTIVE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PERSON = "44444444-4444-4444-8444-444444444444";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: REGULAR,
    number: 1,
    title: "Wire the intake form",
    description: "Customer portal",
    status: "todo",
    is_human: false,
    url: null,
    tags: ["portal"],
    position: 1024,
    assignee_user_id: PERSON,
    assignee_agent_id: null,
    created_by_user_id: null,
    created_by_agent_id: null,
    created_at: "2026-11-08T00:00:00.000Z",
    updated_at: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

const projects = [
  { id: REGULAR, name: "Northwind", access_class: "user" as const },
  { id: EXECUTIVE, name: "Quiet account", access_class: "executive" as const },
];

const secret = task({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  project_id: EXECUTIVE,
  title: "Secret launch plan",
  description: "Executive only",
  tags: ["quiet"],
});

const visible = task({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project_id: REGULAR,
  title: "Call the buyer",
});

function workspace(viewer: { kind: "executive" } | { kind: "user" } | { kind: "agent" } | { kind: "revoked" }) {
  return visibleWorkspace({
    viewer,
    projects,
    tasks: [visible, secret],
    dependencies: [
      { task_id: visible.id, waits_on_task_id: secret.id },
      { task_id: visible.id, waits_on_task_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { task_id: secret.id, waits_on_task_id: visible.id },
    ],
  });
}

test("regular users and agents cannot see executive projects", () => {
  assert.equal(canSeeProject({ kind: "user" }, "executive"), false);
  assert.equal(canSeeProject({ kind: "user" }, "user"), true);
  assert.equal(canSeeProject({ kind: "agent" }, "executive"), false);
  assert.equal(canSeeProject({ kind: "agent" }, "user"), true);
  assert.equal(canSeeProject({ kind: "executive" }, "executive"), true);
  assert.equal(canSeeProject({ kind: "revoked" }, "user"), false);
  assert.equal(canAdminister({ kind: "executive" }), true);
  assert.equal(canAdminister({ kind: "user" }), false);
  assert.equal(canAdminister({ kind: "agent" }), false);
});

test("all-projects search, assignee, and waits-on do not leak executive tasks", () => {
  const regular = workspace({ kind: "user" });
  assert.deepEqual(regular.projects.map((project) => project.id), [REGULAR]);
  assert.deepEqual(regular.tasks.map((item) => item.id), [visible.id]);
  assert.deepEqual(regular.dependencies, []);

  const filters = {
    query: "secret launch",
    status: "all" as const,
    tag: "all",
    human: "all" as const,
    assignee: `user:${PERSON}`,
  };
  const leaked = regular.tasks.filter((item) => taskMatches(item, filters, "Quiet account"));
  assert.equal(leaked.length, 0);
  assert.equal(
    regular.tasks.some((item) => item.project_id === EXECUTIVE || item.title === secret.title),
    false,
  );

  const executive = workspace({ kind: "executive" });
  assert.equal(executive.tasks.length, 2);
  assert.equal(executive.tasks.filter((item) => taskMatches(item, filters, "Quiet account")).length, 1);
  assert.equal(
    executive.dependencies.some((dependency) => dependency.waits_on_task_id === secret.id),
    true,
  );

  const agent = workspace({ kind: "agent" });
  assert.deepEqual(agent.tasks.map((item) => item.id), [visible.id]);
});

test("placing or moving a card does not change project or escalate class", () => {
  const original = task({ project_id: REGULAR, status: "todo", position: 1024 });
  const placed = placeTask(original, "doing", 2048);
  assert.equal(placed.project_id, original.project_id);
  assert.equal(placed.status, "doing");

  const write = taskMoveWrite(original, "doing", 2048);
  assert.deepEqual(Object.keys(write).sort(), ["id", "position", "status"]);
  assert.equal("project_id" in write, false);
  assert.equal("access_class" in write, false);
  assert.equal(write.id, original.id);

  const created = resolveProjectClassForWrite({ kind: "user" }, "executive");
  assert.equal(created.ok, false);
  const regularCreate = resolveProjectClassForWrite({ kind: "user" }, undefined);
  assert.deepEqual(regularCreate, { ok: true, accessClass: "user" });
  const executiveCreate = resolveProjectClassForWrite({ kind: "executive" }, "executive");
  assert.deepEqual(executiveCreate, { ok: true, accessClass: "executive" });
  assert.equal(resolveProjectClassForWrite({ kind: "agent" }, "user").ok, false);

  const escalated = resolveProjectClassChange({ kind: "user" }, "user", "executive");
  assert.equal(escalated.ok, false);
  const untouched = resolveProjectClassChange({ kind: "user" }, "user", undefined);
  assert.deepEqual(untouched, { ok: true, accessClass: "user" });
  const marked = resolveProjectClassChange({ kind: "executive" }, "user", "executive");
  assert.deepEqual(marked, { ok: true, accessClass: "executive" });
});

test("open company signup is regular, and removal blocks the next sign-in", () => {
  assert.deepEqual(accessOnSignup(null), { ok: true, role: "user" });
  assert.deepEqual(accessOnSignup({ role: "executive", revokedAt: null }), { ok: true, role: "executive" });
  assert.deepEqual(accessOnSignup({ role: "user", revokedAt: "2026-11-08T00:00:00.000Z" }), {
    ok: false,
    reason: "removed",
  });
  assert.deepEqual(sessionAccess(null), { state: "missing" });
  assert.deepEqual(sessionAccess({ role: "executive", revokedAt: null }), { state: "active", role: "executive" });
  assert.deepEqual(sessionAccess({ role: "user", revokedAt: "2026-11-08T00:00:00.000Z" }), { state: "removed" });
  assert.equal(personStatus({ userId: null, revokedAt: null }), "Invited");
  assert.equal(personStatus({ userId: CORY_USER_ID, revokedAt: null }), "Active");
  assert.equal(personStatus({ userId: CORY_USER_ID, revokedAt: "2026-11-08T00:00:00.000Z" }), "Removed");
});

test("admin can add, retitle roles, remove, and restore, but not lock out the last executive", () => {
  const people: DirectoryRecord[] = [
    { email: CORY_EMAIL, role: "executive", revokedAt: null },
    { email: "ada@exp-eng.com", role: "user", revokedAt: null },
  ];
  const executive = { kind: "executive" as const };
  const regular = { kind: "user" as const };

  assert.equal(planDirectoryAction(regular, people, { type: "add", email: "new@exp-eng.com", role: "user" }).ok, false);
  assert.equal(
    planDirectoryAction(executive, people, { type: "add", email: "outsider@example.com", role: "executive" }).ok,
    false,
  );

  const added = planDirectoryAction(executive, people, { type: "add", email: "New@exp-eng.com", role: "executive" });
  assert.deepEqual(added, { ok: true, email: "new@exp-eng.com", role: "executive", revoked: false });

  const restored = planDirectoryAction(
    executive,
    [...people, { email: "old@exp-eng.com", role: "user", revokedAt: "2026-11-08T00:00:00.000Z" }],
    { type: "add", email: "old@exp-eng.com", role: "executive" },
  );
  assert.deepEqual(restored, { ok: true, email: "old@exp-eng.com", role: "executive", revoked: false });

  assert.equal(planDirectoryAction(executive, people, { type: "set-role", email: CORY_EMAIL, role: "user" }).ok, false);
  assert.match(
    (planDirectoryAction(executive, people, { type: "remove", email: CORY_EMAIL }) as { error: string }).error,
    new RegExp(LAST_EXECUTIVE_ERROR),
  );

  const withPeer: DirectoryRecord[] = [...people, { email: "bea@exp-eng.com", role: "executive", revokedAt: null }];
  assert.equal(activeExecutiveCount(withPeer), 2);
  const demoted = planDirectoryAction(executive, withPeer, { type: "set-role", email: CORY_EMAIL, role: "user" });
  assert.deepEqual(demoted, { ok: true, email: CORY_EMAIL, role: "user", revoked: false });
  const removed = planDirectoryAction(executive, withPeer, { type: "remove", email: "ada@exp-eng.com" });
  assert.deepEqual(removed, { ok: true, email: "ada@exp-eng.com", role: "user", revoked: true });
  const back = planDirectoryAction(
    executive,
    [{ email: "ada@exp-eng.com", role: "user", revokedAt: "2026-11-08T00:00:00.000Z" }],
    { type: "restore", email: "ada@exp-eng.com" },
  );
  assert.deepEqual(back, { ok: true, email: "ada@exp-eng.com", role: "user", revoked: false });
});

test("realtime subscriptions listen to a tick, not task rows", () => {
  const regular = realtimeSubscriptions({ kind: "user" });
  assert.deepEqual(regular, [{ table: "board_ticks", filter: "scope=eq.regular" }]);
  assert.equal(regular.some((item) => item.table === "board_ticks" && item.filter?.includes("executive")), false);
  assert.deepEqual(realtimeSubscriptions({ kind: "executive" }), [{ table: "board_ticks" }]);
  assert.equal(realtimeSubscriptions({ kind: "revoked" })[0]?.filter, "scope=eq.none");
});

test("a missing directory row stays a regular user", () => {
  assert.deepEqual(directoryRoleForSession(null), { removed: false, role: "user" });
  assert.deepEqual(directoryRoleForSession({ role: "executive", revokedAt: null }), {
    removed: false,
    role: "executive",
  });
  assert.deepEqual(directoryRoleForSession({ role: "user", revokedAt: "2026-11-08T00:00:00.000Z" }), {
    removed: true,
  });
});

test("access migration stores roles in directory, seeds Cory, and does not trust user metadata", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const migrations = readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  const accessMigration = migrations.find((name) => name.includes("access_classes"));
  assert.ok(accessMigration, "expected an access_classes migration");
  const sql = readFileSync(join(root, "supabase/migrations", accessMigration), "utf8");

  assert.match(sql, new RegExp(CORY_EMAIL.replace(".", "\\.")));
  assert.match(sql, new RegExp(CORY_USER_ID));
  assert.match(sql, /create table public\.directory/i);
  assert.match(sql, /access_class text not null default 'user'/i);
  assert.match(sql, /access_class = 'user'/i);
  assert.match(sql, /private\.member_role/i);
  assert.doesNotMatch(sql, /user_metadata|raw_user_meta_data|raw_app_meta_data/i);
  assert.doesNotMatch(sql, /create\s+(or\s+replace\s+)?view/i);
  assert.doesNotMatch(
    sql,
    /create\s+(or\s+replace\s+)?function\s+public\.[a-z0-9_]+\s*\([^;]*?\)\s*returns[\s\S]{0,240}?security\s+definer/i,
  );
  assert.match(sql, /security definer/i);
  assert.match(sql, /function private\.assign_row_project\(\)[\s\S]*?security invoker/i);
  assert.match(sql, /before insert or update on public\.comments/i);
  assert.match(sql, /set search_path = ''/i);
});
