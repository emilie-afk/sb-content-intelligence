-- Schema v15: Extend maintenance_status CHECK constraint to include 'Closed'
-- The original constraint was missing 'Closed', causing errors in ai-cleanup-batch
-- and any manual cleanup SQL that sets maintenance_status = 'Closed'.
--
-- Run in Supabase → SQL Editor → New query.

-- ── 1. DROP AND RECREATE THE CONSTRAINT ──────────────────────────────────────
ALTER TABLE discovery_clusters
  DROP CONSTRAINT IF EXISTS discovery_clusters_maintenance_status_check;

ALTER TABLE discovery_clusters
  ADD CONSTRAINT discovery_clusters_maintenance_status_check
  CHECK (maintenance_status IN (
    'Collecting',
    'Pattern detected',
    'Content review ready',
    'Under review',
    'Keep watching',
    'Mention only',
    'Blocked irrelevant',
    'Closed'
  ));

-- ── 2. VERIFY ─────────────────────────────────────────────────────────────────
-- Should return the constraint with all 8 values.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'discovery_clusters'::regclass
  AND conname = 'discovery_clusters_maintenance_status_check';
