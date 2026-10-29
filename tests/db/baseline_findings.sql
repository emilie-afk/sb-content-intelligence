-- Confirms the earlier review's database findings on the PRE-migration schema:
-- any signed-in account (even one nobody approved) can update and delete content.
\set ON_ERROR_STOP 1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000bad1', 'stranger@example.test') on conflict do nothing;
insert into signals (id, topic, status) values ('10000000-0000-0000-0000-0000000000ff', 'baseline', 'New') on conflict do nothing;
insert into brand_content_rules (category, rule_name, rule_text, severity) values ('x','baseline rule','x','Required');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000bad1","role":"authenticated"}', false);
do $$ declare n int; begin
  select count(*) into n from signals;                     if n = 0 then raise exception 'baseline: stranger cannot read (finding not reproduced)'; end if;
  update brand_content_rules set rule_text = 'tampered' where rule_name = 'baseline rule';
  get diagnostics n = row_count;                           if n = 0 then raise exception 'baseline: brand rule update refused'; end if;
  delete from signals where id = '10000000-0000-0000-0000-0000000000ff';
  get diagnostics n = row_count;                           if n = 0 then raise exception 'baseline: delete refused'; end if;
  raise notice 'BASELINE FINDING CONFIRMED: unapproved account read %, updated brand rules and deleted a signal', 'signals';
end $$;
reset role; select set_config('request.jwt.claims', '', false);
delete from brand_content_rules where rule_name = 'baseline rule';
delete from users_profile where email = 'stranger@example.test';
delete from auth.users where email = 'stranger@example.test';
