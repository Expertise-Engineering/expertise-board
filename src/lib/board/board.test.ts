import assert from "node:assert/strict";
import test from "node:test";
import { isWaiting, sameProjectTasks, taskMatches } from "./filters.ts";
import { nextPosition, placeTask } from "./order.ts";
import { errorMessage, normalizeTags, postgrestIlikeOr, slugify, uniqueSlug } from "./text.ts";
import type { Task } from "../types.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    number: 1,
    title: "Wire the intake form",
    description: "Customer portal",
    status: "todo",
    is_human: false,
    url: null,
    tags: ["portal"],
    position: 1024,
    assignee_user_id: null,
    assignee_agent_id: null,
    created_by_user_id: null,
    created_by_agent_id: null,
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

test("slug stays readable and unique", () => {
  assert.equal(slugify("  Acme Intake! "), "acme-intake");
  assert.equal(uniqueSlug("acme", ["acme", "acme-2"]), "acme-3");
});

test("tags are lowercase, unique, and punctuation-free", () => {
  assert.deepEqual(normalizeTags(["Portal", "portal", "Q1 Launch", ""]), ["portal", "q1", "launch"]);
});

test("filters combine status, human, assignee, tag, and text", () => {
  const human = task({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Call the buyer",
    is_human: true,
    status: "backlog",
    tags: ["sales"],
    assignee_user_id: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal(taskMatches(human, { query: "buyer", status: "all", tag: "all", human: "human", assignee: "all" }), true);
  assert.equal(taskMatches(human, { query: "", status: "todo", tag: "all", human: "all", assignee: "all" }), false);
  assert.equal(
    taskMatches(human, {
      query: "",
      status: "all",
      tag: "all",
      human: "all",
      assignee: "user:44444444-4444-4444-8444-444444444444",
    }),
    true,
  );
  assert.equal(taskMatches(task(), { query: "missing", status: "all", tag: "all", human: "agent", assignee: "unassigned" }), false);
});

test("assignee filter spans projects, and search can name the customer", () => {
  const cory = "44444444-4444-4444-8444-444444444444";
  const acme = task({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Wire the intake form",
    assignee_user_id: cory,
  });
  const northwind = task({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    title: "Fix the invoice",
    assignee_user_id: cory,
    tags: [],
  });
  const other = task({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Call the buyer",
    assignee_user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  const filters = { query: "", status: "all" as const, tag: "all", human: "all" as const, assignee: `user:${cory}` };
  assert.equal(taskMatches(acme, filters), true);
  assert.equal(taskMatches(northwind, filters), true);
  assert.equal(taskMatches(other, filters), false);
  assert.equal(taskMatches(northwind, { ...filters, assignee: "all", query: "northwind" }, "Northwind"), true);
  assert.equal(taskMatches(northwind, { ...filters, assignee: "all", query: "northwind" }), false);
  assert.deepEqual(
    sameProjectTasks(acme, [acme, northwind, other]).map((item) => item.id),
    [other.id],
  );
});

test("moving a card keeps its project", () => {
  const original = task({ project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "todo", position: 1024 });
  const moved = placeTask(original, "doing", 2048);
  assert.equal(moved.status, "doing");
  assert.equal(moved.position, 2048);
  assert.equal(moved.project_id, original.project_id);
  assert.equal(moved.id, original.id);
});

test("waiting ignores finished blockers", () => {
  const tasks = [
    task({ id: "a", status: "doing" }),
    task({ id: "b", status: "done" }),
  ];
  assert.equal(isWaiting("a", tasks, [{ task_id: "a", waits_on_task_id: "b" }]), false);
  assert.equal(isWaiting("a", tasks, [{ task_id: "a", waits_on_task_id: "missing" }]), true);
});

test("driver errors stay off the message returned to the browser", () => {
  assert.equal(
    errorMessage(new Error('duplicate key value violates unique constraint "agents_name_key"')),
    "An agent with that name already exists.",
  );
  assert.equal(
    errorMessage(new Error("new row violates row-level security policy")),
    "You do not have access to that.",
  );
  assert.equal(
    errorMessage(new Error("insert or update on table \"comments\" violates foreign key constraint")),
    "Something went wrong.",
  );
  assert.equal(errorMessage(new Error("Task title must be 1–200 characters.")), "Task title must be 1–200 characters.");
  assert.equal(
    postgrestIlikeOr(["title", "description"], '100% "done", (a)'),
    'title.ilike."%100\\% done a%",description.ilike."%100\\% done a%"',
  );
});

test("positions land before a card or at the end", () => {
  const column = [
    { id: "a", position: 100 },
    { id: "b", position: 300 },
  ];
  assert.equal(nextPosition(column, null), 1324);
  assert.equal(nextPosition(column, "a"), -924);
  assert.equal(nextPosition(column, "b"), 200);
});
