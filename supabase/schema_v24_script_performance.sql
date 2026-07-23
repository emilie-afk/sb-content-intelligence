-- Schema v24: Feed video performance back to script_outputs
-- Run in Supabase → SQL Editor → New Query → Run

-- ── 1. Add performance feedback columns to script_outputs ─────────────────────
ALTER TABLE script_outputs
  ADD COLUMN IF NOT EXISTS performance_tier  TEXT,    -- mirrors published_videos.performance_tier
  ADD COLUMN IF NOT EXISTS performance_note  TEXT,    -- auto-built summary (views, likes, etc.)
  ADD COLUMN IF NOT EXISTS measured_at       TIMESTAMPTZ; -- when metrics were synced back

-- ── 2. Expand review_status CHECK to include 'Measured' ──────────────────────
-- Drop existing constraint (name may vary; both names tried for safety)
ALTER TABLE script_outputs
  DROP CONSTRAINT IF EXISTS script_outputs_review_status_check;

-- Re-add with 'Measured' included
ALTER TABLE script_outputs
  ADD CONSTRAINT script_outputs_review_status_check
  CHECK (review_status IN (
    'Draft', 'Needs review', 'Needs revision',
    'Approved', 'Used in production', 'Measured', 'Archived'
  ));
