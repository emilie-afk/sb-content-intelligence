-- Schema v22: Add 'Brief created' + 'Published' to discovery_clusters_status_check,
-- then clean up clusters that already have scripts generated but never got updated.
--
-- Run in Supabase → SQL Editor → New query → Run
-- Safe to run multiple times (idempotent).

-- Step 1: Expand the status constraint to include lifecycle statuses
-- that the dashboard code already writes.
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
      'Mention only',
      'Closed',
      'Blocked irrelevant',
      'Brief created',   -- cluster has a linked brief; hidden from Discovery/Today
      'Published'        -- video went live
    ));

-- Step 2: Mark clusters as 'Brief created' where a linked brief
-- exists at script-or-later stage but the cluster never got updated.
UPDATE discovery_clusters dc
SET status = 'Brief created', updated_at = NOW()
FROM briefs b
WHERE b.cluster_id = dc.id
  AND b.status IN ('Script in review', 'Filming', 'Approved', 'Published', 'Measured')
  AND dc.status NOT IN ('Brief created', 'Published', 'Closed', 'Blocked irrelevant');

-- Step 3: Resolve any today_board_items linked to those clusters
-- so they disappear from the Today board as well.
UPDATE today_board_items tbi
SET status = 'Resolved', updated_at = NOW()
FROM discovery_clusters dc
WHERE tbi.cluster_id = dc.id
  AND dc.status = 'Brief created'
  AND tbi.status NOT IN ('Resolved', 'Cleanup confirmed', 'Already covered');
