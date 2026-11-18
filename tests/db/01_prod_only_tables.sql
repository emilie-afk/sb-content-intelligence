-- TEST ONLY: tables that exist in production but have no CREATE statement in the
-- repository. Columns are the subset the app reads/writes; the real tables have more.
create table if not exists cluster_audit_log (
  id uuid primary key default gen_random_uuid(), cluster_id uuid, field_changed text,
  previous_value text, new_value text, reason text, trigger text, ai_model text,
  prompt_version text, is_automatic boolean, created_at timestamptz default now());
create table if not exists today_board_items (
  id uuid primary key default gen_random_uuid(), cluster_id uuid, title text, status text,
  item_type text, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists cluster_review_suggestions (
  id uuid primary key default gen_random_uuid(), cluster_id uuid, suggestion_type text, reason text,
  confidence text, evidence_preview text, review_status text, created_at timestamptz default now());
create table if not exists discovery_briefings (
  id uuid primary key default gen_random_uuid(), briefing_type text, summary text,
  created_at timestamptz default now());
