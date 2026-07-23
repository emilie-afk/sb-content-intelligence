-- Schema v25: Expand learning_status to include 'Ready' and 'Processed'
-- Run in Supabase → SQL Editor → New Query → Run
--
-- 'Ready'     = metrics synced, waiting for AI to generate a draft memory
-- 'Processed' = generate-learning.js has created a draft learning_memory row

ALTER TABLE published_videos
  DROP CONSTRAINT IF EXISTS published_videos_learning_status_check;

ALTER TABLE published_videos
  ADD CONSTRAINT published_videos_learning_status_check
  CHECK (learning_status IN (
    'Pending', 'Draft', 'Needs review', 'Approved', 'Archived',
    'Ready', 'Processed'
  ));
