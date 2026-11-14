import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const sql = readFileSync(
  join(root, "supabase/migrations/20261108200000_access_hardening.sql"),
  "utf8",
);

function functionBody(name: string): string {
  const marker = `function ${name}`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = sql.indexOf("\ncreate ", start + marker.length);
  const body = next === -1 ? sql.slice(start) : sql.slice(start, next);
  return body;
}

test("service-role executive writes use the JWT role, not session_user", () => {
  assert.doesNotMatch(sql, /session_user/);
  assert.match(sql, /auth\.role\(\)/);
  for (const name of [
    "private.reject_service_role_executive()",
    "private.guard_directory_access()",
    "private.assign_project_slug()",
  ]) {
    const body = functionBody(name);
    assert.match(body, /private\.request_role\(\)/);
    assert.doesNotMatch(body, /session_user/);
  }
  const reject = functionBody("private.reject_service_role_executive()");
  assert.match(reject, /request_role\(\) is distinct from 'service_role'/);
  assert.match(reject, /class is distinct from 'user'/);
  const guard = functionBody("private.guard_directory_access()");
  const lockAt = guard.indexOf("for update");
  const countAt = guard.indexOf("select count(*)");
  assert.ok(lockAt > 0 && countAt > lockAt, "active executives are locked before they are counted");
});

test("authenticated cannot read or write agents.key_hash", () => {
  assert.match(sql, /revoke insert, update, select, delete on table public\.agents from authenticated/i);
  const columnGrant = sql.match(/grant select \(([^)]+)\) on table public\.agents to authenticated/i);
  assert.ok(columnGrant, "expected a column select grant");
  assert.doesNotMatch(columnGrant[1] ?? "", /key_hash/);
  assert.doesNotMatch(sql, /grant update \([^)]*key_hash/i);
  assert.doesNotMatch(sql, /grant execute on function public\.issue_agent_key\(text, text, uuid\) to authenticated/i);
  assert.match(sql, /grant execute on function public\.issue_agent_key\(text, text, uuid\) to service_role/i);
  const issue = functionBody("private.issue_agent_key(");
  assert.match(issue, /security definer/);
  assert.match(issue, /request_role\(\) is distinct from 'service_role'/);
  assert.match(issue, /revoked_at is not null/);
  assert.doesNotMatch(issue, /is_executive\(\)/);
  assert.match(issue, /app\.issuing_agent_key/);
  assert.match(sql, /function public\.issue_agent_key\([\s\S]*?security invoker/);
});

test("comment and task authors are bound to the session", () => {
  const comment = functionBody("private.bind_comment_author()");
  assert.match(comment, /new\.author_user_id := auth\.uid\(\)/);
  assert.match(comment, /new\.author_agent_id is not null/);
  assert.match(comment, /Actor columns cannot be changed/);
  assert.match(comment, /app\.agent_id/);
  assert.match(comment, /pg_catalog\.pg_trigger_depth\(\) > 1/);
  const task = functionBody("private.bind_task_creator()");
  assert.match(task, /new\.created_by_user_id := auth\.uid\(\)/);
  assert.match(task, /new\.created_by_agent_id is not null/);
  assert.match(sql, /comments_one_author check/);
  assert.match(sql, /<= 1/);
  assert.doesNotMatch(sql, /user_metadata|raw_user_meta_data/);
});

test("agent task rules, atomic writes, ticks, and deletion history are in SQL", () => {
  const guard = functionBody("private.guard_agent_task_write()");
  assert.match(guard, /old\.is_human/);
  assert.match(guard, /old\.status = 'backlog'/);
  assert.match(guard, /new\.status = 'backlog'/);
  assert.match(sql, /function public\.create_board_task\(/);
  assert.match(sql, /function public\.replace_task_dependencies\(/);
  assert.match(sql, /function public\.claim_next_task\(/);
  assert.match(functionBody("public.claim_next_task("), /access_class = 'user'/);
  assert.match(functionBody("public.claim_next_task("), /app\.agent_id/);
  assert.match(sql, /create table public\.board_ticks/);
  const ticks = sql.slice(sql.indexOf("create table public.board_ticks"), sql.indexOf("comment on table public.board_ticks"));
  assert.doesNotMatch(ticks, /title|description|body/);
  assert.match(sql, /alter publication supabase_realtime drop table public\.tasks/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.board_ticks/i);
  const logStart = sql.indexOf("create table public.deletion_log");
  const log = sql.slice(logStart, sql.indexOf("comment on table public.deletion_log"));
  assert.doesNotMatch(log, /references public\.projects|references public\.tasks/i);
  assert.match(sql, /before delete on public\.projects/i);
  assert.match(sql, /before delete on public\.tasks/i);
});

test("agents create only regular projects, stamped by the database", () => {
  const applied = readFileSync(
    join(root, "supabase/migrations/20261114090000_agents_create_projects.sql"),
    "utf8",
  );
  assert.match(applied, /add column created_by_agent_id uuid references public\.agents/i);
  assert.match(applied, /Agents can only create regular projects/i);
  assert.match(applied, /new\.created_by := null/);
  assert.match(applied, /new\.created_by_agent_id := agent/);
  assert.match(applied, /new\.access_class is distinct from 'user'/);
  assert.match(applied, /security invoker/);
  assert.match(applied, /values \(cleaned, base, btrim\(coalesce\(p_description, ''\)\), 'user'\)/);
  assert.match(applied, /grant execute on function public\.create_agent_project\(uuid, text, text\) to service_role/i);
  assert.doesNotMatch(applied, /to authenticated/i);
  assert.doesNotMatch(applied, /pg_advisory_xact_lock/);
});

test("agent creates hide executive slugs and reject duplicate regular names", () => {
  const follow = readFileSync(
    join(root, "supabase/migrations/20261114103000_agent_project_name_and_slug.sql"),
    "utf8",
  );
  assert.match(follow, /security definer/);
  assert.match(follow, /set search_path = ''/);
  assert.match(
    follow,
    /regular_member := api_role = 'service_role'\s+or \(api_role = 'authenticated' and not coalesce\(private\.is_executive\(\), false\)\);/,
  );
  assert.match(follow, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(name_key, 0\)\)/);
  assert.match(
    follow,
    /projects\.access_class = 'user'\s+and pg_catalog\.lower\(pg_catalog\.btrim\(projects\.name\)\) = name_key/,
  );
  assert.match(follow, /A hidden executive slug must not surface as base-2/);
  assert.match(follow, /A project named "%s" already exists \(slug %s\)\. Use it instead\./);
  assert.doesNotMatch(follow, /security invoker/);
  assert.doesNotMatch(follow, /grant execute/i);
  assert.doesNotMatch(follow, /to authenticated/i);

  const mutate = readFileSync(join(root, "src/lib/board/mutate.ts"), "utf8");
  assert.match(mutate, /rpc\("create_agent_project"/);
  assert.match(mutate, /access_class !== "user"/);
  assert.match(mutate, /created_by_agent_id\?\.toLowerCase\(\) !== agentId\.toLowerCase\(\)/);
  assert.doesNotMatch(mutate, /\.ilike\(/);
  const server = readFileSync(join(root, "src/lib/mcp/server.ts"), "utf8");
  const tool = server.slice(server.indexOf('"create_project"'), server.indexOf('"list_tasks"'));
  assert.match(tool, /createProject/);
  assert.doesNotMatch(tool, /accessClass|access_class:\s*"executive"/);
});
