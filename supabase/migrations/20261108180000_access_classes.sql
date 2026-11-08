-- Access classes for people and projects.
--
-- People are executive or regular (user). Projects are executive or regular.
-- Role and revoked status live in public.directory, keyed by email, so an
-- executive can pre-assign someone before their first login. profiles mirrors
-- those columns for operators; the Data API does not grant authenticated
-- clients SELECT on profiles.role. Authorization never reads editable JWT claims.
--
-- Helpers that bypass row level security live in the private schema, which is
-- not exposed through the Data API. No security definer function is created
-- in public. No views are created.
--
-- Apply after 20261108001000_initial_schema.sql, with the Supabase CLI
-- (`supabase db push`) or the SQL editor.

-- ---------------------------------------------------------------------------
-- Directory and project class
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column role text not null default 'user',
  add column revoked_at timestamptz;

alter table public.profiles
  add constraint profiles_role_check check (role in ('executive', 'user'));

comment on column public.profiles.role is
  'Mirror of public.directory.role. Not granted to authenticated clients.';

comment on column public.profiles.revoked_at is
  'Mirror of public.directory.revoked_at. Set when an executive removes the person.';

alter table public.projects
  add column access_class text not null default 'user';

alter table public.projects
  add constraint projects_access_class_check check (access_class in ('executive', 'user'));

comment on column public.projects.access_class is
  'user (regular) or executive. Existing and new projects default to user.';

create table public.directory (
  email text primary key,
  role text not null default 'user',
  revoked_at timestamptz,
  user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint directory_email_domain check (email ~ '^[^@[:space:]]+@exp-eng\.com$'),
  constraint directory_role_check check (role in ('executive', 'user'))
);

comment on table public.directory is
  'Source of truth for who may use Expertise Board and whether they are an executive. Keyed by email so a person can be added before they sign in.';

create index directory_user_id_idx on public.directory (user_id);
create index projects_access_class_idx on public.projects (access_class);

-- Realtime DELETE events are not filtered by RLS. Comments and events carry
-- project_id so a regular client can subscribe only to projects it may see.
alter table public.comments
  add column project_id uuid;

alter table public.task_events
  add column project_id uuid;

update public.comments as comment
set project_id = task.project_id
from public.tasks as task
where task.id = comment.task_id
  and comment.project_id is null;

update public.task_events as event
set project_id = task.project_id
from public.tasks as task
where task.id = event.task_id
  and event.project_id is null;

delete from public.comments where project_id is null;
delete from public.task_events where project_id is null;

alter table public.comments
  alter column project_id set not null;

alter table public.task_events
  alter column project_id set not null;

alter table public.comments
  add constraint comments_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete cascade;

alter table public.task_events
  add constraint task_events_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete cascade;

create index comments_project_id_idx on public.comments (project_id);
create index task_events_project_id_idx on public.task_events (project_id);

comment on column public.comments.project_id is
  'Copied from the task so realtime filters can exclude executive projects.';

comment on column public.task_events.project_id is
  'Copied from the task so realtime filters can exclude executive projects.';

-- ---------------------------------------------------------------------------
-- Access helpers. private is not an exposed schema.
-- ---------------------------------------------------------------------------

create or replace function private.member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select directory.role
  from public.directory
  where directory.user_id = (select auth.uid())
    and directory.revoked_at is null
$$;

comment on function private.member_role() is
  'Active role for the signed-in user. Null when they are missing or removed. Bypasses RLS so policies can call it without recursion.';

create or replace function private.is_executive()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.member_role() = 'executive'
$$;

comment on function private.is_executive() is
  'True when the signed-in user is an active executive.';

revoke all on function private.member_role() from public, anon, authenticated;
revoke all on function private.is_executive() from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;
grant execute on function private.member_role() to authenticated, service_role;
grant execute on function private.is_executive() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Keep profile mirrors, project class, task project, and agent scope honest
-- ---------------------------------------------------------------------------

create or replace function private.sync_directory_to_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set role = new.role,
      revoked_at = new.revoked_at
  where id = new.user_id
     or email = new.email;
  return new;
end;
$$;

create or replace function private.guard_directory_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer;
  target_email text;
  dropping_executive boolean := false;
begin
  if session_user = 'service_role' then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;

  if session_user = 'authenticated' and not coalesce(private.is_executive(), false) then
    raise exception 'Only an executive can change access'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    target_email := old.email;
    dropping_executive := old.role = 'executive' and old.revoked_at is null;
  elsif tg_op = 'UPDATE'
     and old.role = 'executive'
     and old.revoked_at is null
     and (new.role is distinct from 'executive' or new.revoked_at is not null) then
    target_email := old.email;
    dropping_executive := true;
    new.updated_at := now();
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  if dropping_executive then
    select count(*)
    into remaining
    from public.directory
    where role = 'executive'
      and revoked_at is null
      and email <> target_email;

    if remaining < 1 then
      raise exception 'The last executive cannot be demoted or removed'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger directory_guard_access
  before insert or update or delete on public.directory
  for each row
  execute function private.guard_directory_access();

create trigger directory_sync_profile
  after insert or update of role, revoked_at, user_id, email on public.directory
  for each row
  execute function private.sync_directory_to_profile();

create or replace function private.assign_project_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  candidate text;
  suffix integer := 2;
begin
  if tg_op = 'INSERT' then
    select coalesce(max(projects.sort_order), 0) + 1
    into new.sort_order
    from public.projects;

    base := coalesce(nullif(new.slug, ''), 'project');
    candidate := base;
    while exists (
      select 1
      from public.projects
      where projects.slug = candidate
        and projects.id is distinct from new.id
    ) loop
      candidate := base || '-' || suffix;
      suffix := suffix + 1;
      if suffix > 1000 then
        candidate := base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
        exit;
      end if;
    end loop;
    new.slug := candidate;
  end if;

  if new.access_class is null then
    new.access_class := 'user';
  end if;

  if new.access_class = 'executive' and not coalesce(private.is_executive(), false) then
    if session_user not in ('postgres', 'supabase_admin') then
      raise exception 'Only an executive can create an executive project'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.access_class is distinct from old.access_class
     and not coalesce(private.is_executive(), false)
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Only an executive can change a project class'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger projects_assign_slug
  before insert or update on public.projects
  for each row
  execute function private.assign_project_slug();

create or replace function private.guard_task_project()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'Tasks cannot move to another project'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tasks_guard_project
  before update on public.tasks
  for each row
  execute function private.guard_task_project();

-- Invoker so row security hides an executive task the same way a missing task is hidden.
-- The caller's supplied project_id is overwritten on every write.
create or replace function private.assign_row_project()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  found_project uuid;
begin
  select tasks.project_id
  into found_project
  from public.tasks
  where tasks.id = new.task_id;

  if found_project is null then
    raise exception 'Task not found'
      using errcode = '42501';
  end if;

  new.project_id := found_project;
  return new;
end;
$$;

create trigger comments_assign_project
  before insert or update on public.comments
  for each row
  execute function private.assign_row_project();

create trigger task_events_assign_project
  before insert or update on public.task_events
  for each row
  execute function private.assign_row_project();

create or replace function private.reject_service_role_executive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  class text;
  task uuid;
  project uuid;
begin
  if session_user is distinct from 'service_role' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_table_name = 'projects' then
    class := case when tg_op = 'DELETE' then old.access_class else new.access_class end;
    if tg_op = 'UPDATE' and old.access_class = 'executive' then
      class := 'executive';
    end if;
  elsif tg_table_name = 'tasks' then
    project := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
    select projects.access_class
    into class
    from public.projects
    where projects.id = project;
  else
    task := case when tg_op = 'DELETE' then old.task_id else new.task_id end;
    select projects.access_class
    into class
    from public.tasks
    join public.projects on projects.id = tasks.project_id
    where tasks.id = task;
  end if;

  if class is distinct from 'user' then
    raise exception 'Not found'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger projects_reject_agent_executive
  before insert or update or delete on public.projects
  for each row
  execute function private.reject_service_role_executive();

create trigger tasks_reject_agent_executive
  before insert or update or delete on public.tasks
  for each row
  execute function private.reject_service_role_executive();

create trigger comments_reject_agent_executive
  before insert or update or delete on public.comments
  for each row
  execute function private.reject_service_role_executive();

create trigger task_events_reject_agent_executive
  before insert or update or delete on public.task_events
  for each row
  execute function private.reject_service_role_executive();

create trigger task_dependencies_reject_agent_executive
  before insert or update or delete on public.task_dependencies
  for each row
  execute function private.reject_service_role_executive();

revoke all on function private.sync_directory_to_profile() from public, anon, authenticated;
revoke all on function private.guard_directory_access() from public, anon, authenticated;
revoke all on function private.assign_project_slug() from public, anon, authenticated;
revoke all on function private.guard_task_project() from public, anon, authenticated;
revoke all on function private.assign_row_project() from public, anon, authenticated;
revoke all on function private.reject_service_role_executive() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Claim stays on regular projects. Agents still skip Backlog and human tasks.
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
    and exists (
      select 1
      from public.projects as project
      where project.id = tasks.project_id
        and project.access_class = 'user'
    )
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
  'Atomically claim the next regular-project Todo task for an agent. Skips Backlog, human tasks, executive projects, and tasks waiting on unfinished work. Service role only.';

revoke all on function public.claim_next_task(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_next_task(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Signup: company email, removal, and pre-assigned role
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
  if exists (
    select 1
    from public.directory
    where directory.email = normalized
      and directory.revoked_at is not null
  ) then
    raise exception 'This account has been removed from Expertise Board'
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
  assigned_role text;
  assigned_revoked timestamptz;
begin
  normalized := lower(btrim(new.email));

  insert into public.directory as directory (email, role, user_id)
  values (normalized, 'user', new.id)
  on conflict (email) do update
    set user_id = excluded.user_id,
        updated_at = now()
  returning directory.role, directory.revoked_at
  into assigned_role, assigned_revoked;

  if assigned_revoked is not null then
    raise exception 'This account has been removed from Expertise Board'
      using errcode = '42501';
  end if;

  insert into public.profiles (id, email, display_name, role)
  values (new.id, normalized, split_part(normalized, '@', 1), assigned_role);
  return new;
end;
$$;

create or replace function private.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := lower(btrim(new.email));
  update public.profiles
  set email = normalized
  where id = new.id;

  update public.directory
  set email = normalized,
      updated_at = now()
  where user_id = new.id
    and email is distinct from normalized;
  return new;
end;
$$;

revoke all on function private.enforce_company_email() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.sync_profile_email() from public, anon, authenticated;
grant execute on function private.enforce_company_email() to supabase_auth_admin;
grant execute on function private.handle_new_user() to supabase_auth_admin;
grant execute on function private.sync_profile_email() to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Backfill and seed Cory as an executive, even if his auth user is not here yet
-- ---------------------------------------------------------------------------

insert into public.directory (email, role, user_id, revoked_at)
select profiles.email, 'user', profiles.id, null
from public.profiles
on conflict (email) do update
set user_id = excluded.user_id
where public.directory.user_id is null;

insert into public.directory (email, role)
values ('cm@exp-eng.com', 'executive')
on conflict (email) do update
set role = 'executive',
    revoked_at = null,
    updated_at = now();

update public.directory as directory
set user_id = users.id
from auth.users as users
where directory.email = 'cm@exp-eng.com'
  and (
    (
      users.id = '091c0a69-b662-40f8-9179-6d86c6c30b79'
      and lower(users.email) = 'cm@exp-eng.com'
    )
    or (
      directory.user_id is null
      and lower(users.email) = 'cm@exp-eng.com'
    )
  );

update public.profiles
set role = 'executive',
    revoked_at = null
where email = 'cm@exp-eng.com'
   or id = '091c0a69-b662-40f8-9179-6d86c6c30b79';

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

revoke insert, delete, update, select on table public.profiles from authenticated;
grant select (id, email, display_name, created_at, revoked_at) on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

alter table public.directory enable row level security;
revoke all on table public.directory from public, anon;
grant select, insert, update on table public.directory to authenticated;
grant select, insert, update, delete on table public.directory to service_role;

drop policy if exists authenticated_all on public.profiles;
drop policy if exists authenticated_all on public.agents;
drop policy if exists authenticated_all on public.projects;
drop policy if exists authenticated_all on public.tasks;
drop policy if exists authenticated_all on public.comments;
drop policy if exists authenticated_all on public.task_events;
drop policy if exists authenticated_all on public.task_dependencies;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select private.member_role()) is not null
  );

create policy profiles_update on public.profiles
  for update to authenticated
  using (
    id = (select auth.uid())
    and (select private.member_role()) is not null
  )
  with check (
    id = (select auth.uid())
    and (select private.member_role()) is not null
  );

create policy agents_select on public.agents
  for select to authenticated
  using ((select private.member_role()) is not null);

create policy agents_insert on public.agents
  for insert to authenticated
  with check ((select private.member_role()) is not null);

create policy agents_update on public.agents
  for update to authenticated
  using ((select private.member_role()) is not null)
  with check ((select private.member_role()) is not null);

create policy agents_delete on public.agents
  for delete to authenticated
  using ((select private.member_role()) is not null);

create policy projects_select on public.projects
  for select to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and access_class = 'user'
    )
  );

create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and access_class = 'user'
    )
  );

create policy projects_update on public.projects
  for update to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and access_class = 'user'
    )
  )
  with check (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and access_class = 'user'
    )
  );

create policy projects_delete on public.projects
  for delete to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and access_class = 'user'
    )
  );

create policy tasks_select on public.tasks
  for select to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and exists (
        select 1
        from public.projects
        where projects.id = tasks.project_id
          and projects.access_class = 'user'
      )
    )
  );

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and exists (
        select 1
        from public.projects
        where projects.id = tasks.project_id
          and projects.access_class = 'user'
      )
    )
  );

create policy tasks_update on public.tasks
  for update to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and exists (
        select 1
        from public.projects
        where projects.id = tasks.project_id
          and projects.access_class = 'user'
      )
    )
  )
  with check (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and exists (
        select 1
        from public.projects
        where projects.id = tasks.project_id
          and projects.access_class = 'user'
      )
    )
  );

create policy tasks_delete on public.tasks
  for delete to authenticated
  using (
    (select private.member_role()) = 'executive'
    or (
      (select private.member_role()) = 'user'
      and exists (
        select 1
        from public.projects
        where projects.id = tasks.project_id
          and projects.access_class = 'user'
      )
    )
  );

create policy comments_select on public.comments
  for select to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = comments.task_id
    )
  );

create policy comments_insert on public.comments
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = comments.task_id
    )
  );

create policy comments_update on public.comments
  for update to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = comments.task_id
    )
  )
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = comments.task_id
    )
  );

create policy comments_delete on public.comments
  for delete to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = comments.task_id
    )
  );

create policy task_events_select on public.task_events
  for select to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_events.task_id
    )
  );

create policy task_events_insert on public.task_events
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_events.task_id
    )
  );

create policy task_events_update on public.task_events
  for update to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_events.task_id
    )
  )
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_events.task_id
    )
  );

create policy task_events_delete on public.task_events
  for delete to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_events.task_id
    )
  );

create policy task_dependencies_select on public.task_dependencies
  for select to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.task_id
    )
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.waits_on_task_id
    )
  );

create policy task_dependencies_insert on public.task_dependencies
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.task_id
    )
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.waits_on_task_id
    )
  );

create policy task_dependencies_update on public.task_dependencies
  for update to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.task_id
    )
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.waits_on_task_id
    )
  )
  with check (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.task_id
    )
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.waits_on_task_id
    )
  );

create policy task_dependencies_delete on public.task_dependencies
  for delete to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.task_id
    )
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_dependencies.waits_on_task_id
    )
  );

create policy directory_select on public.directory
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.member_role()) = 'executive'
  );

create policy directory_insert on public.directory
  for insert to authenticated
  with check ((select private.member_role()) = 'executive');

create policy directory_update on public.directory
  for update to authenticated
  using ((select private.member_role()) = 'executive')
  with check ((select private.member_role()) = 'executive');

grant delete on table public.profiles to supabase_auth_admin;

drop policy if exists profiles_auth_delete on public.profiles;
create policy profiles_auth_delete on public.profiles
  for delete to supabase_auth_admin
  using (true);
