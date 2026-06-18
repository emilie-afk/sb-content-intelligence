-- Schema v7: Discovery clustering + Content Review pipeline
-- Run in Supabase → SQL Editor → New query

-- ── DISCOVERY CLUSTERS ────────────────────────────────────────────────────────
-- One row per detected pattern across signals

CREATE TABLE IF NOT EXISTS discovery_clusters (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),

  -- Identity
  title                   TEXT NOT NULL,
  summary                 TEXT,
  plant_or_product        TEXT,

  -- Audience voice
  primary_question        TEXT,         -- "Why is String of Pearls bald on top?"
  problems_mentioned      TEXT[],       -- array of problem descriptions
  tips_mentioned          TEXT[],       -- array of tips/claims
  audience_wording        TEXT[],       -- exact phrases from audience
  evidence_types          TEXT[],       -- Question, Problem report, Tip, Claim, etc.

  -- Counts
  signal_count            INT DEFAULT 0,
  question_count          INT DEFAULT 0,
  distinct_source_count   INT DEFAULT 0,
  platforms               TEXT[],

  -- Timeline
  first_seen_at           TIMESTAMPTZ,
  last_seen_at            TIMESTAMPTZ,
  recent_mention_count    INT DEFAULT 0,   -- last 7 days
  previous_mention_count  INT DEFAULT 0,   -- prior 7 days
  growth_rate             NUMERIC,         -- % change

  -- Discovery flags
  novelty_status          TEXT CHECK (novelty_status IN (
    'Known recurring topic','New audience wording','New question about a known topic',
    'New tip or claim','New contradiction','New plant connected to a known problem','Unclear'
  )),
  verification_status     TEXT CHECK (verification_status IN (
    'Unverified','Needs research','Verified','Conflicts with brand guidance'
  )) DEFAULT 'Unverified',
  contradiction_status    TEXT CHECK (contradiction_status IN (
    'None','Detected','Reviewer confirmed'
  )) DEFAULT 'None',

  -- Content history
  related_published_urls  TEXT[],
  revenue_priority_match  TEXT CHECK (revenue_priority_match IN ('Yes','No','Needs check')),

  -- Status
  status                  TEXT CHECK (status IN (
    'Collecting','Pattern detected','Content review ready',
    'Under review','Keep watching','Closed'
  )) DEFAULT 'Collecting',

  -- Reviewer
  reviewer_status         TEXT CHECK (reviewer_status IN (
    'Unreviewed','Pinned','Dismissed','Moved to content review','Already answered'
  )) DEFAULT 'Unreviewed',
  reviewer_note           TEXT,
  reviewed_by             UUID REFERENCES auth.users(id),
  reviewed_at             TIMESTAMPTZ,

  -- AI metadata
  ai_confidence           TEXT CHECK (ai_confidence IN ('High','Medium','Low')),
  ai_reason               TEXT
);

-- ── SIGNAL → CLUSTER LINKS ────────────────────────────────────────────────────
-- Many signals can belong to one cluster

CREATE TABLE IF NOT EXISTS signal_cluster_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  signal_id       UUID REFERENCES signals(id) ON DELETE CASCADE,
  cluster_id      UUID REFERENCES discovery_clusters(id) ON DELETE CASCADE,
  match_reason    TEXT,    -- why this signal was attached to this cluster
  is_duplicate    BOOLEAN DEFAULT FALSE,
  UNIQUE(signal_id, cluster_id)
);

-- ── CONTENT REVIEW CANDIDATES ─────────────────────────────────────────────────
-- AI-prepared review cards — one active candidate per cluster

CREATE TABLE IF NOT EXISTS content_review_candidates (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),

  -- Source
  cluster_id                  UUID REFERENCES discovery_clusters(id) ON DELETE SET NULL,
  title                       TEXT NOT NULL,

  -- Audience evidence
  what_people_are_saying      TEXT,
  representative_wording      TEXT[],
  signal_count                INT DEFAULT 0,
  question_count              INT DEFAULT 0,
  distinct_source_count       INT DEFAULT 0,
  platforms                   TEXT[],
  first_seen_at               TIMESTAMPTZ,
  last_seen_at                TIMESTAMPTZ,
  pattern_growth              TEXT,
  evidence_urls               TEXT[],

  -- What's new
  what_appears_new            TEXT,
  claims_needing_verification TEXT,
  contradictory_advice        TEXT,

  -- Owned-channel check
  closest_published_title     TEXT,
  closest_published_urls      TEXT[],
  closest_published_date      DATE,
  days_since_similar          INT,
  previous_performance        TEXT,
  audience_followup_demand    TEXT,

  -- Repetition
  repetition_risk             TEXT CHECK (repetition_risk IN (
    'Low','Medium','High','Block','Needs reviewer check'
  )),
  freshness_reason            TEXT,
  same_topic                  BOOLEAN,
  same_plant                  BOOLEAN,
  same_question               BOOLEAN,
  same_advice                 BOOLEAN,
  same_hook_or_angle          BOOLEAN,

  -- Possible directions
  possible_directions         TEXT[],   -- Answer question / Verify claim / Compare advice / etc.

  -- AI output
  ai_confidence               TEXT CHECK (ai_confidence IN ('High','Medium','Low')),
  surfaced_reason             TEXT,     -- which qualification rule triggered this

  -- Status
  status                      TEXT CHECK (status IN (
    'Ready for review','Recommended follow-up','Needs research','Needs reviewer check',
    'Hold for repetition','Already covered','Approved for brief','Dismissed'
  )) DEFAULT 'Ready for review',

  -- Reviewer decision
  approved_direction          TEXT,
  reviewer_note               TEXT,
  reviewed_by                 UUID REFERENCES auth.users(id),
  reviewed_at                 TIMESTAMPTZ,

  -- Second check (before brief)
  second_check_done           BOOLEAN DEFAULT FALSE,
  second_check_conflict       TEXT,
  second_check_at             TIMESTAMPTZ
);

-- ── INDEXES ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clusters_status       ON discovery_clusters(status);
CREATE INDEX IF NOT EXISTS idx_clusters_novelty      ON discovery_clusters(novelty_status);
CREATE INDEX IF NOT EXISTS idx_clusters_last_seen    ON discovery_clusters(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_cluster_links_cluster ON signal_cluster_links(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_links_signal  ON signal_cluster_links(signal_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status     ON content_review_candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_cluster    ON content_review_candidates(cluster_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE discovery_clusters        ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_cluster_links      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_review_candidates ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user
CREATE POLICY "auth read clusters"     ON discovery_clusters        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth read links"        ON signal_cluster_links      FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth read candidates"   ON content_review_candidates FOR SELECT TO authenticated USING (true);

-- Write: admin or owner only
CREATE POLICY "admin write clusters"   ON discovery_clusters        FOR ALL TO authenticated
  USING (get_user_role() IN ('admin','owner'))
  WITH CHECK (get_user_role() IN ('admin','owner'));

CREATE POLICY "admin write links"      ON signal_cluster_links      FOR ALL TO authenticated
  USING (get_user_role() IN ('admin','owner'))
  WITH CHECK (get_user_role() IN ('admin','owner'));

CREATE POLICY "admin write candidates" ON content_review_candidates FOR ALL TO authenticated
  USING (get_user_role() IN ('admin','owner'))
  WITH CHECK (get_user_role() IN ('admin','owner'));

-- Service role bypass (for Netlify functions)
CREATE POLICY "service clusters"    ON discovery_clusters        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service links"       ON signal_cluster_links      FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service candidates"  ON content_review_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── UPDATED_AT TRIGGERS ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_clusters_updated_at   ON discovery_clusters;
DROP TRIGGER IF EXISTS trg_candidates_updated_at ON content_review_candidates;

CREATE TRIGGER trg_clusters_updated_at
  BEFORE UPDATE ON discovery_clusters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_candidates_updated_at
  BEFORE UPDATE ON content_review_candidates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
