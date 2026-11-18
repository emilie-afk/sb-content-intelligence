-- Social Submission companion: optional per-submission idempotency key on signals.
-- Separate from 20261028_ci_access_control.sql; run AFTER it and BEFORE deploying the
-- submit-signal change that sends rows with client_submission_id.
-- Additive and idempotent (safe to run twice). Existing rows and callers are unaffected:
-- the column is nullable and a UNIQUE constraint allows any number of NULLs.
-- One transaction: either everything below exists afterwards, or nothing changed.
-- (Small table: the UNIQUE index build and CHECK scan briefly lock signals. For a very large
-- table, build the index CONCURRENTLY first and add the CHECK as NOT VALID + VALIDATE.)
begin;

alter table public.signals add column if not exists client_submission_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'signals_client_submission_id_key' and conrelid = 'public.signals'::regclass) then
    alter table public.signals
      add constraint signals_client_submission_id_key unique (client_submission_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signals_client_submission_id_format' and conrelid = 'public.signals'::regclass) then
    alter table public.signals
      add constraint signals_client_submission_id_format
      check (client_submission_id is null or client_submission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
  end if;
end $$;

-- Only the intake service (service role) may set or change the id: a browser user editing
-- a signal could otherwise attach someone else's id and make that submission look delivered.
create or replace function ci_private.signals_client_id_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if ci_private.is_api_user() and (
       (tg_op = 'INSERT' and new.client_submission_id is not null) or
       (tg_op = 'UPDATE' and new.client_submission_id is distinct from old.client_submission_id)) then
    raise exception 'client_submission_id is set only by the intake service' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function ci_private.signals_client_id_guard() from public, anon, authenticated;

drop trigger if exists signals_client_id_guard on public.signals;
create trigger signals_client_id_guard
  before insert or update of client_submission_id on public.signals
  for each row execute function ci_private.signals_client_id_guard();

comment on column public.signals.client_submission_id is
  'Idempotency key sent by integrations that retry (Social Submission submission id). Set only by submit-signal (service role).';

commit;
