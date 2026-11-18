-- Schema v8: Add Clustered and Noise to signals status constraint
-- Run in Supabase → SQL Editor → New query

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_status_check;

ALTER TABLE signals ADD CONSTRAINT signals_status_check
  CHECK (status IN (
    'New', 'Needs cleanup', 'Needs scoring',
    'Duplicate', 'Watch', 'Reject', 'Promote to Daily Board',
    'Clustered', 'Noise'
  ));
