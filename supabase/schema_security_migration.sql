-- ── Security hardening migration ───────────────────────────────────────────────
-- Run in Supabase → SQL Editor after pushing the updated Netlify functions.
-- Safe to run on an existing database (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- 1. Rate-limit columns on submission_tokens
ALTER TABLE submission_tokens
  ADD COLUMN IF NOT EXISTS rate_limit_per_hour  integer  DEFAULT 500,
  ADD COLUMN IF NOT EXISTS requests_this_hour   integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hour_window_start    timestamptz;

-- Tighten the default for performance tokens (set per-row if needed)
-- UPDATE submission_tokens SET rate_limit_per_hour = 100 WHERE allowed_action = 'submit_performance_snapshot';

-- 2. Audit log: add performed_by + source_function fields (if not already present)
ALTER TABLE cluster_audit_log
  ADD COLUMN IF NOT EXISTS performed_by    uuid    REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS source_function text;

-- 3. Index to speed up rate-limit window queries
CREATE INDEX IF NOT EXISTS idx_submission_tokens_hash
  ON submission_tokens (token_hash);

-- Done. Existing tokens keep rate_limit_per_hour = 500 by default.
-- Adjust per-token in the dashboard or via SQL as needed.
