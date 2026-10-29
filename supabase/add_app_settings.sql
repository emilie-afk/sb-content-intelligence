-- LEGACY (superseded 2026-10-28). The script sheet link and monthly tab ids now live in
-- the private, server-only table ci_integration_config (key 'script_sheet'); see
-- docs/SECURITY-ROLLOUT.md. This file only creates the old table so a fresh install
-- matches production. Never put real sheet URLs or tab ids in this repository.

CREATE TABLE IF NOT EXISTS app_settings (
  id         text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
-- No policies: server-only (see migrations/20261028_ci_access_control.sql).
