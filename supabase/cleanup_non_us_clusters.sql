-- One-time cleanup: close clusters that are clearly non-US or Mention Tracking material
-- Run in Supabase → SQL Editor → New query
-- Review the SELECT first before running the UPDATE.

-- ── PREVIEW: which clusters would be closed ───────────────────────────────────
SELECT id, title, summary, signal_count, status
FROM discovery_clusters
WHERE status NOT IN ('Closed', 'Blocked irrelevant')
  AND (
    -- Non-US shipping references
    summary ILIKE '%shipping to chile%'
    OR summary ILIKE '%envíos%'
    OR summary ILIKE '%ships to%chile%'
    OR title  ILIKE '%chile%'
    -- Pure appreciation / lifestyle posts
    OR (summary ILIKE '%cute%' AND summary ILIKE '%appreciat%')
    OR (summary ILIKE '%adorable%' AND signal_count <= 1)
  )
ORDER BY signal_count ASC;

-- ── APPLY: close non-US / mention-only clusters ──────────────────────────────
-- Uncomment and run AFTER reviewing the SELECT above.

/*
UPDATE discovery_clusters
SET
  status             = 'Closed',
  maintenance_status = 'Closed',
  ai_update_summary  = 'Manual cleanup: non-US source or mention-only content',
  last_ai_updated_at = NOW()
WHERE status NOT IN ('Closed', 'Blocked irrelevant')
  AND (
    summary ILIKE '%shipping to chile%'
    OR summary ILIKE '%envíos%'
    OR summary ILIKE '%ships to%chile%'
    OR title  ILIKE '%chile%'
    OR (summary ILIKE '%cute%' AND summary ILIKE '%appreciat%')
    OR (summary ILIKE '%adorable%' AND signal_count <= 1)
  );
*/

-- ── SUNBURN MERGE: consolidate single-signal sunburn clusters ─────────────────
-- Find all active sunburn clusters with only 1 signal
SELECT id, title, signal_count, first_seen_at
FROM discovery_clusters
WHERE status NOT IN ('Closed', 'Blocked irrelevant')
  AND (title ILIKE '%sunburn%' OR summary ILIKE '%sunburn%' OR summary ILIKE '%sun burn%')
ORDER BY signal_count DESC, first_seen_at ASC;

-- After identifying the strongest cluster to keep (highest signal_count),
-- close the weaker single-signal ones. Replace <KEEP_ID> with the UUID to keep.

/*
UPDATE discovery_clusters
SET
  status             = 'Closed',
  maintenance_status = 'Closed',
  ai_update_summary  = 'Merged into primary sunburn cluster via manual cleanup',
  last_ai_updated_at = NOW()
WHERE status NOT IN ('Closed', 'Blocked irrelevant')
  AND id != '<KEEP_ID>'
  AND (title ILIKE '%sunburn%' OR summary ILIKE '%sunburn%')
  AND signal_count <= 1;
*/
