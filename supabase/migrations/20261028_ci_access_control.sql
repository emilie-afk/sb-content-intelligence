-- ============================================================================
-- SB Content Intelligence — access control hardening (2026-10-28)
--
-- Run ONCE in Supabase → SQL Editor, inside the maintenance window, AFTER the
-- backup/record step and BEFORE deploying the matching Netlify code.
-- Idempotent: safe to re-run. Changes no content rows except:
--   * moves the Apps Script URL / sheet tab mapping out of browser-readable
--     settings into the private table ci_integration_config (copied, then removed)
--   * sets users_profile.access_status from the existing role/active columns.
--
-- What it does
--   1. Private helper schema ci_private (NOT exposed by the Data API).
--   2. Membership: users_profile.access_status = pending | approved | revoked.
--      New sign-ins are 'pending'. Only approved members get any app data.
--      No API role can write users_profile (no self-approval / self-promotion).
--   3. Replaces EVERY existing policy on this app's tables (dynamic drop) with
--      approved-member, role-specific policies; anon gets no table privileges.
--   4. Row rules: only owner/admin approve scripts or learning rules, delete rows,
--      manage brand rules, plant watchlist and most settings.
--   5. Private server-only tables: integration config, prompt versions, usage
--      counters, job locks. Submission tokens are server-only.
--   6. Service-role RPCs used by the Netlify Functions (authorization, durable
--      limits, locks, token consumption, clustering claims, prompt versions).
--   7. Closes views over these tables to the API and revokes legacy function
--      execution from anon.
--
-- It does not touch tables of other apps sharing this project (e.g. Keyword
-- Intelligence: gsc_uploads, search_queries, ad_keywords, keyword_projects,
-- app_members, app_prompt_versions, app_usage_limits, schema app_private).
-- ============================================================================

begin;

create schema if not exists ci_private;
revoke all on schema ci_private from public;
grant usage on schema ci_private to authenticated, service_role;

-- ── 1. Membership columns ─────────────────────────────────────────────────────
alter table public.users_profile
  add column if not exists access_status text,
  add column if not exists access_decided_at timestamptz,
  add column if not exists access_note text;

-- Backfill once (only rows that have no status yet).
-- Staff roles were granted deliberately by an admin (default is 'viewer'), so they
-- stay approved; 'viewer' rows were created automatically for ANY sign-in and start
-- as pending until an owner approves them (see rollout step "review members").
update public.users_profile
   set access_status = case
         when coalesce(active, true) = false then 'revoked'
         when role in ('owner','admin','assistant') then 'approved'
         else 'pending' end,
       access_decided_at = now(),
       access_note = 'backfilled by 20261028 migration'
 where access_status is null;

alter table public.users_profile alter column access_status set default 'pending';
alter table public.users_profile alter column access_status set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_profile_access_status_check') then
    alter table public.users_profile add constraint users_profile_access_status_check
      check (access_status in ('pending','approved','revoked'));
  end if;
end $$;
alter table public.users_profile alter column role set default 'viewer';

-- ── 2. Private tables (server-only; RLS on, no policies, no API grants) ───────
create table if not exists public.ci_integration_config (
  key        text primary key check (key in ('script_sheet','script_apps_script','video_tracker','maintenance')),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists public.ci_prompt_versions (
  id          bigint generated always as identity primary key,
  prompt_set  text not null default 'content',
  version     int  not null,
  content     jsonb not null,
  note        text,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  text,
  unique (prompt_set, version)
);
create unique index if not exists ci_prompt_versions_one_active on public.ci_prompt_versions (prompt_set) where is_active;
create table if not exists public.ci_usage_counters (
  subject      text not null,
  bucket       text not null,
  window_start timestamptz not null,
  count        int  not null default 0,
  primary key (subject, bucket, window_start)
);
create table if not exists public.ci_locks (
  key        text primary key,
  holder     text not null,
  expires_at timestamptz not null
);
alter table public.ci_integration_config enable row level security;
alter table public.ci_prompt_versions    enable row level security;
alter table public.ci_usage_counters     enable row level security;
alter table public.ci_locks              enable row level security;
revoke all on public.ci_integration_config, public.ci_prompt_versions, public.ci_usage_counters, public.ci_locks
  from public, anon, authenticated;
grant select, insert, update, delete on public.ci_integration_config, public.ci_prompt_versions,
  public.ci_usage_counters, public.ci_locks to service_role;

-- Move source locations out of browser-readable tables (copy first, then remove).
do $$
declare v jsonb;
begin
  if to_regclass('public.settings') is not null then
    select value into v from public.settings where key = 'calendar_script_url';
    if v is not null then
      insert into public.ci_integration_config (key, value, updated_by)
      values ('script_apps_script', v, 'migration 20261028')
      on conflict (key) do nothing;
      delete from public.settings where key = 'calendar_script_url';
    end if;
  end if;
  if to_regclass('public.app_settings') is not null then
    select value into v from public.app_settings where id = 'script_sheet';
    if v is not null then
      insert into public.ci_integration_config (key, value, updated_by)
      values ('script_sheet', v, 'migration 20261028')
      on conflict (key) do nothing;
      delete from public.app_settings where id = 'script_sheet';
    end if;
  end if;
end $$;

-- ── 3. Workflow columns used for idempotency / job claims ─────────────────────
alter table public.signals
  add column if not exists submission_key text,
  add column if not exists clustering_claim uuid,
  add column if not exists clustering_claimed_at timestamptz;
create unique index if not exists signals_submission_key_uniq on public.signals (submission_key);

do $$ begin
  if to_regclass('public.script_outputs') is not null then
    alter table public.script_outputs
      add column if not exists sheet_exported_at timestamptz,
      add column if not exists sheet_export_ref text;
  end if;
end $$;

-- ── 4. Helper functions (ci_private; evaluated inside RLS policies) ───────────
create or replace function ci_private.maintenance_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value->>'enabled')::boolean from public.ci_integration_config where key = 'maintenance'), false)
$$;

create or replace function ci_private.member_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when ci_private.maintenance_on() then null else
    (select p.role from public.users_profile p
      where p.id = auth.uid() and p.access_status = 'approved'
        and p.role in ('owner','admin','assistant','viewer'))
  end
$$;

create or replace function ci_private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select ci_private.member_role() is not null
$$;

create or replace function ci_private.has_role(roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(ci_private.member_role() = any (roles), false)
$$;

-- True when the current statement comes from a signed-in browser session
-- (PostgREST role "authenticated"); false for service_role and SQL editor.
create or replace function ci_private.is_api_user() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.role(), '') in ('authenticated','anon')
$$;

revoke all on all functions in schema ci_private from public, anon, authenticated;
grant execute on function ci_private.maintenance_on(), ci_private.member_role(), ci_private.is_member(),
  ci_private.has_role(text[]), ci_private.is_api_user() to authenticated, service_role;

-- ── 5. Row-level guards (triggers) ────────────────────────────────────────────
-- Deletes by browser users require owner/admin; raises a clear error instead of
-- silently deleting nothing.
create or replace function ci_private.guard_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if ci_private.is_api_user() and not ci_private.has_role(array['owner','admin']) then
    raise exception 'Only an owner or admin can delete %', tg_table_name using errcode = '42501';
  end if;
  return old;
end $$;

-- Script approval stays a human owner/admin decision. Assistants can draft, edit
-- and move scripts to review, mark approved scripts used/archived, but cannot
-- approve, un-approve or change the text of an approved script.
create or replace function ci_private.guard_script_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  is_admin boolean := ci_private.has_role(array['owner','admin']);
  content_cols text[] := array['script_title','opening_hook','thumbnail_title','full_voiceover_script','on_screen_text',
                               'shot_list','broll_notes','product_mention','cta','caption','hashtags','platform','script_type'];
  c text;
begin
  if not ci_private.is_api_user() then return new; end if;
  if tg_op = 'INSERT' then
    if new.review_status = 'Approved' and not is_admin then
      raise exception 'Only an owner or admin can approve scripts' using errcode = '42501';
    end if;
    if new.review_status = 'Approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
    end if;
    return new;
  end if;
  if new.review_status is distinct from old.review_status then
    if new.review_status = 'Approved' and not is_admin then
      raise exception 'Only an owner or admin can approve scripts' using errcode = '42501';
    end if;
    if old.review_status = 'Approved' and new.review_status not in ('Used in production','Archived','Measured') and not is_admin then
      raise exception 'Only an owner or admin can un-approve a script' using errcode = '42501';
    end if;
    if new.review_status = 'Approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
    end if;
  elsif old.review_status = 'Approved' then
    -- keep approval metadata trustworthy
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  end if;
  if old.review_status = 'Approved' and not is_admin then
    foreach c in array content_cols loop
      if (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
        raise exception 'Approved scripts can only be edited by an owner or admin' using errcode = '42501';
      end if;
    end loop;
  end if;
  return new;
end $$;

-- Learning rules feed every generation prompt: only owner/admin promote a memory
-- to 'Approved rule' or change an approved rule.
create or replace function ci_private.guard_learning_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare is_admin boolean := ci_private.has_role(array['owner','admin']);
begin
  if not ci_private.is_api_user() or is_admin then
    if ci_private.is_api_user() and new.status = 'Approved rule'
       and (tg_op = 'INSERT' or old.status is distinct from 'Approved rule') then
      new.reviewed_by := auth.uid();
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' and new.status = 'Approved rule' then
    raise exception 'Only an owner or admin can approve learning rules' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.status = 'Approved rule' or new.status = 'Approved rule') then
    raise exception 'Only an owner or admin can approve or change approved learning rules' using errcode = '42501';
  end if;
  return new;
end $$;

-- Membership/role columns can never be changed through the API (defence in depth;
-- the API roles also have no write privilege on users_profile).
create or replace function ci_private.guard_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if ci_private.is_api_user() then
    raise exception 'Membership is managed by the app owner' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

revoke all on function ci_private.guard_delete(), ci_private.guard_script_approval(),
  ci_private.guard_learning_approval(), ci_private.guard_profile() from public, anon, authenticated;

-- ── 6. Policy builder ─────────────────────────────────────────────────────────
-- apply(table, read, insert_roles, update_roles, delete_roles)
--   read: 'members' (any approved role) | 'none'
--   *_roles: roles allowed for that command; empty array = no API access for it.
-- Drops EVERY existing policy on the table first so no permissive leftover remains.
create or replace function ci_private.apply_policies(
  p_table text, p_read text, p_insert text[], p_update text[], p_delete text[]
) returns void language plpgsql security definer set search_path = '' as $$
declare
  rel regclass := to_regclass('public.' || p_table);
  pol record;
begin
  if rel is null then
    raise notice 'ci: table % not found — skipped', p_table;
    return;
  end if;
  execute format('alter table public.%I enable row level security', p_table);
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = p_table loop
    execute format('drop policy %I on public.%I', pol.policyname, p_table);
  end loop;
  execute format('revoke all on public.%I from public, anon, authenticated', p_table);
  execute format('grant all on public.%I to service_role', p_table);

  if p_read = 'members' then
    execute format('grant select on public.%I to authenticated', p_table);
    execute format('create policy ci_select on public.%I for select to authenticated using ((select ci_private.is_member()))', p_table);
  end if;
  if coalesce(array_length(p_insert, 1), 0) > 0 then
    execute format('grant insert on public.%I to authenticated', p_table);
    execute format('create policy ci_insert on public.%I for insert to authenticated with check (ci_private.has_role(%L::text[]))', p_table, p_insert);
  end if;
  if coalesce(array_length(p_update, 1), 0) > 0 then
    execute format('grant update on public.%I to authenticated', p_table);
    -- USING = visible to members, WITH CHECK = role → a viewer gets an error, not a silent no-op
    execute format('create policy ci_update on public.%I for update to authenticated using ((select ci_private.is_member())) with check (ci_private.has_role(%L::text[]))', p_table, p_update);
  end if;
  if coalesce(array_length(p_delete, 1), 0) > 0 then
    execute format('grant delete on public.%I to authenticated', p_table);
    execute format('create policy ci_delete on public.%I for delete to authenticated using ((select ci_private.is_member()))', p_table);
    execute format('drop trigger if exists ci_guard_delete on public.%I', p_table);
    execute format('create trigger ci_guard_delete before delete on public.%I for each row execute function ci_private.guard_delete()', p_table);
  else
    execute format('drop trigger if exists ci_guard_delete on public.%I', p_table);
  end if;
end $$;
revoke all on function ci_private.apply_policies(text, text, text[], text[], text[]) from public, anon, authenticated;

-- ── 7. Apply the access matrix ────────────────────────────────────────────────
do $$
declare
  W text[] := array['owner','admin','assistant'];   -- writers
  A text[] := array['owner','admin'];               -- admins
  N text[] := array[]::text[];                      -- nobody (API)
begin
  -- content workflow: members read, writers create/update, admins delete
  perform ci_private.apply_policies('signals',                    'members', W, W, A);
  perform ci_private.apply_policies('sources',                    'members', W, W, A);
  perform ci_private.apply_policies('opportunities',              'members', W, W, A);
  perform ci_private.apply_policies('opportunity_sources',        'members', W, W, A);
  perform ci_private.apply_policies('briefs',                     'members', W, W, A);
  perform ci_private.apply_policies('script_outputs',             'members', W, W, A);
  perform ci_private.apply_policies('published_videos',           'members', W, W, A);
  perform ci_private.apply_policies('learning_memory',            'members', W, W, A);
  perform ci_private.apply_policies('discovery_clusters',         'members', W, W, A);
  perform ci_private.apply_policies('signal_cluster_links',       'members', W, W, A);
  perform ci_private.apply_policies('content_review_candidates',  'members', W, W, A);
  perform ci_private.apply_policies('today_board_items',          'members', N, W, A);
  perform ci_private.apply_policies('cluster_review_suggestions', 'members', N, W, A);
  perform ci_private.apply_policies('competitor_activity',        'members', N, W, A);
  perform ci_private.apply_policies('market_watch_plants',        'members', N, W, A);
  perform ci_private.apply_policies('market_watch_signal_links',  'members', N, N, A);
  -- admin-managed reference data
  perform ci_private.apply_policies('brand_content_rules',        'members', A, A, A);
  perform ci_private.apply_policies('plant_watchlist',            'members', A, A, A);
  perform ci_private.apply_policies('settings',                   'members', W, W, A);
  -- read-only history / docs (written by triggers and Functions)
  perform ci_private.apply_policies('performance_snapshots',      'members', N, N, N);
  perform ci_private.apply_policies('activity_log',               'members', N, N, N);
  perform ci_private.apply_policies('cluster_audit_log',          'members', N, N, N);
  perform ci_private.apply_policies('discovery_briefings',        'members', N, N, N);
  perform ci_private.apply_policies('help_docs',                  'members', N, N, N);
  -- server-only
  perform ci_private.apply_policies('submission_tokens',          'none', N, N, N);
  perform ci_private.apply_policies('app_settings',               'none', N, N, N);
  perform ci_private.apply_policies('sb_products',                'none', N, N, N);
  perform ci_private.apply_policies('agent_run_log',              'none', N, N, N);
  perform ci_private.apply_policies('agent_action_log',           'none', N, N, N);
  perform ci_private.apply_policies('users_profile',              'none', N, N, N);
end $$;

-- users_profile: each signed-in user may read ONLY their own row (to see
-- "waiting for approval"); nobody writes through the API.
grant select on public.users_profile to authenticated;
create policy ci_select_own on public.users_profile for select to authenticated using (id = auth.uid());
drop trigger if exists ci_guard_profile on public.users_profile;
create trigger ci_guard_profile before insert or update or delete on public.users_profile
  for each row execute function ci_private.guard_profile();

-- settings: writers may only maintain the competitor block list; every other key
-- needs owner/admin. Source locations may never be stored here again.
drop policy if exists ci_insert on public.settings;
drop policy if exists ci_update on public.settings;
create policy ci_insert on public.settings for insert to authenticated
  with check (ci_private.has_role(array['owner','admin'])
              or (ci_private.has_role(array['assistant']) and key = 'competitor_blocked_accounts'));
create policy ci_update on public.settings for update to authenticated
  using ((select ci_private.is_member()))
  with check (ci_private.has_role(array['owner','admin'])
              or (ci_private.has_role(array['assistant']) and key = 'competitor_blocked_accounts'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_no_source_locations') then
    alter table public.settings add constraint settings_no_source_locations
      check (key not in ('calendar_script_url','script_sheet','video_tracker_url','apps_script_url'));
  end if;
end $$;

-- approval guards
do $$ begin
  if to_regclass('public.script_outputs') is not null then
    drop trigger if exists ci_guard_script_approval on public.script_outputs;
    create trigger ci_guard_script_approval before insert or update on public.script_outputs
      for each row execute function ci_private.guard_script_approval();
  end if;
  if to_regclass('public.learning_memory') is not null then
    drop trigger if exists ci_guard_learning_approval on public.learning_memory;
    create trigger ci_guard_learning_approval before insert or update on public.learning_memory
      for each row execute function ci_private.guard_learning_approval();
  end if;
end $$;

-- Sequences: API roles need no direct sequence access (uuid defaults).
-- ── 8. New sign-ins start as pending viewers ──────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users_profile (id, email, display_name, role, access_status)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.email),
          'viewer', 'pending')
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Legacy helper: now reports only an APPROVED role; not callable by anon.
create or replace function public.get_user_role()
returns text language sql stable security definer set search_path = '' as $$
  select ci_private.member_role()
$$;
revoke all on function public.get_user_role() from public, anon;
grant execute on function public.get_user_role() to authenticated, service_role;

do $$
declare f text;
begin
  foreach f in array array['public.log_opportunity_decision()','public.log_brief_status()','public.log_script_status()',
                           'public.calc_opportunity_score()','public.update_updated_at()'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- ── 9. Service-role RPCs (called only by Netlify Functions) ───────────────────
create or replace function public.ci_consume_usage(p_subject text, p_bucket text, p_limit int, p_window_seconds int, p_cost int default 1)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ws timestamptz; n int;
begin
  if p_limit is null or p_limit <= 0 then return true; end if;
  ws := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.ci_usage_counters as c (subject, bucket, window_start, count)
  values (p_subject, p_bucket, ws, p_cost)
  on conflict (subject, bucket, window_start)
    do update set count = c.count + p_cost where c.count + p_cost <= p_limit
  returning c.count into n;
  if n is null or n > p_limit then return false; end if;
  -- opportunistic cleanup of old windows
  if random() < 0.01 then delete from public.ci_usage_counters where window_start < now() - interval '14 days'; end if;
  return true;
end $$;

create or replace function public.ci_authorize(p_user uuid, p_roles text[], p_bucket text, p_limit int, p_window_seconds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if ci_private.maintenance_on() then return jsonb_build_object('ok', false, 'reason', 'maintenance'); end if;
  select p.role, p.access_status, p.email into r from public.users_profile p where p.id = p_user;
  if r is null or r.access_status <> 'approved' or r.role not in ('owner','admin','assistant','viewer') then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  if not (r.role = any (p_roles)) then return jsonb_build_object('ok', false, 'reason', 'forbidden', 'role', r.role); end if;
  if not public.ci_consume_usage('user:' || p_user::text, coalesce(p_bucket, 'read'), p_limit, p_window_seconds) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'role', r.role);
  end if;
  return jsonb_build_object('ok', true, 'role', r.role, 'email', r.email);
end $$;

create or replace function public.ci_authorize_service(p_scope text, p_bucket text, p_limit int, p_window_seconds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if ci_private.maintenance_on() then return jsonb_build_object('ok', false, 'reason', 'maintenance'); end if;
  if not public.ci_consume_usage('service:' || p_scope, coalesce(p_bucket, p_scope), p_limit, p_window_seconds) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ci_try_lock(p_key text, p_holder text, p_ttl_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  insert into public.ci_locks as l (key, holder, expires_at)
  values (p_key, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at < now()
  returning l.holder into h;
  return h = p_holder;
end $$;

create or replace function public.ci_release_lock(p_key text, p_holder text)
returns void language sql security definer set search_path = '' as $$
  delete from public.ci_locks where key = p_key and holder = p_holder
$$;

-- Atomic token check + hourly rate limit. Returns {ok,id,label} or {ok:false,reason}.
create or replace function public.ci_consume_submission_token(p_hash text, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  update public.submission_tokens s
     set requests_this_hour = case when s.hour_window_start is null or s.hour_window_start < now() - interval '1 hour'
                                   then 1 else coalesce(s.requests_this_hour, 0) + 1 end,
         hour_window_start  = case when s.hour_window_start is null or s.hour_window_start < now() - interval '1 hour'
                                   then now() else s.hour_window_start end,
         last_used_at = now()
   where s.token_hash = p_hash
     and coalesce(s.active, false)
     and (s.expires_at is null or s.expires_at > now())
     and s.allowed_action = p_action
     and (s.hour_window_start is null or s.hour_window_start < now() - interval '1 hour'
          or coalesce(s.requests_this_hour, 0) < coalesce(s.rate_limit_per_hour, case when p_action = 'submit_signal' then 500 else 100 end))
  returning s.id, s.label into t;
  if t.id is not null then return jsonb_build_object('ok', true, 'id', t.id, 'label', t.label); end if;

  select s.active, s.expires_at, s.allowed_action into t from public.submission_tokens s where s.token_hash = p_hash;
  if not found or not coalesce(t.active, false) or (t.expires_at is not null and t.expires_at <= now()) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if t.allowed_action is distinct from p_action then return jsonb_build_object('ok', false, 'reason', 'wrong_action'); end if;
  return jsonb_build_object('ok', false, 'reason', 'rate_limited');
end $$;

-- Claim up to p_limit New signals for clustering (no double dispatch across
-- overlapping runs). Returns the claimed rows.
create or replace function public.ci_claim_signals_for_clustering(p_limit int, p_claim uuid)
returns setof public.signals language sql security definer set search_path = '' as $$
  with c as (
    select id from public.signals
     where status = 'New'
     order by created_at
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  )
  update public.signals s
     set status = 'Clustering', clustering_claim = p_claim, clustering_claimed_at = now()
    from c where s.id = c.id
  returning s.*
$$;

-- Claim one signal. With p_expected (background job) the existing claim must
-- match; without it (interactive) any signal not currently being clustered is
-- claimed. Returns the previous status, or null when not claimed.
create or replace function public.ci_claim_signal(p_id uuid, p_claim uuid, p_expected uuid default null)
returns text language plpgsql security definer set search_path = '' as $$
declare prev text;
begin
  if p_expected is not null then
    update public.signals set clustering_claim = p_claim, clustering_claimed_at = now()
     where id = p_id and status = 'Clustering' and clustering_claim = p_expected
    returning 'Clustering' into prev;
    return prev;
  end if;
  select status into prev from public.signals where id = p_id for update;
  if not found then return null; end if;
  if prev = 'Clustering' and exists (select 1 from public.signals where id = p_id
         and clustering_claimed_at > now() - interval '15 minutes') then
    return null;
  end if;
  update public.signals set status = 'Clustering', clustering_claim = p_claim, clustering_claimed_at = now() where id = p_id;
  return prev;
end $$;

create or replace function public.ci_create_prompt_version(p_set text, p_content jsonb, p_note text, p_created_by text, p_activate boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v int; new_id bigint; k text;
begin
  if p_content is null or jsonb_typeof(p_content->'templates') <> 'object' then
    raise exception 'content must be an object with a "templates" object';
  end if;
  for k in select jsonb_object_keys(p_content->'templates') loop
    if jsonb_typeof(p_content->'templates'->k) <> 'string' then raise exception 'template % is not text', k; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtext('ci_prompt_versions:' || p_set));
  select coalesce(max(version), 0) + 1 into v from public.ci_prompt_versions where prompt_set = p_set;
  insert into public.ci_prompt_versions (prompt_set, version, content, note, created_by)
  values (p_set, v, p_content, p_note, p_created_by) returning id into new_id;
  if p_activate then perform public.ci_activate_prompt_version(new_id); end if;
  return new_id;
end $$;

create or replace function public.ci_activate_prompt_version(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  select prompt_set into s from public.ci_prompt_versions where id = p_id;
  if s is null then raise exception 'prompt version % not found', p_id; end if;
  perform pg_advisory_xact_lock(hashtext('ci_prompt_versions:' || s));
  update public.ci_prompt_versions set is_active = false where prompt_set = s and is_active and id <> p_id;
  update public.ci_prompt_versions set is_active = true where id = p_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.ci_consume_usage(text,text,integer,integer,integer)',
    'public.ci_authorize(uuid,text[],text,integer,integer)',
    'public.ci_authorize_service(text,text,integer,integer)',
    'public.ci_try_lock(text,text,integer)',
    'public.ci_release_lock(text,text)',
    'public.ci_consume_submission_token(text,text)',
    'public.ci_claim_signals_for_clustering(integer,uuid)',
    'public.ci_claim_signal(uuid,uuid,uuid)',
    'public.ci_create_prompt_version(text,jsonb,text,text,boolean)',
    'public.ci_activate_prompt_version(bigint)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── 10. Owner procedures (SQL editor only; not callable through the API) ─────
create or replace function ci_private.set_member(p_email text, p_status text, p_role text default null, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid; cur record; remaining int;
begin
  if p_status not in ('pending','approved','revoked') then raise exception 'status must be pending, approved or revoked'; end if;
  if p_role is not null and p_role not in ('owner','admin','assistant','viewer') then raise exception 'invalid role %', p_role; end if;
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(p_email));
  if uid is null then
    raise exception 'No account for that email yet. The person must sign in with Google once first.';
  end if;
  insert into public.users_profile (id, email, display_name, role, access_status)
  select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.email), 'viewer', 'pending'
    from auth.users u where u.id = uid
  on conflict (id) do nothing;
  select role, access_status into cur from public.users_profile where id = uid;
  -- never remove the last approved owner/admin
  if cur.role in ('owner','admin') and cur.access_status = 'approved'
     and (p_status <> 'approved' or coalesce(p_role, cur.role) not in ('owner','admin')) then
    select count(*) into remaining from public.users_profile
     where access_status = 'approved' and role in ('owner','admin') and id <> uid;
    if remaining = 0 then raise exception 'Refusing: this is the last approved owner/admin'; end if;
  end if;
  update public.users_profile
     set access_status = p_status, role = coalesce(p_role, role),
         active = (p_status = 'approved'), access_decided_at = now(),
         access_note = coalesce(p_note, access_note)
   where id = uid;
  return format('%s → %s (%s)', p_email, p_status, coalesce(p_role, cur.role));
end $$;

create or replace function ci_private.approve_member(p_email text, p_role text default 'viewer')
returns text language sql security definer set search_path = '' as $$
  select ci_private.set_member(p_email, 'approved', p_role, 'approved by owner')
$$;
create or replace function ci_private.revoke_member(p_email text)
returns text language sql security definer set search_path = '' as $$
  select ci_private.set_member(p_email, 'revoked', null, 'revoked by owner')
$$;
create or replace function ci_private.bootstrap_owner(p_email text)
returns text language sql security definer set search_path = '' as $$
  select ci_private.set_member(p_email, 'approved', 'owner', 'owner bootstrap')
$$;
create or replace function ci_private.list_members()
returns table (email text, role text, access_status text, access_decided_at timestamptz, last_sign_in timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.email, p.role, p.access_status, p.access_decided_at, u.last_sign_in_at
    from public.users_profile p left join auth.users u on u.id = p.id
   order by p.access_status, p.role, p.email
$$;

-- Submission tokens: the raw token is returned ONCE; only its SHA-256 is stored.
create or replace function ci_private.create_submission_token(p_label text, p_action text, p_rate_limit_per_hour int default null, p_expires_at timestamptz default null)
returns text language plpgsql security definer set search_path = '' as $$
declare raw text := 'sbci_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  if p_action not in ('submit_signal','submit_performance_snapshot') then raise exception 'invalid action'; end if;
  insert into public.submission_tokens (label, token_hash, allowed_action, active, expires_at, rate_limit_per_hour)
  values (p_label, encode(extensions.digest(raw, 'sha256'), 'hex'), p_action, true, p_expires_at,
          coalesce(p_rate_limit_per_hour, case when p_action = 'submit_signal' then 500 else 100 end));
  return raw;
end $$;
create or replace function ci_private.revoke_submission_token(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.submission_tokens set active = false where id = p_id
$$;

create or replace function ci_private.set_maintenance(p_enabled boolean)
returns text language sql security definer set search_path = '' as $$
  insert into public.ci_integration_config (key, value, updated_by)
  values ('maintenance', jsonb_build_object('enabled', p_enabled), 'sql editor')
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  select case when p_enabled then 'maintenance ON: app data closed to all browser users and services'
              else 'maintenance OFF' end
$$;

revoke all on all functions in schema ci_private from public, anon, authenticated;
grant execute on function ci_private.maintenance_on(), ci_private.member_role(), ci_private.is_member(),
  ci_private.has_role(text[]), ci_private.is_api_user() to authenticated, service_role;

-- ── 11. Views over this app's tables: close them to the API ──────────────────
-- (Views run with their owner's rights and would bypass RLS.) Reported, not dropped.
do $$
declare v record;
begin
  for v in
    with recursive app_tables(oid) as (
      select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any (array['users_profile','sources','signals','opportunities',
         'opportunity_sources','briefs','published_videos','performance_snapshots','learning_memory','submission_tokens',
         'settings','script_outputs','brand_content_rules','activity_log','plant_watchlist','discovery_clusters',
         'signal_cluster_links','content_review_candidates','competitor_activity','market_watch_plants',
         'market_watch_signal_links','sb_products','help_docs','app_settings','agent_run_log','agent_action_log',
         'cluster_audit_log','today_board_items','cluster_review_suggestions','discovery_briefings',
         'ci_integration_config','ci_prompt_versions','ci_usage_counters','ci_locks'])
    ), deps(oid) as (
      select oid from app_tables
      union
      select distinct r.ev_class from pg_rewrite r join pg_depend d on d.objid = r.oid
        join deps on d.refobjid = deps.oid where r.ev_class <> deps.oid
    )
    select n.nspname, c.relname from deps join pg_class c on c.oid = deps.oid
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('v','m') and n.nspname = 'public'
  loop
    execute format('revoke all on %I.%I from public, anon, authenticated', v.nspname, v.relname);
    raise notice 'ci: view %.% reads protected tables — closed to the API (review before re-granting)', v.nspname, v.relname;
  end loop;
end $$;

commit;
