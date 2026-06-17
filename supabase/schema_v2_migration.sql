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


-- ── 2. ADD script_output_id TO PUBLISHED VIDEOS ──────────────
-- Links a published video to the exact script that was used
ALTER TABLE published_videos
  ADD COLUMN IF NOT EXISTS script_output_id UUID;

-- (FK added separately so it doesn't fail if column already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'published_videos_script_output_id_fkey'
  ) THEN
    ALTER TABLE published_videos
      ADD CONSTRAINT published_videos_script_output_id_fkey
      FOREIGN KEY (script_output_id) REFERENCES script_outputs(id);
  END IF;
END $$;


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
CREATE POLICY "auth_read_scripts" ON script_outputs
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_insert_scripts" ON script_outputs
  FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'owner', 'assistant'));

CREATE POLICY "reviewer_update_scripts" ON script_outputs
  FOR UPDATE USING (get_user_role() IN ('admin', 'owner'));

-- Brand rules: all authenticated users can read; admin/owner can write
CREATE POLICY "auth_read_brand_rules" ON brand_content_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_manage_brand_rules" ON brand_content_rules
  FOR ALL USING (get_user_role() IN ('admin', 'owner'));


-- ── 6. BRAND CONTENT RULES (from succulents-box-brand-content-rules.md) ──────
-- Full rule set. Re-run safely — ON CONFLICT DO NOTHING prevents duplicates.
INSERT INTO brand_content_rules (category, rule_name, rule_text, severity) VALUES

  -- BRAND VOICE ─────────────────────────────────────────────────────────────
  ('Brand voice', 'Sound helpful and calm',
   'Sound helpful, clear, calm, plant-smart, reassuring, and beginner-friendly. Not judgmental, alarmist, or overly salesy.',
   'Required'),

  ('Brand voice', 'Lead with audience problem',
   'Start with what the viewer is worried about, confused by, or trying to fix. Not with a product pitch or general intro.',
   'Required'),

  ('Brand voice', 'Use plain language',
   'Write the way a knowledgeable friend talks. Avoid corporate filler, generic marketing verbs, and overly polished phrasing.',
   'Required'),

  -- WRITING STYLE ────────────────────────────────────────────────────────────
  ('Writing style', 'No em dashes',
   'Avoid em dashes in scripts, captions, cover text, briefs, and dashboard copy. Use periods, commas, colons, or parentheses instead.',
   'Required'),

  ('Writing style', 'No AI-sounding filler phrases',
   'Avoid: dive into, explore, enhance, elevate, unlock, discover, delve into, transform your, game-changing, seamless, leverage, curated just for you, taking it to the next level, in today''s fast-paced world, whether you''re a beginner or a pro.',
   'Forbidden'),

  ('Writing style', 'Preferred plain openers',
   'Use plain openers: "Let''s look at...", "Here''s why...", "Try this...", "Check this first...", "This helps because...", "The main sign is...", "Save this before you water."',
   'Recommended'),

  -- CONTENT PRINCIPLES ──────────────────────────────────────────────────────
  ('Content', 'Show plant in first 2 seconds',
   'For short-form video, show the plant, symptom, comparison, or result in the first 2 seconds. Preferred: close-up, before/after, side-by-side, hand demonstration, macro detail.',
   'Required'),

  ('Content', 'One main takeaway per short video',
   'TikTok, Reels, Shorts, and Facebook Reels should teach one clear thing. Avoid covering light, water, soil, fertilizer, repotting, pests, and propagation in a single short video.',
   'Required'),

  ('Content', 'Prefer visual proof over claims',
   'Prove the point visually when possible: show dry vs mushy leaves, sun stress vs sunburn, top of pot receiving light, roots before discussing root rot.',
   'Required'),

  ('Content', 'Use audience language',
   'Use the words viewers actually use: "Is it dying?", "Can I save it?", "Why is it wrinkly?", "Why is it stretching?", "Why is it bald on top?" Paraphrase private/community comments.',
   'Recommended'),

  -- CARE CLAIMS ─────────────────────────────────────────────────────────────
  ('Care claims', 'Be species-specific',
   'Care advice should match the actual plant when possible. Check: plant name, species/cultivar, indoor vs outdoor context, season/weather context, pot/drainage context, product page guidance.',
   'Required'),

  ('Care claims', 'No absolute care claims',
   'Do not say: "Never water this plant", "This plant cannot die", "This will save any succulent", "Always put it in direct sun", "Water every 7 days". Use: "In many indoor conditions...", "A common sign is...", "Check the soil before watering."',
   'Forbidden'),

  ('Care claims', 'No guaranteed recovery claims',
   'Avoid: "Do this and your plant will recover", "This fixes root rot every time", "Your plant will grow back in a week." Use: "This gives it a better chance", "If the stem is still firm, try this first", "Recovery depends on how much healthy tissue is left."',
   'Forbidden'),

  ('Care claims', 'Diagnosis based on visual signs',
   'Frame plant diagnosis around visible signs, not certainty. Good: "Wrinkling can mean thirst, but mushy yellow leaves point more toward overwatering." Avoid: "Your plant definitely has root rot."',
   'Required'),

  ('Care claims', 'Align with product pages',
   'If content features a Succulents Box product, care advice must not conflict with the product page or internal care guidance. If uncertain, mark as Needs care review.',
   'Required'),

  -- PRODUCT MENTIONS ────────────────────────────────────────────────────────
  ('Product', 'Product fit before product pitch',
   'Mention products only when the product naturally fits the viewer''s problem. Good: "If you love this look, String of Pearls is one of the trailing succulents we carry." Weak: "Buy our succulents now" after a video about root rot.',
   'Required'),

  ('Product', 'Confirm stock before direct promotion',
   'Before direct product CTAs, confirm: product name, product URL, in-stock status, relevant size/variant, enough inventory for promotion. If not confirmed, use a soft educational CTA instead.',
   'Required'),

  ('Product', 'Some videos should be educational only',
   'High-value educational videos (root rot diagnosis, sunburn recovery, pest treatment, Lithops splitting care) do not need a product CTA. Product mentions can come later via follow-up, caption link, or comment reply.',
   'Recommended'),

  ('Product', 'Product mention placement',
   'Preferred: after delivering useful advice, in caption, at the end as a soft CTA, as a natural plant identification. Avoid: product pitch in the first second unless clearly an unboxing, showcase, or catalog post.',
   'Recommended'),

  -- CTA ─────────────────────────────────────────────────────────────────────
  ('CTA', 'Match CTA to viewer intent',
   'Care education: "Save this before you water." Diagnosis: "Comment ''rot'' if you want the root check next." Product-led: "Find this plant in our shop while it is in stock." Engagement: "Would you water it? Guess before the reveal."',
   'Required'),

  ('CTA', 'Avoid pushy CTAs',
   'Avoid: "Buy now", "You need this", "Do not miss out", "Shop immediately." Unless a clearly promotional post with confirmed stock and approved campaign language.',
   'Avoid'),

  -- PLATFORM: TIKTOK ────────────────────────────────────────────────────────
  ('Platform', 'TikTok: fast visual hook',
   'TikTok preferred length: 15-35 seconds. Use fast visual hook, conversational tone, one problem or reveal, native-feeling pacing, comment-driven follow-ups. Good formats: POV, diagnosis, mistake correction, before/after, quiz, myth correction, plant rescue.',
   'Recommended'),

  -- PLATFORM: INSTAGRAM ─────────────────────────────────────────────────────
  ('Platform', 'Instagram Reels: strong cover text',
   'Instagram Reels preferred length: 15-45 seconds. Use strong cover text, clear visual polish, saveable care tips, plant close-ups, before/after comparisons. Good formats: care mini-guide, visual comparison, plant feature showcase, unboxing, myth correction.',
   'Recommended'),

  -- PLATFORM: YOUTUBE SHORTS ────────────────────────────────────────────────
  ('Platform', 'YouTube Shorts: searchable wording',
   'YouTube Shorts preferred length: 20-45 seconds. Use clear title-style hook, self-contained explanation, slightly more context than TikTok, searchable wording. Good formats: "How to tell...", "Why your...", "Do not water this when..."',
   'Recommended'),

  -- PLATFORM: FACEBOOK REELS ────────────────────────────────────────────────
  ('Platform', 'Facebook Reels: beginner-friendly',
   'Facebook Reels preferred length: 25-60 seconds. Use beginner-friendly explanations, readable on-screen text, practical care advice, less trend-dependent formats. Good formats: common mistake, plant care checklist, problem/solution, before/after.',
   'Recommended'),

  -- PRIVACY ─────────────────────────────────────────────────────────────────
  ('Privacy', 'No Facebook member details',
   'Facebook Group observations are qualitative signals only. Avoid: member names, profile links, screenshots, copied private comments, identifiable personal details. Good: "Several members asked whether Lithops should be watered while splitting."',
   'Forbidden'),

  ('Privacy', 'Paraphrase and anonymize comments',
   'Public comments can be summarized for insight. Private or community comments must be paraphrased and anonymized. Do not mock or shame users for mistakes.',
   'Required'),

  ('Privacy', 'Competitor signals only, no copying',
   'Competitor posts can be used as demand signals only. Do not copy: exact hook, script structure, caption, shot sequence, or creative concept. Use competitor signals to ask: what audience problem is this proving?',
   'Forbidden'),

  -- FORBIDDEN CLAIMS ────────────────────────────────────────────────────────
  ('Forbidden claims', 'Impossible to kill claims',
   'Never use: "Impossible to kill", "Guaranteed to survive", "This will save any plant", "Never water", "Always water", "Works every time", "The only care tip you need", "Instantly fixes root rot", "No sunlight needed", "No care required".',
   'Forbidden'),

  ('Forbidden claims', 'Exaggerated urgency',
   'Avoid: "You are killing your plant if you do not do this", "Stop everything and do this now", "Everyone is wrong about this." Use instead: "A common mistake is...", "This can help if...", "Check this before...", "One sign to look for is..."',
   'Forbidden')

ON CONFLICT DO NOTHING;
