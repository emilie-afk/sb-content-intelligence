-- ============================================================
-- schema_v14_migration.sql
-- Manual signal tracking + opportunity score fields
--
-- Adds is_manual_submission to signals so the dashboard can
-- distinguish intentional manual observations from scraper volume.
-- Adds manual_signal_count to discovery_clusters for weighted scoring.
-- Run in Supabase → SQL Editor → New query.
-- ============================================================

-- ── 1. SIGNALS TABLE — is_manual_submission ───────────────────────────────────
-- true  = submitted by a human through the dashboard or assistant
-- false = submitted by the scraper (default)
-- All existing rows default to false (unknown origin; conservative assumption).

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS is_manual_submission BOOLEAN NOT NULL DEFAULT false;

-- ── 2. DISCOVERY_CLUSTERS — manual_signal_count ───────────────────────────────
-- Count of signals where is_manual_submission = true.
-- Used in opportunity score: manual signals weight 3×, scraped signals weight 1×.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS manual_signal_count INT NOT NULL DEFAULT 0;

-- ── 3. INDEXES ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS signals_is_manual_idx
  ON signals (is_manual_submission);

CREATE INDEX IF NOT EXISTS dc_manual_signal_count_idx
  ON discovery_clusters (manual_signal_count);

-- ── DONE ─────────────────────────────────────────────────────────────────────
-- Next steps:
--   1. Deploy updated submit-signal.js  (pass is_manual_submission from payload)
--   2. Deploy updated ai-analyze.js     (increment manual_signal_count on clusters)
--   3. Deploy updated ai-briefing.js    (use weighted opportunity score)
--   4. Deploy updated maintenance-run.js (1 manual + 1 question qualifies)
--   5. Deploy updated index.html        (saveSignal() sets is_manual_submission: true)
