-- RLS / privilege tests. Runs against: stand-in + baseline + migration.
-- Every statement that should be refused is executed AS anon or authenticated
-- (SET ROLE + request.jwt.claims, exactly how PostgREST runs requests).
-- Synthetic data only. Any failed expectation raises and stops the run.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema if not exists t;
grant usage on schema t to anon, authenticated, service_role;

create or replace function t.expect_denied(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then return;
           when others then
             if sqlerrm ilike '%row-level security%' or sqlerrm ilike '%only an owner%' or sqlerrm ilike '%owner or admin%'
                or sqlerrm ilike '%managed by the app owner%' or sqlerrm ilike '%permission denied%' then return; end if;
             raise exception 'FAIL [%]: expected denial, got error %', p_label, sqlerrm;
  end;
  raise exception 'FAIL [%]: statement was allowed: %', p_label, p_sql;
end $$;

create or replace function t.expect_ok(p_sql text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL [%]: expected success, got %', p_label, sqlerrm;
end $$;

create or replace function t.expect_rows(p_sql text, p_n int, p_label text) returns void language plpgsql as $$
declare n int;
begin
  execute 'select count(*) from (' || p_sql || ') x' into n;
  if n <> p_n then raise exception 'FAIL [%]: expected % rows, got %', p_label, p_n, n; end if;
end $$;
-- For non-members a write must change nothing (refused or zero rows affected).
create or replace function t.expect_no_effect(p_sql text, p_label text) returns void language plpgsql as $$
declare n int;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when insufficient_privilege then return;
           when others then
             if sqlerrm ilike '%row-level security%' or sqlerrm ilike '%permission denied%' then return; end if;
             raise exception 'FAIL [%]: unexpected error %', p_label, sqlerrm;
  end;
  if n <> 0 then raise exception 'FAIL [%]: % rows changed', p_label, n; end if;
end $$;
grant execute on all functions in schema t to anon, authenticated, service_role;

-- ── seed (as postgres) ───────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test',     '{"full_name":"Owner"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@example.test',     '{"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-0000000000a3', 'assistant@example.test', '{"full_name":"Assistant"}'),
  ('00000000-0000-0000-0000-0000000000a4', 'viewer@example.test',    '{"full_name":"Viewer"}'),
  ('00000000-0000-0000-0000-0000000000a5', 'pending@example.test',   '{"full_name":"Pending","role":"admin"}'),
  ('00000000-0000-0000-0000-0000000000a6', 'revoked@example.test',   '{"full_name":"Revoked"}')
on conflict do nothing;

do $$ begin
  -- every new sign-in starts pending, whatever its metadata claims
  if (select access_status from users_profile where email = 'pending@example.test') <> 'pending' then
    raise exception 'FAIL [new sign-in]: not pending';
  end if;
  if (select role from users_profile where email = 'pending@example.test') <> 'viewer' then
    raise exception 'FAIL [new sign-in]: role taken from metadata';
  end if;
end $$;

select ci_private.bootstrap_owner('owner@example.test');
select ci_private.approve_member('admin@example.test', 'admin');
select ci_private.approve_member('assistant@example.test', 'assistant');
select ci_private.approve_member('viewer@example.test', 'viewer');
select ci_private.approve_member('revoked@example.test', 'assistant');
select ci_private.revoke_member('revoked@example.test');

insert into signals (id, topic, status, is_manual_submission) values
  ('10000000-0000-0000-0000-000000000001', 'Synthetic signal one', 'New', true),
  ('10000000-0000-0000-0000-000000000002', 'Synthetic signal two', 'New', false);
insert into script_outputs (id, script_title, review_status, full_voiceover_script) values
  ('20000000-0000-0000-0000-000000000001', 'Draft script', 'Draft', 'text'),
  ('20000000-0000-0000-0000-000000000002', 'Approved script', 'Approved', 'approved text');
insert into brand_content_rules (category, rule_name, rule_text, severity) values ('Voice', 'Synthetic rule', 'text', 'Required');
insert into learning_memory (id, applies_to, topic, status) values ('30000000-0000-0000-0000-000000000001', 'Topic', 'Synthetic', 'Needs review next time');
insert into submission_tokens (label, token_hash, allowed_action, active) values ('synthetic', encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal', true);

-- ── anon (publishable key, no session) ───────────────────────────────────────
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select t.expect_denied('select * from signals', 'anon read signals');
select t.expect_denied('select * from script_outputs', 'anon read scripts');
select t.expect_denied('select * from brand_content_rules', 'anon read brand rules');
select t.expect_denied('select * from learning_memory', 'anon read learning');
select t.expect_denied('select * from users_profile', 'anon read profiles');
select t.expect_denied('select * from submission_tokens', 'anon read tokens');
select t.expect_denied('select * from settings', 'anon read settings');
select t.expect_denied('select * from app_settings', 'anon read app_settings');
select t.expect_denied('select * from ci_integration_config', 'anon read integration config');
select t.expect_denied('select * from ci_prompt_versions', 'anon read prompts');
select t.expect_denied($q$insert into signals (topic) values ('x')$q$, 'anon insert signal');
select t.expect_denied($q$update signals set topic = 'x'$q$, 'anon update');
select t.expect_denied($q$update signals set topic = 'x'$q$, 'anon update (no grant)');
select t.expect_denied('delete from signals', 'anon delete');
select t.expect_denied($q$select ci_authorize('00000000-0000-0000-0000-0000000000a1', array['owner'], 'read', 10, 60)$q$, 'anon rpc authorize');
select t.expect_denied($q$select ci_consume_submission_token('x','submit_signal')$q$, 'anon rpc token');
select t.expect_denied($q$select ci_private.approve_member('pending@example.test','owner')$q$, 'anon approve');
select t.expect_denied('select get_user_role()', 'anon legacy rpc');
reset role; select set_config('request.jwt.claims', '', false);

-- ── authenticated but NOT approved (pending), with a forged admin claim ───────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5","role":"authenticated","user_role":"admin","app_metadata":{"role":"owner"}}', false);
select t.expect_rows('select * from signals', 0, 'pending sees no signals');
select t.expect_rows('select * from script_outputs', 0, 'pending sees no scripts');
select t.expect_rows('select * from brand_content_rules', 0, 'pending sees no brand rules');
select t.expect_rows('select * from users_profile', 1, 'pending sees only own profile');
select t.expect_denied($q$insert into signals (topic) values ('x')$q$, 'pending insert');
select t.expect_denied($q$update users_profile set role = 'owner', access_status = 'approved' where id = auth.uid()$q$, 'self-approve');
select t.expect_denied($q$insert into users_profile (id, email, role, access_status) values (gen_random_uuid(), 'x@y', 'owner', 'approved')$q$, 'insert profile');
select t.expect_denied('delete from users_profile where id = auth.uid()', 'delete own profile');
select t.expect_denied('select * from submission_tokens', 'pending read tokens');
select t.expect_denied($q$select ci_private.approve_member('pending@example.test','owner')$q$, 'pending calls owner procedure');
select t.expect_denied($q$select ci_authorize(auth.uid(), array['owner'], 'read', 10, 60)$q$, 'pending rpc authorize');
reset role; select set_config('request.jwt.claims', '', false);

-- ── revoked member ────────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a6","role":"authenticated"}', false);
select t.expect_rows('select * from signals', 0, 'revoked sees nothing');
select t.expect_no_effect($q$update signals set topic = 'x'$q$, 'revoked update');
reset role; select set_config('request.jwt.claims', '', false);

-- ── viewer: read-only ─────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', false);
select t.expect_rows('select * from signals', 2, 'viewer reads signals');
select t.expect_rows('select * from brand_content_rules', 1, 'viewer reads brand rules');
select t.expect_denied($q$insert into signals (topic) values ('x')$q$, 'viewer insert');
select t.expect_denied($q$update signals set topic = 'x' where id = '10000000-0000-0000-0000-000000000001'$q$, 'viewer update');
select t.expect_denied($q$delete from signals where id = '10000000-0000-0000-0000-000000000001'$q$, 'viewer delete');
select t.expect_denied('select * from submission_tokens', 'viewer tokens');
reset role; select set_config('request.jwt.claims', '', false);

-- ── assistant ─────────────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select t.expect_ok($q$insert into signals (topic, status) values ('assistant signal', 'New')$q$, 'assistant insert signal');
select t.expect_ok($q$update signals set status = 'Dismissed' where id = '10000000-0000-0000-0000-000000000002'$q$, 'assistant dismiss');
select t.expect_denied($q$delete from signals where id = '10000000-0000-0000-0000-000000000002'$q$, 'assistant delete');
select t.expect_ok($q$update script_outputs set review_status = 'Needs review' where id = '20000000-0000-0000-0000-000000000001'$q$, 'assistant → needs review');
select t.expect_denied($q$update script_outputs set review_status = 'Approved' where id = '20000000-0000-0000-0000-000000000001'$q$, 'assistant approve script');
select t.expect_denied($q$insert into script_outputs (script_title, review_status) values ('x', 'Approved')$q$, 'assistant insert approved');
select t.expect_denied($q$update script_outputs set full_voiceover_script = 'changed' where id = '20000000-0000-0000-0000-000000000002'$q$, 'assistant edits approved text');
select t.expect_denied($q$update script_outputs set review_status = 'Needs review' where id = '20000000-0000-0000-0000-000000000002'$q$, 'assistant unapprove');
select t.expect_ok($q$update script_outputs set review_status = 'Used in production' where id = '20000000-0000-0000-0000-000000000002'$q$, 'assistant marks used');
select t.expect_denied($q$insert into brand_content_rules (category, rule_name, rule_text, severity) values ('x','x','x','Required')$q$, 'assistant brand rule');
select t.expect_denied($q$update brand_content_rules set active = false$q$, 'assistant toggles brand rule');
select t.expect_denied($q$update learning_memory set status = 'Approved rule' where id = '30000000-0000-0000-0000-000000000001'$q$, 'assistant approves learning');
select t.expect_ok($q$update learning_memory set what_happened = 'note' where id = '30000000-0000-0000-0000-000000000001'$q$, 'assistant edits draft learning');
select t.expect_ok($q$insert into settings (key, value) values ('competitor_blocked_accounts', '[]') on conflict (key) do update set value = excluded.value$q$, 'assistant block list');
select t.expect_denied($q$insert into settings (key, value) values ('scoring_weights_x', '{}')$q$, 'assistant other setting');
select t.expect_denied($q$update users_profile set role = 'owner' where id = auth.uid()$q$, 'assistant self-promote');
select t.expect_denied('select * from submission_tokens', 'assistant tokens');
reset role; select set_config('request.jwt.claims', '', false);

-- ── admin ─────────────────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', false);
select t.expect_ok($q$update script_outputs set review_status = 'Approved', approved_by = '00000000-0000-0000-0000-0000000000a4' where id = '20000000-0000-0000-0000-000000000001'$q$, 'admin approves');
select t.expect_ok($q$delete from signals where id = '10000000-0000-0000-0000-000000000002'$q$, 'admin deletes');
select t.expect_ok($q$update brand_content_rules set active = false$q$, 'admin brand rules');
select t.expect_ok($q$update learning_memory set status = 'Approved rule' where id = '30000000-0000-0000-0000-000000000001'$q$, 'admin approves learning');
select t.expect_denied('select * from submission_tokens', 'admin tokens via API');
select t.expect_denied('select * from ci_integration_config', 'admin integration config via API');
select t.expect_denied($q$select ci_private.approve_member('pending@example.test','owner')$q$, 'admin calls owner procedure via API');
select t.expect_denied($q$select ci_private.set_maintenance(false)$q$, 'admin toggles maintenance via API');
select t.expect_rows('select * from users_profile', 4, 'admin sees approved teammates only (not pending/revoked)');
reset role; select set_config('request.jwt.claims', '', false);
do $$ begin
  if (select approved_by from script_outputs where id = '20000000-0000-0000-0000-000000000001') <> '00000000-0000-0000-0000-0000000000a2' then
    raise exception 'FAIL [approved_by]: browser-supplied approver was kept';
  end if;
  if (select reviewed_by from learning_memory where id = '30000000-0000-0000-0000-000000000001') <> '00000000-0000-0000-0000-0000000000a2' then
    raise exception 'FAIL [reviewed_by]: not recorded';
  end if;
end $$;

-- ── revocation takes effect on the next statement ─────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select t.expect_rows($q$select * from signals where id = '10000000-0000-0000-0000-000000000001'$q$, 1, 'assistant before revoke');
reset role; select set_config('request.jwt.claims', '', false);
select ci_private.revoke_member('assistant@example.test');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select t.expect_rows('select * from signals', 0, 'assistant after revoke (same token)');
select t.expect_no_effect($q$update signals set topic = 'x'$q$, 'assistant update after revoke');
reset role; select set_config('request.jwt.claims', '', false);
select ci_private.approve_member('assistant@example.test', 'assistant');

-- ── last owner/admin cannot be removed ───────────────────────────────────────
do $$ begin
  perform ci_private.revoke_member('admin@example.test');
  begin
    perform ci_private.revoke_member('owner@example.test');
    raise exception 'FAIL [last owner]: last owner was revoked';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform ci_private.approve_member('admin@example.test', 'admin');
end $$;

-- ── maintenance mode closes data to members ──────────────────────────────────
select ci_private.set_maintenance(true);
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
select t.expect_rows('select * from signals', 0, 'owner during maintenance');
reset role; select set_config('request.jwt.claims', '', false);
select ci_private.set_maintenance(false);

-- ── service role RPCs ─────────────────────────────────────────────────────────
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
do $$
declare r jsonb; ok boolean; i int; claimed int;
begin
  r := ci_authorize('00000000-0000-0000-0000-0000000000a5', array['owner','admin','assistant','viewer'], 'read', 100, 86400);
  if (r->>'ok')::boolean then raise exception 'FAIL [authorize pending]'; end if;
  r := ci_authorize('00000000-0000-0000-0000-0000000000a4', array['owner','admin','assistant'], 'ai', 100, 86400);
  if r->>'reason' <> 'forbidden' then raise exception 'FAIL [authorize viewer for writer action]: %', r; end if;
  for i in 1..3 loop
    r := ci_authorize('00000000-0000-0000-0000-0000000000a3', array['assistant'], 'ai_test', 2, 86400);
    if i <= 2 and not (r->>'ok')::boolean then raise exception 'FAIL [limit early] %', r; end if;
    if i = 3 and r->>'reason' <> 'rate_limited' then raise exception 'FAIL [limit not enforced] %', r; end if;
  end loop;
  r := ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal');
  if not (r->>'ok')::boolean then raise exception 'FAIL [token ok] %', r; end if;
  r := ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_performance_snapshot');
  if r->>'reason' <> 'wrong_action' then raise exception 'FAIL [token scope] %', r; end if;
  r := ci_consume_submission_token(encode(digest('nope','sha256'),'hex'), 'submit_signal');
  if r->>'reason' <> 'invalid' then raise exception 'FAIL [token invalid] %', r; end if;
  ok := ci_try_lock('job:a', 'h1', 60);
  if not ok then raise exception 'FAIL [lock 1]'; end if;
  ok := ci_try_lock('job:a', 'h2', 60);
  if ok then raise exception 'FAIL [lock 2 should be refused]'; end if;
  perform ci_release_lock('job:a', 'h1');
  ok := ci_try_lock('job:a', 'h2', 60);
  if not ok then raise exception 'FAIL [lock after release]'; end if;
  select count(*) into claimed from ci_claim_signals_for_clustering(10, gen_random_uuid());
  if claimed < 1 then raise exception 'FAIL [claim]'; end if;
  select count(*) into claimed from ci_claim_signals_for_clustering(10, gen_random_uuid());
  if claimed <> 0 then raise exception 'FAIL [double claim]'; end if;
end $$;
reset role; select set_config('request.jwt.claims', '', false);

-- token rate limit (hourly) is atomic
update submission_tokens set rate_limit_per_hour = 2, requests_this_hour = 0, hour_window_start = null where label = 'synthetic';
do $$ declare r jsonb; begin
  perform ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal');
  perform ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal');
  r := ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal');
  if r->>'reason' <> 'rate_limited' then raise exception 'FAIL [token hourly limit] %', r; end if;
end $$;

-- created tokens: raw value returned once, only the hash stored
do $$ declare raw text; begin
  raw := ci_private.create_submission_token('synthetic 2', 'submit_signal');
  if raw not like 'sbci_%' then raise exception 'FAIL [token format]'; end if;
  if exists (select 1 from submission_tokens where token_hash = raw) then raise exception 'FAIL [raw token stored]'; end if;
  if not exists (select 1 from submission_tokens where token_hash = encode(digest(raw,'sha256'),'hex')) then raise exception 'FAIL [hash missing]'; end if;
end $$;

-- source locations were moved out of browser-readable tables
do $$ begin
  if exists (select 1 from settings where key = 'calendar_script_url') then raise exception 'FAIL [calendar url still in settings]'; end if;
  if exists (select 1 from app_settings where id = 'script_sheet') then raise exception 'FAIL [sheet config still in app_settings]'; end if;
  begin
    insert into settings (key, value) values ('calendar_script_url', '{"url":"https://example.test"}');
    raise exception 'FAIL [constraint]: source location stored in settings';
  exception when check_violation then null; end;
end $$;

-- no permissive leftover policies and no anon grants on app tables
do $$ declare n int; begin
  select count(*) into n from pg_policies where schemaname = 'public'
     and tablename in ('signals','script_outputs','briefs','learning_memory','brand_content_rules','discovery_clusters')
     and policyname not like 'ci\_%';
  if n > 0 then raise exception 'FAIL [legacy policies remain: %]', n; end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('signals','script_outputs','briefs','learning_memory','brand_content_rules','users_profile',
                        'submission_tokens','settings','app_settings','discovery_clusters','ci_prompt_versions');
  if n > 0 then raise exception 'FAIL [anon still has % grants]', n; end if;
end $$;


-- ── review follow-ups ─────────────────────────────────────────────────────────
insert into script_outputs (id, script_title, review_status, full_voiceover_script, approved_at)
values ('20000000-0000-0000-0000-000000000003', 'Approved 2', 'Approved', 'approved text', now());
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select t.expect_ok($q$update script_outputs set review_status = 'Archived' where id = '20000000-0000-0000-0000-000000000003'$q$, 'assistant archives approved');
select t.expect_denied($q$update script_outputs set full_voiceover_script = 'rewritten' where id = '20000000-0000-0000-0000-000000000003'$q$, 'two-step rewrite after archiving');
select t.expect_denied($q$insert into script_outputs (script_title, review_status) values ('x', 'Used in production')$q$, 'assistant inserts used-in-production');
select t.expect_rows($q$select * from users_profile where access_status = 'approved'$q$, 4, 'members see approved teammates');
select t.expect_rows($q$select * from users_profile where email in ('pending@example.test','revoked@example.test')$q$, 0, 'pending/revoked not listed');
reset role; select set_config('request.jwt.claims', '', false);
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5","role":"authenticated"}', false);
select t.expect_rows('select * from users_profile', 1, 'pending still sees only own row');
reset role; select set_config('request.jwt.claims', '', false);
select ci_private.set_maintenance(true);
do $$ begin
  if (ci_consume_submission_token(encode(digest('raw-token-1','sha256'),'hex'), 'submit_signal'))->>'reason' <> 'maintenance' then
    raise exception 'FAIL [token during maintenance]';
  end if;
end $$;
select ci_private.set_maintenance(false);

\echo 'RLS TESTS PASSED'
