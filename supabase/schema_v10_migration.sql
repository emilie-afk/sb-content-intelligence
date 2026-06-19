-- Schema v10: Add 'Mention only' to signals status constraint
-- Run in Supabase → SQL Editor → New query

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_status_check;

ALTER TABLE signals ADD CONSTRAINT signals_status_check
  CHECK (status IN (
    'New', 'Needs cleanup', 'Needs scoring',
    'Duplicate', 'Watch', 'Reject', 'Promote to Daily Board',
    'Clustered', 'Noise', 'Mention only'
  ));
