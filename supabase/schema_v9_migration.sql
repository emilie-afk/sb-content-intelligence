-- Schema v9: Add 'Blocked irrelevant' to discovery_clusters status
-- Run in Supabase → SQL Editor → New query

ALTER TABLE discovery_clusters DROP CONSTRAINT IF EXISTS discovery_clusters_status_check;

ALTER TABLE discovery_clusters ADD CONSTRAINT discovery_clusters_status_check
  CHECK (status IN (
    'Collecting',
    'Pattern detected',
    'Content review ready',
    'Under review',
    'Keep watching',
    'Closed',
    'Blocked irrelevant'
  ));

-- Add block_reason column to store why a cluster was blocked
ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS block_reason TEXT;
