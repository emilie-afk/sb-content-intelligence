#!/usr/bin/env bash
# Builds a database that resembles production BEFORE this change: Supabase stand-in +
# the committed SQL files in their documented order (+ production-only tables).
# Usage: tests/db/load_baseline.sh <dbname>   (PGHOST/PGPORT/PGUSER from env)
#   default: the SQL as of BASELINE_REF (pre-change commit); BASELINE_DIR=supabase uses the working tree
set -euo pipefail
DB="$1"; ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; Q="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
dropdb --if-exists "$DB"; createdb "$DB"
$Q -f "$ROOT/tests/db/00_supabase_standin.sql"
if [ -n "${BASELINE_DIR:-}" ]; then
  cd "$ROOT/$BASELINE_DIR"
else
  # The pre-change SQL, taken from git history (never copied into the tree).
  REF="${BASELINE_REF:-ddb3428}"
  TMP="$ROOT/.tmp/baseline-sql"; rm -rf "$TMP"; mkdir -p "$TMP"
  for f in $(git -C "$ROOT" ls-tree --name-only "$REF" supabase/); do
    git -C "$ROOT" show "$REF:$f" > "$TMP/$(basename "$f")"
  done
  cd "$TMP"
fi
for f in schema.sql schema_v2_migration.sql schema_v3_migration.sql schema_v4_migration.sql \
         schema_v5_migration.sql schema_v6_migration.sql schema_v7_migration.sql \
         schema_v8_migration.sql schema_v9_migration.sql schema_v10_migration.sql \
         schema_v11_migration.sql schema_v12_migration.sql schema_v13_migration.sql \
         schema_v14_migration.sql DRIFT schema_v15_migration.sql schema_v16_migration.sql \
         schema_agent_migration.sql ; do
  if [ "$f" = DRIFT ]; then $Q -f "$ROOT/tests/db/02_prod_drift.sql"; else $Q -f "$f"; fi
done
$Q -f "$ROOT/tests/db/01_prod_only_tables.sql"
for f in schema_security_migration.sql schema_v17_fix_token_rls.sql schema_v18_help_docs.sql \
         schema_v19_hashtags_text.sql schema_v20_rls_authenticated.sql schema_v20_rls_delete.sql \
         schema_v21_add_dismissed_status.sql schema_v22_cleanup_brief_created_clusters.sql \
         schema_v23_published_video_metrics.sql schema_v24_script_performance.sql \
         schema_v25_learning_processed.sql add_app_settings.sql add_thumbnail_title.sql ; do
  [ -f "$f" ] && $Q -f "$f"
done
echo "baseline loaded into $DB"
