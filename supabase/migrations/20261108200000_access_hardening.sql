-- Harden access after 20261108180000_access_classes.sql.
--
-- API role checks use auth.role(), which reads the JWT claim PostgREST sets.
-- The database login role is not an API role.
-- Authorization does not read editable JWT metadata claims.
--
-- Apply with the Supabase CLI (`supabase db push`) or the SQL editor.
-- Requires the auth schema helpers auth.role() and auth.uid().

-- ---------------------------------------------------------------------------
-- Request role
-- ---------------------------------------------------------------------------

create or replace function private.request_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(auth.role(), '');
$$;

comment on function private.request_role() is
  'JWT role for this request: authenticated, service_role, or anon. Null when the session has no JWT, such as a SQL editor maintenance session.';

revoke all on function private.request_role() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Directory guard: API role, and lock executives before the last-one count
-- ---------------------------------------------------------------------------

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
  api_role text := private.request_role();
begin
  if api_role = 'service_role' then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;

  if api_role = 'authenticated' and not coalesce(private.is_executive(), false) then
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
    -- Lock every active executive row first so two demotions cannot both commit.
    -- Same lock order for every demotion. A deadlock aborts one transaction;
    -- the survivor's count is the one that commits.
    perform 1
    from public.directory
    where role = 'executive'
      and revoked_at is null
    order by email
    for update;

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

-- ---------------------------------------------------------------------------
-- Project class and slugs. A regular member's suffix comes from visible rows.
-- ---------------------------------------------------------------------------

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
  api_role text := private.request_role();
  regular_member boolean;
begin
  regular_member := api_role = 'authenticated' and not coalesce(private.is_executive(), false);

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
        and (
          not regular_member
          or projects.access_class = 'user'
        )
    ) loop
      candidate := base || '-' || suffix;
      suffix := suffix + 1;
      if suffix > 1000 then
        candidate := base || '-' || substr(md5(pg_catalog.gen_random_uuid()::text), 1, 8);
        exit;
      end if;
    end loop;

    -- A hidden executive slug must not surface as base-2. Use an opaque suffix.
    if exists (
      select 1
      from public.projects
      where projects.slug = candidate
        and projects.id is distinct from new.id
    ) then
      candidate := base || '-' || substr(md5(pg_catalog.gen_random_uuid()::text), 1, 8);
    end if;
    new.slug := candidate;
  end if;

  if new.access_class is null then
    new.access_class := 'user';
  end if;

  if new.access_class = 'executive' and not coalesce(private.is_executive(), false) then
    if api_role is not null then
      raise exception 'Only an executive can create an executive project'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.access_class is distinct from old.access_class
     and not coalesce(private.is_executive(), false)
     and api_role is not null then
    raise exception 'Only an executive can change a project class'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role writes cannot touch executive rows
-- ---------------------------------------------------------------------------

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
  if private.request_role() is distinct from 'service_role' then
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

-- ---------------------------------------------------------------------------
-- Bind authors to the session. Payload actor ids are not trusted.
-- ---------------------------------------------------------------------------

create or replace function private.bind_task_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_role text := private.request_role();
  agent uuid;
begin
  if tg_op = 'UPDATE' then
    if new.created_by_user_id is distinct from old.created_by_user_id
       or new.created_by_agent_id is distinct from old.created_by_agent_id then
      -- A nested trigger is the foreign key clearing a deleted person or agent.
      if pg_catalog.pg_trigger_depth() > 1
         and new.created_by_user_id is null
         and new.created_by_agent_id is null then
        return new;
      end if;
      raise exception 'Actor columns cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if api_role = 'authenticated' then
    if new.created_by_agent_id is not null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    new.created_by_user_id := auth.uid();
    new.created_by_agent_id := null;
    return new;
  end if;

  if api_role = 'service_role' then
    agent := nullif(current_setting('app.agent_id', true), '')::uuid;
    if agent is null
       or not exists (
         select 1
         from public.agents
         where agents.id = agent
           and agents.revoked_at is null
       ) then
      raise exception 'Agent is missing or revoked'
        using errcode = '42501';
    end if;
    new.created_by_user_id := null;
    new.created_by_agent_id := agent;
    return new;
  end if;

  return new;
end;
$$;

create or replace function private.bind_comment_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_role text := private.request_role();
  agent uuid;
begin
  if tg_op = 'UPDATE' then
    if new.author_user_id is distinct from old.author_user_id
       or new.author_agent_id is distinct from old.author_agent_id then
      if pg_catalog.pg_trigger_depth() > 1
         and new.author_user_id is null
         and new.author_agent_id is null then
        return new;
      end if;
      raise exception 'Actor columns cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if api_role = 'authenticated' then
    if new.author_agent_id is not null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    new.author_user_id := auth.uid();
    new.author_agent_id := null;
    return new;
  end if;

  if api_role = 'service_role' then
    agent := nullif(current_setting('app.agent_id', true), '')::uuid;
    if agent is null
       or not exists (
         select 1
         from public.agents
         where agents.id = agent
           and agents.revoked_at is null
       ) then
      raise exception 'Agent is missing or revoked'
        using errcode = '42501';
    end if;
    new.author_user_id := null;
    new.author_agent_id := agent;
    return new;
  end if;

  return new;
end;
$$;

create or replace function private.bind_event_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_role text := private.request_role();
  agent uuid;
begin
  if tg_op = 'UPDATE' then
    if new.actor_user_id is distinct from old.actor_user_id
       or new.actor_agent_id is distinct from old.actor_agent_id then
      if pg_catalog.pg_trigger_depth() > 1
         and new.actor_user_id is null
         and new.actor_agent_id is null then
        return new;
      end if;
      raise exception 'Actor columns cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if api_role = 'authenticated' then
    if new.actor_agent_id is not null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    new.actor_user_id := auth.uid();
    new.actor_agent_id := null;
    return new;
  end if;

  if api_role = 'service_role' then
    agent := nullif(current_setting('app.agent_id', true), '')::uuid;
    if agent is null
       or not exists (
         select 1
         from public.agents
         where agents.id = agent
           and agents.revoked_at is null
       ) then
      raise exception 'Agent is missing or revoked'
        using errcode = '42501';
    end if;
    new.actor_user_id := null;
    new.actor_agent_id := agent;
    return new;
  end if;

  return new;
end;
$$;

create trigger tasks_bind_creator
  before insert or update on public.tasks
  for each row
  execute function private.bind_task_creator();

create trigger comments_bind_author
  before insert or update on public.comments
  for each row
  execute function private.bind_comment_author();

create trigger task_events_bind_actor
  before insert or update on public.task_events
  for each row
  execute function private.bind_event_actor();

revoke all on function private.bind_task_creator() from public, anon, authenticated;
revoke all on function private.bind_comment_author() from public, anon, authenticated;
revoke all on function private.bind_event_actor() from public, anon, authenticated;

-- A removed person or agent can leave comments with no author. New writes still
-- pass through the bind triggers, which set exactly one author.
alter table public.comments drop constraint comments_one_author;
alter table public.comments add constraint comments_one_author check (
  ((author_user_id is not null)::integer + (author_agent_id is not null)::integer) <= 1
);

-- ---------------------------------------------------------------------------
-- Agents cannot edit backlog or human cards, clear the human flag, or park work
-- ---------------------------------------------------------------------------

create or replace function private.guard_agent_task_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.request_role() is distinct from 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'backlog' then
      raise exception 'Agents cannot create Backlog tasks. A person parks work there.'
        using errcode = '42501';
    end if;
    if coalesce(new.is_human, false) and new.status = 'doing' then
      raise exception 'Agents cannot start a task marked human.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'backlog' or old.is_human then
    raise exception 'Agents cannot change a Backlog task or a task marked human.'
      using errcode = '42501';
  end if;

  if new.status = 'backlog' then
    raise exception 'Agents cannot move a task to Backlog.'
      using errcode = '42501';
  end if;

  if old.is_human and new.is_human is distinct from true then
    raise exception 'Agents cannot clear the human flag.'
      using errcode = '42501';
  end if;

  if new.is_human and new.status = 'doing' and old.status is distinct from 'doing' then
    raise exception 'Agents cannot start a task marked human.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger tasks_guard_agent_write
  before insert or update on public.tasks
  for each row
  execute function private.guard_agent_task_write();

revoke all on function private.guard_agent_task_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Deletion history that survives cascade
-- ---------------------------------------------------------------------------

create table public.deletion_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  record_id uuid not null,
  project_id uuid,
  access_class text,
  label text not null default '',
  actor_user_id uuid,
  actor_agent_id uuid,
  created_at timestamptz not null default now(),
  constraint deletion_log_kind_check check (kind in ('project', 'task')),
  constraint deletion_log_class_check check (
    access_class is null or access_class in ('executive', 'user')
  )
);

comment on table public.deletion_log is
  'Who deleted a project or task. No foreign key to those tables, so the row remains after cascade.';

alter table public.deletion_log enable row level security;
revoke all on table public.deletion_log from public, anon, authenticated;
grant select on table public.deletion_log to authenticated;

create policy deletion_log_select on public.deletion_log
  for select to authenticated
  using (
    private.is_executive()
    or (
      private.member_role() = 'user'
      and access_class = 'user'
    )
  );

create or replace function private.audit_project_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_role text := private.request_role();
begin
  insert into public.deletion_log (
    kind, record_id, project_id, access_class, label, actor_user_id, actor_agent_id
  ) values (
    'project',
    old.id,
    old.id,
    old.access_class,
    old.name,
    case when api_role = 'authenticated' then auth.uid() else null end,
    case
      when api_role = 'service_role' then nullif(current_setting('app.agent_id', true), '')::uuid
      else null
    end
  );
  return old;
end;
$$;

create or replace function private.audit_task_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_role text := private.request_role();
  class text;
begin
  select projects.access_class
  into class
  from public.projects
  where projects.id = old.project_id;

  insert into public.deletion_log (
    kind, record_id, project_id, access_class, label, actor_user_id, actor_agent_id
  ) values (
    'task',
    old.id,
    old.project_id,
    class,
    old.title,
    case when api_role = 'authenticated' then auth.uid() else null end,
    case
      when api_role = 'service_role' then nullif(current_setting('app.agent_id', true), '')::uuid
      else null
    end
  );
  return old;
end;
$$;

create trigger projects_audit_delete
  before delete on public.projects
  for each row
  execute function private.audit_project_delete();

create trigger tasks_audit_delete
  before delete on public.tasks
  for each row
  execute function private.audit_task_delete();

revoke all on function private.audit_project_delete() from public, anon, authenticated;
revoke all on function private.audit_task_delete() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime ticks carry no row body. Task tables leave the publication.
-- ---------------------------------------------------------------------------

create table public.board_ticks (
  scope text primary key,
  updated_at timestamptz not null default now(),
  constraint board_ticks_scope_check check (scope in ('regular', 'executive'))
);

comment on table public.board_ticks is
  'One clock per audience. Regular members can read the regular row only. Payloads are a scope and a time, never task contents.';

insert into public.board_ticks (scope) values ('regular'), ('executive');

alter table public.board_ticks enable row level security;
revoke all on table public.board_ticks from public, anon, authenticated;
grant select on table public.board_ticks to authenticated;

create policy board_ticks_select on public.board_ticks
  for select to authenticated
  using (
    (scope = 'regular' and private.member_role() is not null)
    or (scope = 'executive' and private.is_executive())
  );

create or replace function private.touch_board_tick()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  class text;
  project uuid;
begin
  if tg_table_name = 'projects' then
    class := case when tg_op = 'DELETE' then old.access_class else new.access_class end;
    if tg_op = 'UPDATE' and old.access_class = 'executive' then
      class := 'executive';
    end if;
  elsif tg_table_name = 'tasks' then
    project := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
    select projects.access_class into class
    from public.projects
    where projects.id = project;
  else
    project := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
    select projects.access_class into class
    from public.projects
    where projects.id = project;
  end if;

  update public.board_ticks
  set updated_at = clock_timestamp()
  where scope = case when class = 'user' then 'regular' else 'executive' end;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger projects_touch_tick
  after insert or update or delete on public.projects
  for each row
  execute function private.touch_board_tick();

create trigger tasks_touch_tick
  after insert or update or delete on public.tasks
  for each row
  execute function private.touch_board_tick();

create trigger comments_touch_tick
  after insert or update or delete on public.comments
  for each row
  execute function private.touch_board_tick();

create trigger task_events_touch_tick
  after insert or update or delete on public.task_events
  for each row
  execute function private.touch_board_tick();

revoke all on function private.touch_board_tick() from public, anon, authenticated;

alter publication supabase_realtime drop table public.tasks;
alter publication supabase_realtime drop table public.comments;
alter publication supabase_realtime drop table public.projects;
alter publication supabase_realtime drop table public.task_events;
alter publication supabase_realtime add table public.board_ticks;

-- ---------------------------------------------------------------------------
-- Agent keys. authenticated cannot read or write key_hash.
-- Issuing sets a transaction flag so even service_role cannot skip the function.
-- ---------------------------------------------------------------------------

create or replace function private.guard_agent_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_setting('app.issuing_agent_key', true) is distinct from '1' then
      raise exception 'Not allowed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.key_hash is distinct from old.key_hash
     and current_setting('app.issuing_agent_key', true) is distinct from '1' then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger agents_guard_key
  before insert or update on public.agents
  for each row
  execute function private.guard_agent_key();

revoke all on function private.guard_agent_key() from public, anon, authenticated;

create or replace function private.issue_agent_key(
  p_name text,
  p_key_hash text,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  cleaned text;
begin
  if private.request_role() is distinct from 'service_role' then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;
  if p_created_by is null
     or not exists (select 1 from public.profiles where profiles.id = p_created_by) then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.directory
    where directory.user_id = p_created_by
      and directory.revoked_at is not null
  ) then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;

  cleaned := btrim(coalesce(p_name, ''));
  if char_length(cleaned) < 1 or char_length(cleaned) > 80 then
    raise exception 'Agent name must be 1–80 characters.'
      using errcode = '22023';
  end if;
  if p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Not allowed'
      using errcode = '42501';
  end if;

  perform set_config('app.issuing_agent_key', '1', true);
  insert into public.agents (name, key_hash, created_by)
  values (cleaned, p_key_hash, p_created_by)
  returning id into new_id;
  return new_id;
end;
$$;

comment on function private.issue_agent_key(text, text, uuid) is
  'Insert an agent key hash. Callable only while the JWT role is service_role. A missing directory row is allowed; a revoked row is not.';

revoke all on function private.issue_agent_key(text, text, uuid) from public, anon, authenticated;

-- PostgREST exposes public. This wrapper is invoker-only and is granted to
-- service_role, which the add-agent action uses after requireActor. It does not
-- accept a caller-chosen hash from an authenticated session.
create or replace function public.issue_agent_key(
  p_name text,
  p_key_hash text,
  p_created_by uuid
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.issue_agent_key(p_name, p_key_hash, p_created_by);
$$;

revoke all on function public.issue_agent_key(text, text, uuid) from public, anon, authenticated;
grant execute on function private.issue_agent_key(text, text, uuid) to service_role;
grant execute on function public.issue_agent_key(text, text, uuid) to service_role;

revoke insert, update, select, delete on table public.agents from authenticated;
grant select (id, name, revoked_at, created_by, created_at) on table public.agents to authenticated;
grant update (name, revoked_at) on table public.agents to authenticated;
grant delete on table public.agents to authenticated;

-- ---------------------------------------------------------------------------
-- One transaction for create, comment, dependency replace, and task update
-- ---------------------------------------------------------------------------

create or replace function private.prepare_writer(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.request_role() = 'service_role' then
    if p_agent_id is null then
      raise exception 'Agent id is required'
        using errcode = '42501';
    end if;
    perform set_config('app.agent_id', p_agent_id::text, true);
  end if;
end;
$$;

revoke all on function private.prepare_writer(uuid) from public, anon, authenticated;

create or replace function public.create_board_task(
  p_agent_id uuid,
  p_actor_name text,
  p_project_id uuid,
  p_title text,
  p_description text,
  p_status text,
  p_is_human boolean,
  p_url text,
  p_tags text[],
  p_position double precision,
  p_assignee_user_id uuid,
  p_assignee_agent_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created public.tasks%rowtype;
begin
  perform private.prepare_writer(p_agent_id);
  insert into public.tasks (
    project_id, title, description, status, is_human, url, tags, position,
    assignee_user_id, assignee_agent_id
  ) values (
    p_project_id,
    p_title,
    coalesce(p_description, ''),
    coalesce(p_status, 'todo'),
    coalesce(p_is_human, false),
    nullif(p_url, ''),
    coalesce(p_tags, '{}'),
    coalesce(p_position, 1024),
    p_assignee_user_id,
    p_assignee_agent_id
  )
  returning * into created;

  insert into public.task_events (task_id, kind, to_status, meta)
  values (
    created.id,
    'created',
    created.status,
    jsonb_build_object('actor_name', coalesce(p_actor_name, ''), 'title', created.title)
  );

  if created.assignee_user_id is not null or created.assignee_agent_id is not null then
    insert into public.task_events (task_id, kind, meta)
    values (
      created.id,
      'assigned',
      jsonb_build_object(
        'actor_name', coalesce(p_actor_name, ''),
        'assignee',
        case
          when created.assignee_user_id is not null then 'user:' || created.assignee_user_id::text
          else 'agent:' || created.assignee_agent_id::text
        end
      )
    );
  end if;

  return to_jsonb(created);
end;
$$;

create or replace function public.update_board_task(
  p_agent_id uuid,
  p_actor_name text,
  p_task_id uuid,
  p_title text,
  p_description text,
  p_status text,
  p_is_human boolean,
  p_url text,
  p_tags text[],
  p_position double precision,
  p_assignee_user_id uuid,
  p_assignee_agent_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.tasks%rowtype;
  updated public.tasks%rowtype;
begin
  perform private.prepare_writer(p_agent_id);
  select * into existing from public.tasks where id = p_task_id;
  if not found then
    raise exception 'Task not found'
      using errcode = '42501';
  end if;

  update public.tasks
  set
    title = p_title,
    description = coalesce(p_description, ''),
    status = p_status,
    is_human = coalesce(p_is_human, false),
    url = nullif(p_url, ''),
    tags = coalesce(p_tags, '{}'),
    position = coalesce(p_position, existing.position),
    assignee_user_id = p_assignee_user_id,
    assignee_agent_id = p_assignee_agent_id
  where id = existing.id
  returning * into updated;

  if not found then
    raise exception 'Task not found'
      using errcode = '42501';
  end if;

  if existing.status is distinct from updated.status then
    insert into public.task_events (task_id, kind, from_status, to_status, meta)
    values (
      updated.id,
      'moved',
      existing.status,
      updated.status,
      jsonb_build_object('actor_name', coalesce(p_actor_name, ''))
    );
  end if;

  if existing.assignee_user_id is distinct from updated.assignee_user_id
     or existing.assignee_agent_id is distinct from updated.assignee_agent_id then
    insert into public.task_events (task_id, kind, meta)
    values (
      updated.id,
      'assigned',
      jsonb_build_object(
        'actor_name', coalesce(p_actor_name, ''),
        'assignee',
        case
          when updated.assignee_user_id is not null then 'user:' || updated.assignee_user_id::text
          when updated.assignee_agent_id is not null then 'agent:' || updated.assignee_agent_id::text
          else ''
        end
      )
    );
  end if;

  if existing.title is distinct from updated.title
     or existing.description is distinct from updated.description
     or existing.url is distinct from updated.url
     or existing.is_human is distinct from updated.is_human
     or existing.tags is distinct from updated.tags then
    insert into public.task_events (task_id, kind, meta)
    values (
      updated.id,
      'updated',
      jsonb_build_object('actor_name', coalesce(p_actor_name, ''))
    );
  end if;

  return to_jsonb(updated);
end;
$$;

create or replace function public.add_board_comment(
  p_agent_id uuid,
  p_actor_name text,
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created public.comments%rowtype;
begin
  perform private.prepare_writer(p_agent_id);
  insert into public.comments (task_id, body)
  values (p_task_id, p_body)
  returning * into created;

  insert into public.task_events (task_id, kind, meta)
  values (
    p_task_id,
    'commented',
    jsonb_build_object(
      'actor_name', coalesce(p_actor_name, ''),
      'comment_id', created.id
    )
  );
  return to_jsonb(created);
end;
$$;

create or replace function public.replace_task_dependencies(
  p_agent_id uuid,
  p_task_id uuid,
  p_waits_on uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  task_project uuid;
  wanted uuid[];
  found_count integer;
begin
  perform private.prepare_writer(p_agent_id);
  select project_id into task_project from public.tasks where id = p_task_id;
  if task_project is null then
    raise exception 'Task not found'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct item), '{}')
  into wanted
  from unnest(coalesce(p_waits_on, '{}')) as item
  where item is not null
    and item <> p_task_id;

  if coalesce(array_length(wanted, 1), 0) > 0 then
    select count(*)
    into found_count
    from public.tasks
    where id = any (wanted)
      and project_id = task_project;
    if found_count is distinct from coalesce(array_length(wanted, 1), 0) then
      raise exception 'A task can only wait on another task in the same project'
        using errcode = '42501';
    end if;
  end if;

  delete from public.task_dependencies where task_id = p_task_id;
  if coalesce(array_length(wanted, 1), 0) > 0 then
    insert into public.task_dependencies (task_id, waits_on_task_id)
    select p_task_id, item
    from unnest(wanted) as item;
  end if;

  update public.tasks
  set position = position
  where id = p_task_id;
end;
$$;

revoke all on function public.create_board_task(uuid, text, uuid, text, text, text, boolean, text, text[], double precision, uuid, uuid) from public, anon;
revoke all on function public.update_board_task(uuid, text, uuid, text, text, text, boolean, text, text[], double precision, uuid, uuid) from public, anon;
revoke all on function public.add_board_comment(uuid, text, uuid, text) from public, anon;
revoke all on function public.replace_task_dependencies(uuid, uuid, uuid[]) from public, anon;

grant execute on function public.create_board_task(uuid, text, uuid, text, text, text, boolean, text, text[], double precision, uuid, uuid) to authenticated, service_role;
grant execute on function public.update_board_task(uuid, text, uuid, text, text, text, boolean, text, text[], double precision, uuid, uuid) to authenticated, service_role;
grant execute on function public.add_board_comment(uuid, text, uuid, text) to authenticated, service_role;
grant execute on function public.replace_task_dependencies(uuid, uuid, uuid[]) to authenticated, service_role;

-- prepare_writer is security definer and was revoked from authenticated.
-- Invoker functions above call it, so authenticated needs execute, and the
-- function itself refuses to stamp an agent unless the JWT role is service_role.
grant execute on function private.prepare_writer(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- claim_next_task stamps the agent id for the author triggers
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

  perform set_config('app.agent_id', p_agent_id::text, true);

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

  insert into public.comments (task_id, body)
  values (claimed.id, comment_body);

  insert into public.task_events (task_id, kind, from_status, to_status, meta)
  values (
    claimed.id,
    'moved',
    'todo',
    'doing',
    jsonb_build_object('actor_name', agent_name)
  );

  if previous_agent is distinct from p_agent_id then
    insert into public.task_events (task_id, kind, meta)
    values (
      claimed.id,
      'assigned',
      jsonb_build_object(
        'actor_name', agent_name,
        'assignee_agent_id', p_agent_id,
        'assignee_name', agent_name
      )
    );
  end if;

  insert into public.task_events (task_id, kind, meta)
  values (
    claimed.id,
    'commented',
    jsonb_build_object('actor_name', agent_name, 'body', comment_body)
  );

  return to_jsonb(claimed);
end;
$$;

revoke all on function public.claim_next_task(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_next_task(uuid, uuid) to service_role;
