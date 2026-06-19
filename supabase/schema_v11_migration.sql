-- Schema v11: Competitor Activity and Market Watch tables
-- Run in Supabase → SQL Editor → New query

-- ── COMPETITOR ACTIVITY ───────────────────────────────────────────────────────
-- Tracks promotions, giveaways, launches, and other commercial activity
-- from competitor and third-party accounts.

CREATE TABLE IF NOT EXISTS competitor_activity (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  signal_id             UUID REFERENCES signals(id) ON DELETE SET NULL,
  source_url            TEXT,
  source_platform       TEXT,
  source_account_name   TEXT,
  source_account_handle TEXT,
  collaborator_accounts TEXT[],
  ownership_type        TEXT NOT NULL DEFAULT 'Unknown',  -- Competitor content | Third-party media | Unknown

  -- Dates
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at          TIMESTAMPTZ,
  published_at_estimated BOOLEAN DEFAULT FALSE,
  event_dates_claimed   TEXT[],
  event_date_labels     TEXT[],

  -- Classification
  activity_type         TEXT,  -- Giveaway or contest | Sale or promotion | Product launch | Availability announcement | Collaboration | Product showcase | Other
  signal_purpose        TEXT,
  ai_summary            TEXT,

  -- Plant / product
  plant_name            TEXT,
  catalog_match_status  TEXT DEFAULT 'Needs catalog review',  -- Catalog match | Catalog family match | Not in catalog | Needs catalog review | No plant identified
  matched_catalog_name  TEXT,
  match_confidence      TEXT,  -- High | Medium | Low

  -- Offer details
  offer_or_prize        TEXT,
  entry_mechanism       TEXT,
  source_marketing_wording TEXT[],

  -- Engagement
  like_count            INTEGER,
  comment_count         INTEGER,
  view_count            INTEGER,

  -- Status
  status                TEXT DEFAULT 'New',  -- New | Reviewed | Flagged | Dismissed
  reviewer_note         TEXT,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Status check
ALTER TABLE competitor_activity
  ADD CONSTRAINT competitor_activity_status_check
  CHECK (status IN ('New', 'Reviewed', 'Flagged', 'Dismissed'));

-- RLS
ALTER TABLE competitor_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read competitor_activity"
  ON competitor_activity FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can write competitor_activity"
  ON competitor_activity FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_competitor_activity_signal   ON competitor_activity(signal_id);
CREATE INDEX IF NOT EXISTS idx_competitor_activity_platform ON competitor_activity(source_platform);
CREATE INDEX IF NOT EXISTS idx_competitor_activity_status   ON competitor_activity(status);
CREATE INDEX IF NOT EXISTS idx_competitor_activity_observed ON competitor_activity(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_activity_catalog  ON competitor_activity(catalog_match_status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_competitor_activity_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_competitor_activity_updated_at
  BEFORE UPDATE ON competitor_activity
  FOR EACH ROW EXECUTE FUNCTION update_competitor_activity_updated_at();


-- ── MARKET WATCH PLANTS ────────────────────────────────────────────────────────
-- Tracks non-catalog plants receiving audience attention.
-- One row per plant; updated as new signals arrive.

CREATE TABLE IF NOT EXISTS market_watch_plants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Plant identity
  plant_name               TEXT NOT NULL UNIQUE,
  scientific_name          TEXT,
  known_aliases            TEXT[],

  -- Counts
  signal_count             INTEGER DEFAULT 0,
  question_count           INTEGER DEFAULT 0,
  purchase_intent_count    INTEGER DEFAULT 0,
  distinct_source_count    INTEGER DEFAULT 0,
  promotion_count          INTEGER DEFAULT 0,  -- times competitors featured it

  -- Platforms and sources
  platforms                TEXT[],
  competitors_featuring    TEXT[],  -- list of account handles

  -- Audience evidence
  audience_wording         TEXT[],
  recent_mention_count     INTEGER DEFAULT 0,
  previous_mention_count   INTEGER DEFAULT 0,

  -- Timeline
  first_seen_at            TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at             TIMESTAMPTZ DEFAULT NOW(),

  -- Catalog relationship
  closest_catalog_alternative TEXT,
  potential_catalog_opportunity TEXT,  -- High | Medium | Low | No
  catalog_rechecked_at     TIMESTAMPTZ,
  previous_catalog_status  TEXT,
  catalog_status_changed_at TIMESTAMPTZ,

  -- Verification and review
  verification_status      TEXT DEFAULT 'Unverified',  -- Unverified | Needs research | Verified
  reviewer_status          TEXT DEFAULT 'Unreviewed',  -- Unreviewed | Watching | Flag for merchandising | Dismissed
  reviewer_note            TEXT,

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE market_watch_plants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read market_watch_plants"
  ON market_watch_plants FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can write market_watch_plants"
  ON market_watch_plants FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_market_watch_signal_count ON market_watch_plants(signal_count DESC);
CREATE INDEX IF NOT EXISTS idx_market_watch_last_seen    ON market_watch_plants(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_watch_reviewer     ON market_watch_plants(reviewer_status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_market_watch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_market_watch_updated_at
  BEFORE UPDATE ON market_watch_plants
  FOR EACH ROW EXECUTE FUNCTION update_market_watch_updated_at();


-- ── MARKET WATCH SIGNAL LINKS ──────────────────────────────────────────────────
-- Links individual signals to market watch plants (many-to-many).

CREATE TABLE IF NOT EXISTS market_watch_signal_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID NOT NULL REFERENCES market_watch_plants(id) ON DELETE CASCADE,
  signal_id        UUID REFERENCES signals(id) ON DELETE SET NULL,
  source_url       TEXT,
  source_handle    TEXT,
  signal_purpose   TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plant_id, signal_id)
);

ALTER TABLE market_watch_signal_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read market_watch_signal_links"
  ON market_watch_signal_links FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can write market_watch_signal_links"
  ON market_watch_signal_links FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_mw_links_plant  ON market_watch_signal_links(plant_id);
CREATE INDEX IF NOT EXISTS idx_mw_links_signal ON market_watch_signal_links(signal_id);


-- ── SIGNALS: add source attribution columns ────────────────────────────────────
-- Extend signals table with attribution fields populated during extraction.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS source_account_handle   TEXT,
  ADD COLUMN IF NOT EXISTS source_account_name     TEXT,
  ADD COLUMN IF NOT EXISTS collaborator_accounts   TEXT[],
  ADD COLUMN IF NOT EXISTS ownership_type          TEXT DEFAULT 'Unknown',
  ADD COLUMN IF NOT EXISTS ownership_confidence    TEXT DEFAULT 'Low',
  ADD COLUMN IF NOT EXISTS published_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at_estimated  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS event_dates_claimed     TEXT[],
  ADD COLUMN IF NOT EXISTS event_date_labels       TEXT[],
  ADD COLUMN IF NOT EXISTS signal_purpose          TEXT,
  ADD COLUMN IF NOT EXISTS section_route           TEXT,  -- Catalog Discovery | Competitor Activity | Market Watch | Mention Tracking | Needs Catalog Review | Noise
  ADD COLUMN IF NOT EXISTS catalog_match_status    TEXT,
  ADD COLUMN IF NOT EXISTS matched_catalog_name    TEXT,
  ADD COLUMN IF NOT EXISTS source_marketing_wording TEXT[];
