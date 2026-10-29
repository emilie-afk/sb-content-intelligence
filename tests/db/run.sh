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
$Q -c "insert into public.app_settings (id, value) values ('script_sheet', '{\"base_url\":{}}') on conflict (id) do nothing"
$Q -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" 2>&1 | grep -i "ci:" || true
$Q -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" >/dev/null 2>&1
$Q -o /dev/null -f "$ROOT/tests/db/rls_test.sql"
$Q -Atc "select case when has_table_privilege('anon','public.v_signal_report','select') or has_table_privilege('authenticated','public.v_signal_report','select') then 'FAIL view still readable' else 'view closed: ok' end"
$Q -Atc "select case when (select value->>'url' from ci_integration_config where key='script_apps_script') like 'https://script.google.com/%' then 'moved config: ok' else 'FAIL config not moved' end"

# Fresh install from the repository's own SQL (as changed by this work) + migration:
# must end in the same protected state.
FRESH="${DB}_fresh"
BASELINE_DIR=supabase "$ROOT/tests/db/load_baseline.sh" "$FRESH" >/dev/null 2>&1
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -f "$ROOT/supabase/migrations/20261028_ci_access_control.sql" >/dev/null 2>&1
psql -X -q -v ON_ERROR_STOP=1 -d "$FRESH" -o /dev/null -f "$ROOT/tests/db/rls_test.sql" && echo "fresh install: RLS TESTS PASSED"
