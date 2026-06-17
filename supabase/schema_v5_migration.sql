-- ============================================================
-- SB Content Intelligence — Schema v5 Migration
-- Run AFTER schema_v4_migration.sql is applied.
-- Supabase → SQL Editor → New Query → paste → Run
-- ============================================================


-- ── 1. REPETITION GUARDRAIL FIELDS ON OPPORTUNITIES ──────────
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS similar_published_url    TEXT,
  ADD COLUMN IF NOT EXISTS similar_published_date   DATE,
  ADD COLUMN IF NOT EXISTS days_since_similar        INT,
  ADD COLUMN IF NOT EXISTS previous_plant            TEXT,
  ADD COLUMN IF NOT EXISTS previous_hook             TEXT,
  ADD COLUMN IF NOT EXISTS previous_angle            TEXT,
  ADD COLUMN IF NOT EXISTS previous_format           TEXT,
  ADD COLUMN IF NOT EXISTS previous_performance      TEXT,
  ADD COLUMN IF NOT EXISTS audience_followup_demand  TEXT,
  ADD COLUMN IF NOT EXISTS new_angle_available       BOOLEAN,
  ADD COLUMN IF NOT EXISTS freshness_reason          TEXT,
  ADD COLUMN IF NOT EXISTS repetition_risk           TEXT CHECK (repetition_risk IN ('Low','Medium','High','Block')),
  ADD COLUMN IF NOT EXISTS repetition_recommendation TEXT;


-- ── 2. LEARNING MEMORY FIELDS ON PUBLISHED_VIDEOS ─────────────
ALTER TABLE published_videos
  ADD COLUMN IF NOT EXISTS hook_used                  TEXT,
  ADD COLUMN IF NOT EXISTS angle_used                 TEXT,
  ADD COLUMN IF NOT EXISTS audience_followup_questions TEXT,
  ADD COLUMN IF NOT EXISTS cooldown_days              INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS repeat_potential           TEXT CHECK (repeat_potential IN ('High','Medium','Low','None'));
