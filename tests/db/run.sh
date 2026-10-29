#!/usr/bin/env bash
# Full database test: baseline (current production shape) → findings check →
# migration (twice, idempotency) → RLS tests.  Needs a local PostgreSQL 15+.
#   PGHOST=... PGPORT=... PGUSER=postgres tests/db/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${CI_TEST_DB:-ci_rls_test}"
Q="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
"$ROOT/tests/db/load_baseline.sh" "$DB" >/dev/null 2>&1
$Q -f "$ROOT/tests/db/baseline_findings.sql"
# a reporting view like the ones production may have
$Q -c "create view public.v_signal_report as select id, topic, status from public.signals; grant select on public.v_signal_report to anon, authenticated;"
$Q -c "insert into public.settings (key, value) values ('calendar_script_url', '{\"url\":\"https://script.google.com/macros/s/TEST/exec\"}') on conflict (key) do nothing"
$Q -c "insert into public.script_outputs (id, script_title, review_status, full_voiceover_script) values ('2000000f-0000-0000-0000-000000000001','legacy used','Used in production','legacy text'), ('2000000f-0000-0000-0000-000000000002','legacy archived approved','Archived','legacy text')"
$Q -c "update public.script_outputs set approved_at = now() where id = '2000000f-0000-0000-0000-000000000002'"
$Q -c "insert into public.app_settings (id, value) values ('script_sheet', '{\"base_url\":{}}') on conflict (id) do nothing"
$Q -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" 2>&1 | grep -i "ci:" || true
$Q -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" >/dev/null 2>&1
$Q -Atc "select case when (select bool_and(content_locked and ever_approved) from script_outputs where id::text like '2000000f-%') then 'legacy approval backfill: ok' else 'FAIL legacy backfill' end"
$Q -o /dev/null -f "$ROOT/tests/db/rls_test.sql"
# Social Submission companion: client_submission_id migration (twice = idempotent) + checks
$Q -f "$ROOT/supabase/migrations/20261029_signals_client_submission_id.sql" >/dev/null
$Q -f "$ROOT/supabase/migrations/20261029_signals_client_submission_id.sql" >/dev/null
$Q -o /dev/null -f "$ROOT/tests/db/client_id_test.sql"
# two concurrent inserts of the same id with different content keys -> exactly one row
CID="7d5f6f32-5e6f-4071-8233-4e5f60718293"
psql -X -q -d "$DB" -c "begin; insert into signals (topic, status, submission_key, client_submission_id) values ('race a','New','k-race-a','$CID') on conflict (submission_key) do nothing; select pg_sleep(1); commit;" >/dev/null &
sleep 0.2; LOSER=$(psql -X -q -d "$DB" -c "insert into signals (topic, status, submission_key, client_submission_id) values ('race b','New','k-race-b','$CID') on conflict (submission_key) do nothing" 2>&1 >/dev/null || true); wait
case "$LOSER" in *signals_client_submission_id_key*) echo "concurrent loser got the id unique violation: ok";; *) echo "FAIL concurrent loser: $LOSER"; exit 1;; esac
$Q -Atc "select case when count(*) = 1 then 'concurrent client id insert: ok' else 'FAIL concurrent client id duplicates' end from signals where client_submission_id = '$CID'"
# R5: two concurrent sessions inserting the same snapshot key -> one row
VID=$($Q -Atc "insert into published_videos (video_url) values ('https://example.test/v/concurrent') returning id")
INS="insert into performance_snapshots (published_video_id, snapshot_type, views, idempotency_key) values ('$VID', '24h', 1, 'k-concurrent') on conflict (idempotency_key) do nothing"
psql -X -q -d "$DB" -c "begin; $INS; select pg_sleep(1); commit;" >/dev/null &
sleep 0.2; psql -X -q -d "$DB" -c "$INS" >/dev/null; wait
$Q -Atc "select case when count(*) = 1 then 'concurrent snapshot insert: ok' else 'FAIL concurrent snapshot duplicates' end from performance_snapshots where idempotency_key = 'k-concurrent'"
$Q -Atc "select case when has_table_privilege('anon','public.v_signal_report','select') or has_table_privilege('authenticated','public.v_signal_report','select') then 'FAIL view still readable' else 'view closed: ok' end"
$Q -Atc "select case when (select value->>'url' from ci_integration_config where key='script_apps_script') like 'https://script.google.com/%' then 'moved config: ok' else 'FAIL config not moved' end"

# Fresh install from the repository's own SQL (as changed by this work) + migration:
# must end in the same protected state.
FRESH="${DB}_fresh"
BASELINE_DIR=supabase "$ROOT/tests/db/load_baseline.sh" "$FRESH" >/dev/null 2>&1
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" >/dev/null 2>&1
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -o /dev/null -f "$ROOT/tests/db/rls_test.sql" && echo "fresh install: RLS TESTS PASSED"
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -f "$ROOT/supabase/migrations/20261029_signals_client_submission_id.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -o /dev/null -f "$ROOT/tests/db/client_id_test.sql" && echo "fresh install: CLIENT ID TESTS PASSED"
