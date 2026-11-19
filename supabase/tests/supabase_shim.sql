-- Minimal stand-in for the pieces of a Supabase project that schema.sql
-- depends on, so the schema can be applied and tested on plain Postgres in CI.
-- This is NOT run against a real Supabase project.

-- Roles are cluster-wide, so tolerate them existing from an earlier run
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key
);

-- Supabase reads the signed-in user's id from the request's JWT claims
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase grants table privileges to these roles by default and relies on
-- row-level security to restrict them; mirror that so the tests are honest.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

create publication supabase_realtime;
