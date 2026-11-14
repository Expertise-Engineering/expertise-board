-- Follow-up to 20261114090000_agents_create_projects.sql.
--
-- Replaces private.assign_project_slug. Does not grant anything.
--
-- Agent creates run as service_role. The previous slug function treated service_role
-- as able to see every slug, so a hidden executive project occupying "acme" came
-- back to the agent as "acme-2". Regular members already receive an opaque suffix
-- in that case. Service role is an agent write, so it follows the same rule.
--
-- The same function rejects a second regular project with the same name, ignoring
-- case and surrounding spaces, when the insert is service_role. People may still
-- create or rename to a duplicate name. Inserts and renames take one transaction
-- lock on the normalized name. The existence check is its own statement, so it
-- sees a person write that committed while this insert waited. An executive
-- project with the same name is not a duplicate and is not named in the error.

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
  existing_slug text;
  name_key text;
begin
  name_key := pg_catalog.lower(pg_catalog.btrim(coalesce(new.name, '')));

  -- Service role writes projects only for agents. Agents must not learn that an
  -- executive project holds the plain slug.
  regular_member := api_role = 'service_role'
    or (api_role = 'authenticated' and not coalesce(private.is_executive(), false));

  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(name_key, 0));
  elsif tg_op = 'UPDATE'
     and name_key is distinct from pg_catalog.lower(pg_catalog.btrim(coalesce(old.name, ''))) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(name_key, 0));
  end if;

  if tg_op = 'INSERT'
     and api_role = 'service_role'
     and coalesce(new.access_class, 'user') is distinct from 'executive' then
    select projects.slug
    into existing_slug
    from public.projects
    where projects.access_class = 'user'
      and pg_catalog.lower(pg_catalog.btrim(projects.name)) = name_key
    order by projects.sort_order, projects.created_at
    limit 1;

    if existing_slug is not null then
      raise exception using
        message = pg_catalog.format(
          'A project named "%s" already exists (slug %s). Use it instead.',
          coalesce(pg_catalog.btrim(new.name), ''),
          existing_slug
        );
    end if;
  end if;

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
