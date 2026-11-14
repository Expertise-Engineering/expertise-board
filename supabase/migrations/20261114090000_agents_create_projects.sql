-- Agents can start new regular projects.
--
-- Agents are never executives. A project created by an agent is always a regular
-- ('user') project, is stamped with the creating agent, and the stamp cannot be
-- supplied or changed by a payload. The write goes through a service-role-only
-- function so the agent id reaches the trigger inside one transaction, the same
-- way create_board_task and claim_next_task do it.

alter table public.projects
  add column created_by_agent_id uuid references public.agents (id) on delete set null;

comment on column public.projects.created_by_agent_id is
  'The agent that created this project through the MCP server. Null for projects created by a person.';

create or replace function private.bind_project_creator()
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
    if new.created_by_agent_id is distinct from old.created_by_agent_id then
      -- A nested trigger is the foreign key clearing a deleted agent.
      if pg_catalog.pg_trigger_depth() > 1 and new.created_by_agent_id is null then
        return new;
      end if;
      raise exception 'Actor columns cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if api_role = 'authenticated' then
    -- People cannot claim an agent as the creator.
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
    if new.access_class is distinct from 'user' then
      raise exception 'Agents can only create regular projects'
        using errcode = '42501';
    end if;
    new.created_by := null;
    new.created_by_agent_id := agent;
    return new;
  end if;

  return new;
end;
$$;

revoke all on function private.bind_project_creator() from public, anon, authenticated;

-- Fires after projects_assign_slug (slug and sort order) and before the
-- service-role executive guard, by trigger name order.
create trigger projects_bind_creator
  before insert or update on public.projects
  for each row
  execute function private.bind_project_creator();

create or replace function public.create_agent_project(
  p_agent_id uuid,
  p_name text,
  p_description text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned text := btrim(coalesce(p_name, ''));
  base text;
  created public.projects%rowtype;
begin
  if p_agent_id is null then
    raise exception 'Agent id is required';
  end if;
  if not exists (
    select 1 from public.agents where agents.id = p_agent_id and agents.revoked_at is null
  ) then
    raise exception 'Agent is missing or revoked';
  end if;
  if char_length(cleaned) < 1 or char_length(cleaned) > 120 then
    raise exception 'Give the project a name of 120 characters or fewer.';
  end if;
  if char_length(coalesce(p_description, '')) > 20000 then
    raise exception 'Description is too long.';
  end if;

  base := regexp_replace(lower(replace(replace(cleaned, '''', ''), '"', '')), '[^a-z0-9]+', '-', 'g');
  base := btrim(base, '-');
  base := left(base, 48);
  base := btrim(base, '-');
  if base = '' then
    base := 'project';
  end if;

  perform set_config('app.agent_id', p_agent_id::text, true);

  insert into public.projects (name, slug, description, access_class)
  values (cleaned, base, btrim(coalesce(p_description, '')), 'user')
  returning * into created;

  return to_jsonb(created);
end;
$$;

revoke all on function public.create_agent_project(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_agent_project(uuid, text, text) to service_role;
