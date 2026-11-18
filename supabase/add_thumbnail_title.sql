-- Run this in the Supabase SQL Editor to add thumbnail_title to script_outputs.

ALTER TABLE script_outputs
  ADD COLUMN IF NOT EXISTS thumbnail_title text;
