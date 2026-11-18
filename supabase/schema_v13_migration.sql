-- ============================================================
-- schema_v13_migration.sql
-- Repetition source type + audience signal separation
--
-- Separates "current audience demand" from "we covered this before".
-- Old scripts no longer inflate signal counts or create recurring labels.
-- Run in Supabase → SQL Editor → New query.
-- ============================================================

-- ── 1. REPETITION SOURCE TYPE ─────────────────────────────────────────────────
-- Tracks WHY a cluster looks recurring.
-- Only current_audience, owned_comments, market_repetition, competitor_repetition
-- should increase Discovery priority.
-- owned_archive_only should only affect content fatigue / Covered Before flag.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS repetition_source_type TEXT
    CHECK (repetition_source_type IN (
      'current_audience',
      'owned_comments',
      'owned_archive_only',
      'competitor_repetition',
      'market_repetition',
      'none'
    ));

-- ── 2. AUDIENCE VS ARCHIVE SIGNAL COUNTS ─────────────────────────────────────
-- signal_count counts everything (unchanged — used for display/legacy).
-- audience_signal_count counts only signals from current external audience.
-- owned_comment_signal_count counts comments on owned SB posts.
-- owned_archive_match_count counts how many old SB scripts/videos matched.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS audience_signal_count     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owned_comment_signal_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owned_archive_match_count  INT NOT NULL DEFAULT 0;

-- ── 3. BOOLEAN FLAGS ──────────────────────────────────────────────────────────
-- audience_recurring: true only when real audience signals meet the threshold
--   (≥3 audience signals from ≥2 independent sources, OR ≥2 + strong owned-comment demand)
-- covered_before: true when this topic matches a prior SB script/post
--   covered_before affects repetition risk / content fatigue — NOT Discovery priority.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS audience_recurring_boolean BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS covered_before_boolean     BOOLEAN NOT NULL DEFAULT false;

-- ── 4. TODAY ELIGIBILITY REASON ───────────────────────────────────────────────
-- Why (or why not) this cluster should appear on the Today board.
-- Set by maintenance-run and ai-briefing; cleared when status changes.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS today_eligibility_reason TEXT;

-- ── 5. NOVELTY STATUS — EXPAND CHECK CONSTRAINT ───────────────────────────────
-- Add 'Audience recurring' and 'Covered before' as distinct values alongside
-- the existing 'Known recurring topic' (kept for backwards compatibility).

ALTER TABLE discovery_clusters
  DROP CONSTRAINT IF EXISTS discovery_clusters_novelty_status_check;

ALTER TABLE discovery_clusters
  ADD CONSTRAINT discovery_clusters_novelty_status_check
    CHECK (novelty_status IN (
      'Known recurring topic',        -- legacy, replaced by the two below
      'Audience recurring',           -- new: current audience signals confirm repetition
      'Covered before',               -- new: owned archive match only, not current demand
      'New audience wording',
      'New question about a known topic',
      'New tip or claim',
      'New contradiction',
      'New plant connected to a known problem',
      'Unclear'
    ));

-- ── 6. STATUS — ADD 'Mention only' ───────────────────────────────────────────
-- Allow clusters that have been reclassified as showcase/mention-only to be
-- moved without fully blocking them.

ALTER TABLE discovery_clusters
  DROP CONSTRAINT IF EXISTS discovery_clusters_status_check;

ALTER TABLE discovery_clusters
  ADD CONSTRAINT discovery_clusters_status_check
    CHECK (status IN (
      'Collecting',
      'Pattern detected',
      'Content review ready',
      'Under review',
      'Keep watching',
      'Mention only',          -- new: reclassified as showcase, not audience demand
      'Closed',
      'Blocked irrelevant'     -- from v9 migration
    ));

-- ── 7. BACKFILL — EXISTING CLUSTERS ──────────────────────────────────────────
-- Set safe defaults on all existing rows.
-- audience_signal_count starts at signal_count (conservative — assume all were audience).
-- repetition_source_type defaults to 'current_audience' until cleanup batch runs.
-- Run the AI Cleanup Batch (schema_v13_cleanup_batch) to refine these values.

UPDATE discovery_clusters
SET
  audience_signal_count      = COALESCE(signal_count, 0),
  repetition_source_type     = 'current_audience',
  audience_recurring_boolean = CASE WHEN COALESCE(signal_count, 0) >= 3 THEN true ELSE false END,
  covered_before_boolean     = false
WHERE audience_signal_count = 0
  AND repetition_source_type IS NULL;

-- ── 8. INDEXES ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS dc_repetition_source_idx
  ON discovery_clusters (repetition_source_type);

CREATE INDEX IF NOT EXISTS dc_audience_recurring_idx
  ON discovery_clusters (audience_recurring_boolean);

CREATE INDEX IF NOT EXISTS dc_covered_before_idx
  ON discovery_clusters (covered_before_boolean);

-- ── 9. AUTO-UPDATE updated_at ─────────────────────────────────────────────────
-- discovery_clusters already has an updated_at trigger from v7; no change needed.

-- ── DONE ─────────────────────────────────────────────────────────────────────
-- Next steps:
--   1. Deploy updated maintenance-run.js (sets repetition_source_type on new signals)
--   2. Deploy updated ai-briefing.js   (uses audience_recurring_boolean for Today board)
--   3. Run AI Cleanup Batch to reclassify all existing clusters
