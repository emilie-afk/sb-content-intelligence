-- Schema v12: AI Cluster Maintenance, Discovery Briefings, Today Board
-- Based on:
--   ai-cluster-maintenance-update.md
--   daily-board-and-cluster-redesign-update.md
--   ai-discovery-briefing-and-triage-update.md
--
-- Run in Supabase → SQL Editor → New query


-- ── 1. DISCOVERY CLUSTERS: maintenance fields ─────────────────────────────────
-- New fields for AI-driven cluster maintenance, confidence tracking,
-- and the update indicator shown on each cluster card.

ALTER TABLE discovery_clusters
  ADD COLUMN IF NOT EXISTS maintenance_status      TEXT    DEFAULT 'Active',
  -- Active | Collecting | Pattern detected | Keep watching | Dormant
  -- | Closed as resolved | Blocked irrelevant

  ADD COLUMN IF NOT EXISTS last_ai_updated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reviewed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS new_signals_since_review INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_update_summary       TEXT,    -- short description of latest AI change
  ADD COLUMN IF NOT EXISTS ai_confidence           TEXT    DEFAULT 'Medium',
  -- High | Medium | Low

  ADD COLUMN IF NOT EXISTS review_required         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_required_reason  TEXT,

  ADD COLUMN IF NOT EXISTS catalog_version_checked TEXT,
  ADD COLUMN IF NOT EXISTS owned_content_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prompt_version          TEXT;

-- Constrain maintenance_status values (idempotent)
DO $$ BEGIN
  ALTER TABLE discovery_clusters
    ADD CONSTRAINT discovery_clusters_maintenance_status_check
    CHECK (maintenance_status IN (
      'Active', 'Collecting', 'Pattern detected', 'Keep watching',
      'Dormant', 'Closed as resolved', 'Blocked irrelevant'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Constrain ai_confidence values (idempotent)
DO $$ BEGIN
  ALTER TABLE discovery_clusters
    ADD CONSTRAINT discovery_clusters_ai_confidence_check
    CHECK (ai_confidence IN ('High', 'Medium', 'Low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Index for maintenance queries
CREATE INDEX IF NOT EXISTS idx_clusters_maintenance_status
  ON discovery_clusters(maintenance_status);

CREATE INDEX IF NOT EXISTS idx_clusters_review_required
  ON discovery_clusters(review_required)
  WHERE review_required = TRUE;

CREATE INDEX IF NOT EXISTS idx_clusters_last_ai_updated
  ON discovery_clusters(last_ai_updated_at DESC NULLS LAST);


-- ── 2. DISCOVERY BRIEFINGS ────────────────────────────────────────────────────
-- Stores AI-generated briefings (daily, weekly, on-demand).
-- Each briefing summarises new activity and prepares cleanup suggestions.

CREATE TABLE IF NOT EXISTS discovery_briefings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  briefing_type    TEXT NOT NULL DEFAULT 'on-demand',
  -- daily | weekly | on-demand

  period_start     TIMESTAMPTZ,
  period_end       TIMESTAMPTZ,

  -- Filters active when the briefing was generated (platform, status, etc.)
  filter_state     JSONB,

  -- Main summary text shown at top of Discovery Board
  summary          TEXT,

  -- Structured JSON arrays for each briefing section
  prominent_topics JSONB,
  -- [{ theme, clusters, signal_count, source_count, question_count,
  --    catalog_plants, platforms, change_from_prior, related_owned_content }]

  attention_items  JSONB,
  -- [{ reason, cluster_id, evidence_strength, ai_confidence, recommended_action }]

  cleanup_counts   JSONB,
  -- { reroute: N, merge: N, split: N, dismiss: N, needs_research: N }

  -- AI provenance
  ai_model         TEXT,
  prompt_version   TEXT,

  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by     TEXT        NOT NULL DEFAULT 'auto'
  -- 'auto' (scheduled) | user ID (on-demand)
);

DO $$ BEGIN
  ALTER TABLE discovery_briefings
    ADD CONSTRAINT discovery_briefings_type_check
    CHECK (briefing_type IN ('daily', 'weekly', 'on-demand'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS
ALTER TABLE discovery_briefings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read discovery_briefings"
  ON discovery_briefings FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can write discovery_briefings"
  ON discovery_briefings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_briefings_type       ON discovery_briefings(briefing_type);
CREATE INDEX IF NOT EXISTS idx_briefings_generated  ON discovery_briefings(generated_at DESC);


-- ── 3. CLUSTER REVIEW SUGGESTIONS ────────────────────────────────────────────
-- AI prepares suggestions for reviewer action.
-- AI must not act on these automatically — reviewer confirms each one.

CREATE TABLE IF NOT EXISTS cluster_review_suggestions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id                UUID NOT NULL REFERENCES discovery_clusters(id) ON DELETE CASCADE,
  briefing_id               UUID REFERENCES discovery_briefings(id) ON DELETE SET NULL,

  suggestion_type           TEXT NOT NULL,
  -- Dismiss | Reroute | Merge | Split | Keep watching | Needs research
  -- | Needs catalog review | Needs source review | Move to Content Review

  suggested_destination     TEXT,
  -- For Reroute: target section name
  -- For Move to Content Review: 'Content Review'

  suggested_match_cluster_id UUID REFERENCES discovery_clusters(id) ON DELETE SET NULL,
  -- For Merge: the cluster to merge into

  reason                    TEXT,
  confidence                TEXT    NOT NULL DEFAULT 'Medium',
  -- High | Medium | Low

  evidence_preview          TEXT,
  -- Short excerpt from signals supporting the suggestion

  -- Reviewer response
  review_status             TEXT    NOT NULL DEFAULT 'Pending',
  -- Pending | Confirmed | Rejected | Modified

  reviewer_id               UUID,
  reviewer_note             TEXT,
  reviewed_at               TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE cluster_review_suggestions
    ADD CONSTRAINT crs_suggestion_type_check
    CHECK (suggestion_type IN (
      'Dismiss', 'Reroute', 'Merge', 'Split', 'Keep watching',
      'Needs research', 'Needs catalog review', 'Needs source review',
      'Move to Content Review'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cluster_review_suggestions
    ADD CONSTRAINT crs_confidence_check
    CHECK (confidence IN ('High', 'Medium', 'Low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cluster_review_suggestions
    ADD CONSTRAINT crs_review_status_check
    CHECK (review_status IN ('Pending', 'Confirmed', 'Rejected', 'Modified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS
ALTER TABLE cluster_review_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read cluster_review_suggestions"
  ON cluster_review_suggestions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Auth users can update cluster_review_suggestions"
  ON cluster_review_suggestions FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Service role can write cluster_review_suggestions"
  ON cluster_review_suggestions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_crs_cluster    ON cluster_review_suggestions(cluster_id);
CREATE INDEX IF NOT EXISTS idx_crs_briefing   ON cluster_review_suggestions(briefing_id);
CREATE INDEX IF NOT EXISTS idx_crs_status     ON cluster_review_suggestions(review_status);
CREATE INDEX IF NOT EXISTS idx_crs_type       ON cluster_review_suggestions(suggestion_type);
CREATE INDEX IF NOT EXISTS idx_crs_pending    ON cluster_review_suggestions(review_status)
  WHERE review_status = 'Pending';


-- ── 4. CLUSTER AUDIT LOG ──────────────────────────────────────────────────────
-- Immutable record of every AI and reviewer change to a cluster.
-- Required: AI must preserve the previous value when changing an interpretive field.

CREATE TABLE IF NOT EXISTS cluster_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id       UUID NOT NULL REFERENCES discovery_clusters(id) ON DELETE CASCADE,

  -- What changed
  field_changed    TEXT NOT NULL,
  previous_value   TEXT,
  new_value        TEXT,
  reason           TEXT,

  -- What triggered the change
  trigger          TEXT NOT NULL DEFAULT 'unknown',
  -- new_signal | catalog_change | performance_update | reviewer_correction
  -- | daily_maintenance | weekly_maintenance | owned_content_published | manual

  -- AI provenance
  ai_model         TEXT,
  prompt_version   TEXT,

  -- Whether the change was automatic (AI) or confirmed by a reviewer
  is_automatic     BOOLEAN NOT NULL DEFAULT TRUE,
  reviewer_id      UUID,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE cluster_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read cluster_audit_log"
  ON cluster_audit_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can write cluster_audit_log"
  ON cluster_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_cluster   ON cluster_audit_log(cluster_id);
CREATE INDEX IF NOT EXISTS idx_audit_trigger   ON cluster_audit_log(trigger);
CREATE INDEX IF NOT EXISTS idx_audit_created   ON cluster_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_automatic ON cluster_audit_log(is_automatic);


-- ── 5. TODAY BOARD ITEMS ──────────────────────────────────────────────────────
-- Populated automatically by the AI briefing process.
-- Represents the items that need a human decision today.
-- Resolved items leave the active view but remain in the table as history.

CREATE TABLE IF NOT EXISTS today_board_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  briefing_id      UUID REFERENCES discovery_briefings(id) ON DELETE SET NULL,
  cluster_id       UUID REFERENCES discovery_clusters(id)  ON DELETE SET NULL,
  suggestion_id    UUID REFERENCES cluster_review_suggestions(id) ON DELETE SET NULL,

  -- What kind of item this is
  section          TEXT NOT NULL,
  -- Prominent Topics | Content Candidates | Needs Research
  -- | Cleanup Review | Market Watch Alerts | Competitor Alerts

  rank             INTEGER DEFAULT 0,  -- lower = higher priority within section

  -- Content
  title            TEXT NOT NULL,
  summary          TEXT,
  why_today        TEXT,   -- AI explanation for why this appears today
  evidence_summary TEXT,
  ai_confidence    TEXT    DEFAULT 'Medium',
  recommended_action TEXT,

  -- Status
  status           TEXT    NOT NULL DEFAULT 'New today',
  -- New today | Needs decision | Keep watching | Needs research
  -- | Move to Content Review | Hold for repetition | Already covered
  -- | Cleanup confirmed | Resolved

  -- Reviewer
  reviewer_id      UUID,
  reviewer_note    TEXT,
  resolved_at      TIMESTAMPTZ,

  board_date       DATE    NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE today_board_items
    ADD CONSTRAINT today_section_check
    CHECK (section IN (
      'Prominent Topics', 'Content Candidates', 'Needs Research',
      'Cleanup Review', 'Market Watch Alerts', 'Competitor Alerts'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE today_board_items
    ADD CONSTRAINT today_status_check
    CHECK (status IN (
      'New today', 'Needs decision', 'Keep watching', 'Needs research',
      'Move to Content Review', 'Hold for repetition', 'Already covered',
      'Cleanup confirmed', 'Resolved'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS
ALTER TABLE today_board_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users can read today_board_items"
  ON today_board_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "Auth users can update today_board_items"
  ON today_board_items FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Service role can write today_board_items"
  ON today_board_items FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_today_date      ON today_board_items(board_date DESC);
CREATE INDEX IF NOT EXISTS idx_today_section   ON today_board_items(section);
CREATE INDEX IF NOT EXISTS idx_today_status    ON today_board_items(status);
CREATE INDEX IF NOT EXISTS idx_today_cluster   ON today_board_items(cluster_id);
CREATE INDEX IF NOT EXISTS idx_today_unresolved ON today_board_items(board_date, status)
  WHERE status NOT IN ('Resolved', 'Cleanup confirmed', 'Already covered');

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_today_board_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_today_board_updated_at
  BEFORE UPDATE ON today_board_items
  FOR EACH ROW EXECUTE FUNCTION update_today_board_updated_at();
