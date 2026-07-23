-- Schema v23: Add numeric metric columns + performance tier to published_videos
-- Run in Supabase → SQL Editor → New query → Run

ALTER TABLE published_videos
  ADD COLUMN IF NOT EXISTS views_count      INTEGER,
  ADD COLUMN IF NOT EXISTS likes_count      INTEGER,
  ADD COLUMN IF NOT EXISTS comments_count   INTEGER,
  ADD COLUMN IF NOT EXISTS saves_count      INTEGER,
  ADD COLUMN IF NOT EXISTS shares_count     INTEGER,
  ADD COLUMN IF NOT EXISTS follows_count    INTEGER,
  ADD COLUMN IF NOT EXISTS performance_tier TEXT;
