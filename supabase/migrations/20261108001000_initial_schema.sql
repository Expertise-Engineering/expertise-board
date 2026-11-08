-- Expertise Board
-- Initial schema for an internal kanban. Signed-in teammates share one board.
-- Row level security is on so the Data API is not open to anonymous clients,
-- and authenticated users may read and write every row. This is tracking, not isolation.
--
-- Apply with the Supabase CLI (`supabase db push`) or the SQL editor.
-- Requires the Supabase auth schema, the supabase_auth_admin role, and the
-- supabase_realtime publication. Do not run this against a plain Postgres server.

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

comment on schema private is
  'Trigger helpers that must not be exposed through the Data API.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint profiles_email_domain check (email ~ '^[^@[:space:]]+@exp-eng\.com$'),
  constraint profiles_display_name_present check (char_length(btrim(display_name)) > 0)
);

comment on table public.profiles is
  'One row per Expertise Engineering account. Created by the auth signup trigger.';

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null,
  revoked_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint agents_name_unique unique (name),
  constraint agents_name_present check (char_length(btrim(name)) between 1 and 80),
  constraint agents_key_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint agents_key_hash_unique unique (key_hash)
);

comment on table public.agents is
  'First-class agent actors. key_hash is the sha256 hex of the API key. The raw key is never stored.';

comment on column public.agents.key_hash is
  'Lowercase hex sha256 of the full API key, including the eb_ prefix.';

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  constraint projects_slug_unique unique (slug),
  constraint projects_name_present check (char_length(btrim(name)) between 1 and 120),
  constraint projects_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

comment on table public.projects is
  'One project per customer or job.';

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  number integer not null,
  title text not null,
  description text not null default '',
  status text not null default 'backlog',
  is_human boolean not null default false,
  url text,
  tags text[] not null default '{}',
  position double precision not null default 0,
  assignee_user_id uuid references public.profiles (id) on delete set null,
  assignee_agent_id uuid references public.agents (id) on delete set null,
  created_by_user_id uuid references public.profiles (id) on delete set null,
  created_by_agent_id uuid references public.agents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_status_check check (
    status in ('backlog', 'todo', 'doing', 'review', 'done')
  ),
  constraint tasks_title_present check (char_length(btrim(title)) between 1 and 200),
  constraint tasks_one_assignee check (
    assignee_user_id is null or assignee_agent_id is null
  ),
  constraint tasks_one_creator check (
    created_by_user_id is null or created_by_agent_id is null
  ),
  constraint tasks_project_number_unique unique (project_id, number)
);

comment on table public.tasks is
  'Kanban cards. Backlog and is_human tasks are not eligible for agent claim.';

comment on column public.tasks.number is
  'Per-project sequence assigned by public.next_task_number when omitted.';

comment on column public.tasks.is_human is
  'When true, agents must not take this task. People still can.';

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  body text not null,
  author_user_id uuid references public.profiles (id) on delete set null,
  author_agent_id uuid references public.agents (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint comments_body_present check (char_length(btrim(body)) > 0),
  constraint comments_one_author check (
    ((author_user_id is not null)::integer + (author_agent_id is not null)::integer) = 1
  )
);

comment on table public.comments is
  'Task comments. Exactly one of author_user_id or author_agent_id is set.';

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  actor_user_id uuid references public.profiles (id) on delete set null,
  actor_agent_id uuid references public.agents (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint task_events_kind_check check (
    kind in ('created', 'moved', 'assigned', 'commented', 'updated')
  ),
  constraint task_events_from_status_check check (
    from_status is null or from_status in ('backlog', 'todo', 'doing', 'review', 'done')
  ),
  constraint task_events_to_status_check check (
    to_status is null or to_status in ('backlog', 'todo', 'doing', 'review', 'done')
  ),
  constraint task_events_one_actor check (
    actor_user_id is null or actor_agent_id is null
  )
);

comment on table public.task_events is
  'Who created, moved, assigned, commented, or edited a task.';

create table public.task_dependencies (
  task_id uuid not null references public.tasks (id) on delete cascade,
  waits_on_task_id uuid not null references public.tasks (id) on delete cascade,
  primary key (task_id, waits_on_task_id),
  constraint task_dependencies_no_self check (task_id <> waits_on_task_id)
);

comment on table public.task_dependencies is
  'task_id cannot start until waits_on_task_id is done. Both tasks must share a project.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index profiles_email_idx on public.profiles (email);
create index projects_sort_idx on public.projects (sort_order, name);
create index tasks_project_id_idx on public.tasks (project_id);
create index tasks_status_idx on public.tasks (status);
create index tasks_assignee_user_id_idx on public.tasks (assignee_user_id);
create index tasks_assignee_agent_id_idx on public.tasks (assignee_agent_id);
create index tasks_tags_gin_idx on public.tasks using gin (tags);
create index tasks_project_status_position_idx on public.tasks (project_id, status, position);
create index tasks_claim_idx on public.tasks (position, created_at)
  where status = 'todo' and is_human = false and assignee_user_id is null;
create index comments_task_id_idx on public.comments (task_id, created_at);
create index task_events_task_id_idx on public.task_events (task_id, created_at);
create index task_dependencies_waits_on_idx on public.task_dependencies (waits_on_task_id);

-- ---------------------------------------------------------------------------
-- Task numbers
-- ---------------------------------------------------------------------------

create or replace function public.next_task_number(p_project_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_number integer;
begin
  if p_project_id is null then
    raise exception 'project_id is required';
  end if;

  -- Serialise allocation on the project row so two inserts cannot take the same number.
  perform 1
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'Project not found';
  end if;

  select coalesce(max(tasks.number), 0) + 1
  into next_number
  from public.tasks
  where tasks.project_id = p_project_id;

  return next_number;
end;
$$;

comment on function public.next_task_number(uuid) is
  'Next available task number for a project. Locks the project row for the rest of the transaction.';

create or replace function public.assign_task_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.number is null then
    new.number := public.next_task_number(new.project_id);
  end if;
  return new;
end;
$$;

create trigger tasks_assign_number
  before insert on public.tasks
  for each row
  execute function public.assign_task_number();

create or replace function public.touch_task_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row
  execute function public.touch_task_updated_at();

-- ---------------------------------------------------------------------------
-- Dependencies: same project, no cycles
-- ---------------------------------------------------------------------------

create or replace function public.enforce_task_dependency()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_project uuid;
  blocker_project uuid;
begin
  select project_id into source_project
  from public.tasks
  where id = new.task_id;

  select project_id into blocker_project
  from public.tasks
  where id = new.waits_on_task_id;

  if source_project is null or blocker_project is null or source_project <> blocker_project then
    raise exception 'A task can only wait on another task in the same project';
  end if;

  if exists (
    with recursive chain as (
      select new.waits_on_task_id as id, 1 as depth
      union all
      select dependency.waits_on_task_id, chain.depth + 1
      from chain
      join public.task_dependencies as dependency on dependency.task_id = chain.id
      where chain.depth < 50
    )
    select 1
    from chain
    where chain.id = new.task_id
  ) then
    raise exception 'That dependency would create a cycle';
  end if;

  return new;
end;
$$;

create trigger task_dependencies_enforce
  before insert or update on public.task_dependencies
  for each row
  execute function public.enforce_task_dependency();

-- ---------------------------------------------------------------------------
-- Agent claim. Granted only to service_role. The MCP route calls this.
-- Skips Backlog, human tasks, tasks assigned to a person or another agent,
-- and tasks waiting on unfinished work. Moves the chosen row to Doing.
-- ---------------------------------------------------------------------------

create or replace function public.claim_next_task(
  p_agent_id uuid,
  p_project_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed public.tasks%rowtype;
  agent_name text;
  previous_agent uuid;
  comment_body text := 'Took this task.';
begin
  if p_agent_id is null then
    raise exception 'Agent id is required';
  end if;

  select agents.name
  into agent_name
  from public.agents
  where agents.id = p_agent_id
    and agents.revoked_at is null;

  if agent_name is null then
    raise exception 'Agent is missing or revoked';
  end if;

  select tasks.*
  into claimed
  from public.tasks
  where tasks.status = 'todo'
    and tasks.is_human = false
    and (p_project_id is null or tasks.project_id = p_project_id)
    and tasks.assignee_user_id is null
    and (tasks.assignee_agent_id is null or tasks.assignee_agent_id = p_agent_id)
    and not exists (
      select 1
      from public.task_dependencies as dependency
      join public.tasks as blocker on blocker.id = dependency.waits_on_task_id
      where dependency.task_id = tasks.id
        and blocker.status <> 'done'
    )
  order by tasks.position asc, tasks.created_at asc, tasks.number asc
  limit 1
  for update of tasks skip locked;

  if not found then
    return null;
  end if;

  previous_agent := claimed.assignee_agent_id;

  update public.tasks
  set
    status = 'doing',
    assignee_user_id = null,
    assignee_agent_id = p_agent_id
  where id = claimed.id
  returning * into claimed;

  insert into public.comments (task_id, body, author_agent_id)
  values (claimed.id, comment_body, p_agent_id);

  insert into public.task_events (
    task_id, kind, from_status, to_status, actor_agent_id, meta
  ) values (
    claimed.id,
    'moved',
    'todo',
    'doing',
    p_agent_id,
    jsonb_build_object('actor_name', agent_name)
  );

  if previous_agent is distinct from p_agent_id then
    insert into public.task_events (task_id, kind, actor_agent_id, meta)
    values (
      claimed.id,
      'assigned',
      p_agent_id,
      jsonb_build_object(
        'actor_name', agent_name,
        'assignee_agent_id', p_agent_id,
        'assignee_name', agent_name
      )
    );
  end if;

  insert into public.task_events (task_id, kind, actor_agent_id, meta)
  values (
    claimed.id,
    'commented',
    p_agent_id,
    jsonb_build_object('actor_name', agent_name, 'body', comment_body)
  );

  return to_jsonb(claimed);
end;
$$;

comment on function public.claim_next_task(uuid, uuid) is
  'Atomically claim the next Todo task for an agent. Service role only.';

revoke all on function public.claim_next_task(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_next_task(uuid, uuid) to service_role;

revoke all on function public.next_task_number(uuid) from public, anon;
grant execute on function public.next_task_number(uuid) to authenticated, service_role;

revoke all on function public.assign_task_number() from public, anon;
grant execute on function public.assign_task_number() to authenticated, service_role;

revoke all on function public.touch_task_updated_at() from public, anon;
grant execute on function public.touch_task_updated_at() to authenticated, service_role;

revoke all on function public.enforce_task_dependency() from public, anon;
grant execute on function public.enforce_task_dependency() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Auth domain gate and profile creation
-- ---------------------------------------------------------------------------

create or replace function private.enforce_company_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := lower(btrim(coalesce(new.email, '')));
  if normalized !~ '^[^@[:space:]]+@exp-eng\.com$' then
    raise exception 'Only @exp-eng.com email addresses may sign up or sign in'
      using errcode = '42501';
  end if;
  new.email := normalized;
  return new;
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := lower(btrim(new.email));
  insert into public.profiles (id, email, display_name)
  values (new.id, normalized, split_part(normalized, '@', 1));
  return new;
end;
$$;

create or replace function private.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set email = lower(btrim(new.email))
  where id = new.id;
  return new;
end;
$$;

create trigger enforce_company_email
  before insert or update of email on auth.users
  for each row
  execute function private.enforce_company_email();

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function private.sync_profile_email();

revoke all on function private.enforce_company_email() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.sync_profile_email() from public, anon, authenticated;

grant usage on schema private to supabase_auth_admin;
grant execute on function private.enforce_company_email() to supabase_auth_admin;
grant execute on function private.handle_new_user() to supabase_auth_admin;
grant execute on function private.sync_profile_email() to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'agents',
    'projects',
    'tasks',
    'comments',
    'task_events',
    'task_dependencies'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists authenticated_all on public.%I', table_name);
    execute format(
      'create policy authenticated_all on public.%I for all to authenticated using (true) with check (true)',
      table_name
    );
    execute format('revoke all on table public.%I from public, anon', table_name);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated',
      table_name
    );
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      table_name
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter table public.tasks replica identity full;
alter table public.comments replica identity full;
alter table public.projects replica identity full;
alter table public.task_events replica identity full;

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.task_events;
