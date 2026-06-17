-- ============================================================
-- SB Social Listening Dashboard — Schema v2 Migration
-- Run this AFTER the original schema.sql is already applied.
-- Supabase → SQL Editor → New Query → paste → Run
-- ============================================================

-- ── 1. ADD NEW COLUMNS TO SIGNALS ────────────────────────────
-- signal_type, approximate_frequency, manual_observation_notes
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS signal_type TEXT,
  ADD COLUMN IF NOT EXISTS approximate_frequency TEXT,
  ADD COLUMN IF NOT EXISTS manual_observation_notes TEXT;


-- ── 2. (script_output_id added after script_outputs table is created — see below)


-- ── 3. CREATE SCRIPT OUTPUTS TABLE ───────────────────────────
CREATE TABLE IF NOT EXISTS script_outputs (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_id                 UUID REFERENCES briefs(id),
  platform                 TEXT,
  script_title             TEXT NOT NULL,
  script_version           TEXT DEFAULT 'v1',
  script_type              TEXT CHECK (script_type IN (
                             'TikTok / Reel short script',
                             'YouTube Shorts script',
                             'Facebook Reel script',
                             'Longer educational script',
                             'Caption-only variant',
                             'UGC-style script'
                           )),
  opening_hook             TEXT,
  full_voiceover_script    TEXT,
  on_screen_text           TEXT,
  shot_list                TEXT,
  broll_notes              TEXT,
  product_mention          TEXT,
  cta                      TEXT,
  caption                  TEXT,
  cover_text               TEXT,
  hashtags                 TEXT[],
  estimated_duration_seconds INT,
  review_status            TEXT DEFAULT 'Draft'
                             CHECK (review_status IN (
                               'Draft', 'Needs review', 'Needs revision',
                               'Approved', 'Used in production', 'Archived'
                             )),
  reviewer_notes           TEXT,
  approved_by              UUID REFERENCES users_profile(id),
  approved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Now add the FK from published_videos (now that script_outputs exists)
ALTER TABLE published_videos
  ADD COLUMN IF NOT EXISTS script_output_id UUID REFERENCES script_outputs(id);

-- Auto-update timestamp
CREATE OR REPLACE TRIGGER script_outputs_updated_at
  BEFORE UPDATE ON script_outputs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── 4. CREATE BRAND CONTENT RULES TABLE ──────────────────────
CREATE TABLE IF NOT EXISTS brand_content_rules (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category                 TEXT NOT NULL,
  rule_name                TEXT NOT NULL,
  rule_text                TEXT NOT NULL,
  applies_to_platform      TEXT,   -- NULL = all platforms
  applies_to_content_pillar TEXT,  -- NULL = all pillars
  severity                 TEXT DEFAULT 'Recommended'
                             CHECK (severity IN ('Required', 'Recommended', 'Avoid', 'Forbidden')),
  active                   BOOLEAN DEFAULT true,
  created_by               UUID REFERENCES users_profile(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER brand_rules_updated_at
  BEFORE UPDATE ON brand_content_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── 5. ROW LEVEL SECURITY ─────────────────────────────────────

ALTER TABLE script_outputs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_content_rules ENABLE ROW LEVEL SECURITY;

-- Script outputs: all authenticated users can read; owner/admin can write
DROP POLICY IF EXISTS "auth_read_scripts"      ON script_outputs;
DROP POLICY IF EXISTS "auth_insert_scripts"    ON script_outputs;
DROP POLICY IF EXISTS "reviewer_update_scripts" ON script_outputs;

CREATE POLICY "auth_read_scripts" ON script_outputs
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_insert_scripts" ON script_outputs
  FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'owner', 'assistant'));

CREATE POLICY "reviewer_update_scripts" ON script_outputs
  FOR UPDATE USING (get_user_role() IN ('admin', 'owner'));

-- Brand rules: all authenticated users can read; admin/owner can write
DROP POLICY IF EXISTS "auth_read_brand_rules"    ON brand_content_rules;
DROP POLICY IF EXISTS "admin_manage_brand_rules" ON brand_content_rules;

CREATE POLICY "auth_read_brand_rules" ON brand_content_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_manage_brand_rules" ON brand_content_rules
  FOR ALL USING (get_user_role() IN ('admin', 'owner'));


-- ── 6. BRAND CONTENT RULES ───────────────────────────────────
-- Rules are stored in supabase/seed-brand-rules.sql (gitignored — private).
-- Run that file separately in Supabase SQL Editor after this migration.
