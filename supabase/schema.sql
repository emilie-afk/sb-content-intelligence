-- ============================================================
-- Succulents Box Social Listening Dashboard — Supabase Schema
-- Run this in: Supabase → SQL Editor → New Query → Run
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ── TABLE 1: USERS ────────────────────────────────────────────
CREATE TABLE users_profile (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'owner', 'assistant', 'viewer')),
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── HELPER FUNCTION ───────────────────────────────────────────
-- Must come AFTER users_profile table (SQL functions are validated at creation time)
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM users_profile WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- ── TABLE 2: SOURCES ──────────────────────────────────────────
CREATE TABLE sources (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform             TEXT NOT NULL,
  source_name          TEXT,
  source_url           TEXT,
  source_type          TEXT,   -- e.g. 'Hashtag', 'Creator', 'Facebook Group'
  owner_id             UUID REFERENCES users_profile(id),
  collection_frequency TEXT,   -- e.g. 'Daily', 'Weekly', 'Manual'
  signal_quality       TEXT DEFAULT 'Unknown'
                         CHECK (signal_quality IN ('High', 'Medium', 'Low', 'Unknown')),
  status               TEXT DEFAULT 'Active',
  notes                TEXT,
  ideas_generated      INT DEFAULT 0,
  approved_ideas       INT DEFAULT 0,
  published_videos     INT DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 3: SIGNALS (raw findings) ──────────────────────────
CREATE TABLE signals (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date_found            DATE NOT NULL DEFAULT CURRENT_DATE,
  platform              TEXT,
  source_url            TEXT,
  creator_name          TEXT,
  topic                 TEXT,
  plant_or_product      TEXT,
  caption_summary       TEXT,
  metrics_summary       TEXT,
  comment_theme_summary TEXT,
  audience_problem      TEXT,
  ai_cleanup_notes      TEXT,
  status                TEXT DEFAULT 'New'
                          CHECK (status IN (
                            'New', 'Clustering', 'Clustered', 'Noise', 'Mention only',
                            'Needs cleanup', 'Needs scoring',
                            'Duplicate', 'Watch', 'Reject', 'Promote to Daily Board'
                          )),
  reject_reason         TEXT,
  -- Fields from Instagram scraper
  score                 NUMERIC(5,1),
  priority              TEXT CHECK (priority IN ('High', 'Medium', 'Low')),
  search_tag            TEXT,
  shelf_life            TEXT CHECK (shelf_life IN ('Trend', 'Seasonal', 'Evergreen', 'Experimental')),
  likes                 BIGINT,
  comments_count        BIGINT,
  post_date             DATE,
  -- Relations
  source_id             UUID REFERENCES sources(id),
  created_by            UUID REFERENCES users_profile(id),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 4: OPPORTUNITIES ────────────────────────────────────
CREATE TABLE opportunities (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic                  TEXT NOT NULL,
  plant_or_product       TEXT,
  primary_signal_id      UUID REFERENCES signals(id),
  -- Scoring (each out of max that sums to 100)
  external_demand_score  NUMERIC(5,1) DEFAULT 0,   -- 30%
  comment_demand_score   NUMERIC(5,1) DEFAULT 0,   -- 25%
  cross_platform_score   NUMERIC(5,1) DEFAULT 0,   -- 20%
  production_ease_score  NUMERIC(5,1) DEFAULT 0,   -- 15%
  catalog_fit_score      NUMERIC(5,1) DEFAULT 0,   -- 10%
  total_ai_score         NUMERIC(5,1),             -- calculated on insert/update
  priority               TEXT CHECK (priority IN ('High', 'Medium', 'Low')),
  shelf_life             TEXT CHECK (shelf_life IN ('Trend', 'Seasonal', 'Evergreen', 'Experimental')),
  why_now                TEXT,
  evidence_summary       TEXT,
  suggested_hook         TEXT,
  suggested_format       TEXT,
  historical_memory_note TEXT,
  recommended_action     TEXT,
  recommended_deadline   DATE,
  reviewer_decision      TEXT CHECK (reviewer_decision IN (
                            'Approve brief', 'Needs more evidence',
                            'Watch', 'Reject', 'Move to evergreen'
                          )),
  reviewer_id            UUID REFERENCES users_profile(id),
  reviewed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-calculate total score before insert/update
CREATE OR REPLACE FUNCTION calc_opportunity_score()
RETURNS TRIGGER AS $$
BEGIN
  NEW.total_ai_score := LEAST(
    COALESCE(NEW.external_demand_score, 0) +
    COALESCE(NEW.comment_demand_score, 0) +
    COALESCE(NEW.cross_platform_score, 0) +
    COALESCE(NEW.production_ease_score, 0) +
    COALESCE(NEW.catalog_fit_score, 0),
    100
  );
  -- Auto-set priority based on score
  IF NEW.total_ai_score >= 65 THEN NEW.priority := 'High';
  ELSIF NEW.total_ai_score >= 40 THEN NEW.priority := 'Medium';
  ELSE NEW.priority := 'Low';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_score_trigger
  BEFORE INSERT OR UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION calc_opportunity_score();


-- ── TABLE 5: OPPORTUNITY SOURCES (join table) ────────────────
CREATE TABLE opportunity_sources (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id  UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  signal_id       UUID REFERENCES signals(id),
  source_url      TEXT,
  platform        TEXT,
  evidence_note   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 6: BRIEFS ───────────────────────────────────────────
CREATE TABLE briefs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id   UUID REFERENCES opportunities(id),
  title            TEXT NOT NULL,
  featured_product TEXT,
  product_url      TEXT,
  stock_confirmed  BOOLEAN DEFAULT false,
  audience_problem TEXT,
  opening_hook     TEXT,
  visual_hook      TEXT,
  video_format     TEXT,
  video_flow       TEXT,
  caption          TEXT,
  cover_text       TEXT,
  keywords         TEXT[],
  hashtags         TEXT[],
  cta              TEXT,
  follow_up_idea   TEXT,
  owner_id         UUID REFERENCES users_profile(id),
  deadline         DATE,
  status           TEXT DEFAULT 'Draft'
                     CHECK (status IN (
                       'Draft', 'Needs review', 'Approved',
                       'Filming', 'Editing', 'Scheduled', 'Published', 'Measured'
                     )),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 7: PUBLISHED VIDEOS ─────────────────────────────────
CREATE TABLE published_videos (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_id                   UUID REFERENCES briefs(id),
  platform                   TEXT,
  video_url                  TEXT,
  video_title                TEXT,
  topic                      TEXT,
  plant_or_product           TEXT,
  publish_datetime           TIMESTAMPTZ,
  original_opportunity_score NUMERIC(5,1),
  hypothesis                 TEXT,
  snapshot_24h_status        TEXT DEFAULT 'Pending'
                               CHECK (snapshot_24h_status IN ('Pending', 'Submitted', 'Overdue')),
  snapshot_72h_status        TEXT DEFAULT 'Pending'
                               CHECK (snapshot_72h_status IN ('Pending', 'Submitted', 'Overdue')),
  snapshot_7d_status         TEXT DEFAULT 'Pending'
                               CHECK (snapshot_7d_status IN ('Pending', 'Submitted', 'Overdue')),
  learning_status            TEXT DEFAULT 'Pending'
                               CHECK (learning_status IN ('Pending', 'Draft', 'Needs review', 'Approved', 'Archived')),
  final_recommendation       TEXT CHECK (final_recommendation IN ('Repeat', 'Revise', 'Stop')),
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 8: PERFORMANCE SNAPSHOTS ───────────────────────────
CREATE TABLE performance_snapshots (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  published_video_id      UUID REFERENCES published_videos(id) ON DELETE CASCADE,
  platform                TEXT,
  snapshot_type           TEXT CHECK (snapshot_type IN ('24h', '72h', '7d', 'Manual')),
  snapshot_timestamp      TIMESTAMPTZ DEFAULT NOW(),
  views                   BIGINT DEFAULT 0,
  likes                   BIGINT DEFAULT 0,
  comments                BIGINT DEFAULT 0,
  shares                  BIGINT DEFAULT 0,
  saves                   BIGINT DEFAULT 0,
  follows_gained          INT DEFAULT 0,
  profile_visits          INT DEFAULT 0,
  link_clicks             INT DEFAULT 0,
  average_watch_time      NUMERIC(6,2),
  completion_rate         NUMERIC(5,2),
  top_audience_questions  TEXT,
  notable_comment_themes  TEXT,
  submitted_by_label      TEXT,
  submission_token_id     UUID,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 9: LEARNING MEMORY ──────────────────────────────────
CREATE TABLE learning_memory (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date_added               DATE DEFAULT CURRENT_DATE,
  applies_to               TEXT CHECK (applies_to IN (
                             'Topic', 'Plant', 'Hook', 'Format',
                             'Source', 'Product', 'Audience question', 'Content pillar'
                           )),
  topic                    TEXT,
  plant                    TEXT,
  hook                     TEXT,
  format                   TEXT,
  source                   TEXT,
  product                  TEXT,
  what_happened            TEXT,
  evidence_summary         TEXT,
  recommendation_next_time TEXT,
  confidence               TEXT CHECK (confidence IN ('High', 'Medium', 'Low')),
  status                   TEXT DEFAULT 'Needs review next time'
                             CHECK (status IN (
                               'Active', 'Needs review next time', 'Approved rule', 'Archived'
                             )),
  reviewed_by              UUID REFERENCES users_profile(id),
  published_video_id       UUID REFERENCES published_videos(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);


-- ── TABLE 10: SUBMISSION TOKENS ───────────────────────────────
-- For scraper and Claude submit-only access
CREATE TABLE submission_tokens (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label          TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,  -- store bcrypt hash, not plain token
  allowed_action TEXT CHECK (allowed_action IN (
                   'submit_performance_snapshot', 'submit_signal'
                 )),
  active         BOOLEAN DEFAULT true,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ
);


-- ── TABLE 11: SETTINGS ────────────────────────────────────────
CREATE TABLE settings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         TEXT UNIQUE NOT NULL,
  value       JSONB,
  updated_by  UUID REFERENCES users_profile(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

ALTER TABLE users_profile        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources              ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_videos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_memory      ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings             ENABLE ROW LEVEL SECURITY;

-- ── users_profile policies ───────────────────────────────────
CREATE POLICY "user_read_own" ON users_profile
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "user_insert_own" ON users_profile
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY "admin_read_all_users" ON users_profile
  FOR SELECT USING (get_user_role() = 'admin');

CREATE POLICY "admin_update_users" ON users_profile
  FOR UPDATE USING (get_user_role() = 'admin');

-- ── signals policies ─────────────────────────────────────────
CREATE POLICY "auth_read_signals" ON signals
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "assistant_insert_signals" ON signals
  FOR INSERT WITH CHECK (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

CREATE POLICY "assistant_update_signals" ON signals
  FOR UPDATE USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- ── opportunities policies ───────────────────────────────────
CREATE POLICY "auth_read_opportunities" ON opportunities
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "assistant_insert_opportunities" ON opportunities
  FOR INSERT WITH CHECK (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

CREATE POLICY "reviewer_update_opportunities" ON opportunities
  FOR UPDATE USING (
    get_user_role() IN ('admin', 'owner')
  );

-- ── opportunity_sources policies ─────────────────────────────
CREATE POLICY "auth_read_opp_sources" ON opportunity_sources
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "assistant_manage_opp_sources" ON opportunity_sources
  FOR ALL USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- ── briefs policies ──────────────────────────────────────────
CREATE POLICY "auth_read_briefs" ON briefs
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "assistant_insert_briefs" ON briefs
  FOR INSERT WITH CHECK (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

CREATE POLICY "reviewer_update_briefs" ON briefs
  FOR UPDATE USING (
    get_user_role() IN ('admin', 'owner')
  );

-- ── published_videos policies ────────────────────────────────
CREATE POLICY "auth_read_published" ON published_videos
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_manage_published" ON published_videos
  FOR ALL USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- ── performance_snapshots policies ──────────────────────────
CREATE POLICY "auth_read_snapshots" ON performance_snapshots
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Snapshots are written by Netlify Functions (service role key)
-- No direct insert policy needed for authenticated users

-- ── learning_memory policies ─────────────────────────────────
CREATE POLICY "auth_read_memory" ON learning_memory
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_owner_manage_memory" ON learning_memory
  FOR ALL USING (
    get_user_role() IN ('admin', 'owner')
  );

-- ── sources policies ─────────────────────────────────────────
CREATE POLICY "auth_read_sources" ON sources
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_manage_sources" ON sources
  FOR ALL USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- ── submission_tokens policies ───────────────────────────────
-- Only admins can read/manage tokens (token validation done server-side)
CREATE POLICY "admin_manage_tokens" ON submission_tokens
  FOR ALL USING (get_user_role() = 'admin');

-- ── settings policies ────────────────────────────────────────
CREATE POLICY "auth_read_settings" ON settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_manage_settings" ON settings
  FOR ALL USING (get_user_role() = 'admin');


-- ============================================================
-- AUTO-UPDATE TIMESTAMPS
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signals_updated_at        BEFORE UPDATE ON signals        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER opportunities_updated_at  BEFORE UPDATE ON opportunities  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER briefs_updated_at         BEFORE UPDATE ON briefs         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER published_updated_at      BEFORE UPDATE ON published_videos FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER learning_updated_at       BEFORE UPDATE ON learning_memory FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER users_updated_at          BEFORE UPDATE ON users_profile  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- DEFAULT SETTINGS
-- ============================================================

INSERT INTO settings (key, value) VALUES
  ('scoring_weights', '{"external_demand": 30, "comment_demand": 25, "cross_platform": 20, "production_ease": 15, "catalog_fit": 10}'),
  ('priority_thresholds', '{"high": 65, "medium": 40}'),
  ('platforms', '["TikTok", "Instagram", "YouTube", "Facebook", "Pinterest"]'),
  ('content_pillars', '["Care problems", "Plant ID", "Before & after", "Propagation", "Seasonal", "Product feature", "Myth-busting"]'),
  ('shelf_life_options', '["Trend", "Seasonal", "Evergreen", "Experimental"]')
ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- AUTO-REGISTER USER ON FIRST SIGN-IN
-- ============================================================
-- When a user signs in via Google OAuth, this function auto-creates
-- their profile row so they can access the dashboard.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO users_profile (id, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'viewer'  -- default role; admin promotes as needed
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
