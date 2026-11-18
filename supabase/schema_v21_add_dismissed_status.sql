-- Schema v21: Add 'Dismissed' to signals_status_check constraint
-- The UI uses 'Dismissed' for the X button and bulk dismiss, but the constraint
-- was missing this value, causing check constraint errors on dismiss.
--
-- Run in Supabase → SQL Editor → New query → Run

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_status_check;

ALTER TABLE signals ADD CONSTRAINT signals_status_check
  CHECK (status IN (
    'New',
    'Clustering',            -- interim: dispatched to background analysis
    'Clustered',
    'Noise',
    'Mention only',
    'Needs cleanup',
    'Needs scoring',
    'Duplicate',
    'Watch',
    'Reject',
    'Dismissed',             -- soft-deleted via X button or bulk dismiss
    'Promote to Daily Board'
  ));
