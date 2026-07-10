-- Fix: change script_outputs.hashtags from text[] to plain text
-- Run in Supabase SQL Editor

ALTER TABLE script_outputs
  ALTER COLUMN hashtags TYPE text
  USING array_to_string(hashtags, ' ');
