-- Run in Supabase SQL Editor.
-- Creates app_settings table and seeds the script sheet config.

CREATE TABLE IF NOT EXISTS app_settings (
  id         text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Seed the script sheet config.
-- "base_url" per year — update this when a new year's sheet is created.
-- "gids" per year+month — add a new year block each January.
INSERT INTO app_settings (id, value) VALUES (
  'script_sheet',
  '{
    "base_url": {
      "2026": "https://docs.google.com/spreadsheets/d/1iDg61cxy6oSxb8vL2AkaivTnQJuTVJY5bKIbtNBLHAQ/edit"
    },
    "gids": {
      "2026": {
        "1":  543399107,
        "2":  1014332536,
        "3":  827394542,
        "4":  81707702,
        "5":  2020833859,
        "6":  917654142,
        "7":  1509550029,
        "8":  1130813057,
        "9":  847982453,
        "10": 1941512612,
        "11": 768311302,
        "12": 1383995983
      }
    }
  }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Allow authenticated users to read; only service_role can write directly.
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can read app_settings"
  ON app_settings FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_role can write app_settings"
  ON app_settings FOR ALL TO service_role USING (true);
