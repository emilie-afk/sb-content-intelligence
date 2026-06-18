-- Schema v6: Add top_products to plant_watchlist
-- Run in Supabase → SQL Editor → New query

ALTER TABLE plant_watchlist
  ADD COLUMN IF NOT EXISTS top_products TEXT;

-- top_products stores product titles with >$100 revenue, separated by " || "
-- e.g. "String Of Pearls Senecio Rowleyanus || String of Dolphins || ..."
