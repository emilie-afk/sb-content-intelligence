-- Migration: allow the 'Clustering' interim status on signals
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
--
-- Why: batch-cluster marks signals 'Clustering' while their analysis runs in
-- the background, so they leave the New queue and don't get re-dispatched.
-- The old CHECK constraint rejected that value silently, causing the daily
-- run to dispatch the same signals repeatedly.
--
-- The list below = every status the app actually writes.

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
    'Promote to Daily Board'
  ));
