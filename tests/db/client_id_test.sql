-- client_submission_id migration (Social Submission companion). Runs after rls_test.sql
-- (reuses its t.* helpers and synthetic users). Any failed expectation raises.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- schema
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='signals' and column_name='client_submission_id')
    then raise exception 'FAIL column missing'; end if;
  if not exists (select 1 from pg_constraint where conname='signals_client_submission_id_key' and contype='u')
    then raise exception 'FAIL unique constraint missing'; end if;
end $$;

-- service role (how submit-signal writes)
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select t.expect_ok($q$insert into signals (topic, status, submission_key, client_submission_id) values ('cid one', 'New', 'k-cid-1', '3f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')$q$, 'service insert with id');
-- retry with the same content key: ON CONFLICT (submission_key) DO NOTHING → no error, no row
select t.expect_ok($q$insert into signals (topic, status, submission_key, client_submission_id) values ('cid one', 'New', 'k-cid-1', '3f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f') on conflict (submission_key) do nothing$q$, 'same key retry');
-- same id, different content key: the id constraint is NOT the arbiter → 23505 on that constraint
do $$ begin
  insert into signals (topic, status, submission_key, client_submission_id) values ('cid one edited', 'New', 'k-cid-1b', '3f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f') on conflict (submission_key) do nothing;
  raise exception 'FAIL duplicate id accepted';
exception when unique_violation then
  if sqlerrm not like '%signals_client_submission_id_key%' then raise exception 'FAIL wrong constraint: %', sqlerrm; end if;
end $$;
-- NULL ids are unlimited (old callers)
select t.expect_ok($q$insert into signals (topic, status, submission_key) values ('no id a', 'New', 'k-noid-a'), ('no id b', 'New', 'k-noid-b')$q$, 'null ids');
-- format check
do $$ begin
  insert into signals (topic, status, submission_key, client_submission_id) values ('bad', 'New', 'k-bad', 'not-a-uuid');
  raise exception 'FAIL bad id format accepted';
exception when check_violation then null; end $$;
reset role; select set_config('request.jwt.claims', '', false);

-- an unrelated unique violation names a different constraint (submit-signal must not acknowledge it)
create unique index if not exists t_signals_search_tag_uniq on public.signals (search_tag) where search_tag = 't-unrelated';
insert into signals (topic, status, submission_key, search_tag) values ('tag a', 'New', 'k-tag-a', 't-unrelated');
do $$ begin
  insert into signals (topic, status, submission_key, search_tag, client_submission_id) values ('tag b', 'New', 'k-tag-b', 't-unrelated', '4a2d3c0f-2b3c-4d4e-9f00-1b2c3d4e5f60') on conflict (submission_key) do nothing;
  raise exception 'FAIL unrelated duplicate accepted';
exception when unique_violation then
  if sqlerrm like '%client_submission_id%' then raise exception 'FAIL unrelated violation looks like an id conflict: %', sqlerrm; end if;
end $$;
drop index t_signals_search_tag_uniq;

-- browser users (assistant = writer) cannot set or change the id
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select t.expect_ok($q$insert into signals (topic, status) values ('assistant row without id', 'New')$q$, 'assistant insert without id');
select t.expect_denied($q$insert into signals (topic, status, client_submission_id) values ('assistant with id', 'New', '5b3e4d10-3c4d-4e5f-a011-2c3d4e5f6071')$q$, 'assistant insert with id');
select t.expect_denied($q$update signals set client_submission_id = '6c4f5e21-4d5e-4f60-b122-3d4e5f607182' where topic = 'assistant row without id'$q$, 'assistant set id');
select t.expect_ok($q$update signals set status = 'Dismissed' where topic = 'assistant row without id'$q$, 'assistant other edits unaffected');
reset role; select set_config('request.jwt.claims', '', false);

\echo 'CLIENT ID TESTS PASSED'
