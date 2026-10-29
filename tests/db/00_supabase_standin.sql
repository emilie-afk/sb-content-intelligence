-- Minimal stand-in for the parts of a Supabase project that RLS depends on.
-- TEST ONLY. Mirrors Supabase: roles anon / authenticated / service_role (BYPASSRLS),
-- auth.uid()/auth.role()/auth.jwt() read the request.jwt.claims setting exactly as
-- PostgREST sets it, default grants to anon/authenticated on public objects.
create extension if not exists pgcrypto;
create schema if not exists extensions;
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
grant usage on schema public, extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
-- pgcrypto lives in "extensions" on Supabase; expose the same names there.
create or replace function extensions.digest(data text, type text) returns bytea
  language sql immutable as $$ select public.digest(data, type) $$;
create or replace function extensions.gen_random_bytes(int) returns bytea
  language sql volatile as $$ select public.gen_random_bytes($1) $$;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  last_sign_in_at timestamptz
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub','')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(auth.jwt()->>'role','') $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Supabase default privileges: everything new in public is granted to the API roles.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
