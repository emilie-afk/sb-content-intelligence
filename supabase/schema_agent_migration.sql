-- ── SB Signal Flow Agent — schema migration ────────────────────────────────
-- Run in Supabase → SQL Editor after deploying the agent Netlify functions.
-- Safe to run on an existing database (uses IF NOT EXISTS).

-- ── 1. agent_run_log ─────────────────────────────────────────────────────────
-- One row per agent invocation. Tracks overall run health.

CREATE TABLE IF NOT EXISTS agent_run_log (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  run_type         text         NOT NULL
                                CHECK (run_type IN ('scheduled', 'manual')),

  status           text         NOT NULL
                                CHECK (status IN ('running', 'completed', 'failed', 'timeout')),

  started_at       timestamptz  NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  -- Structured summary returned by the agent at end of run
  summary          jsonb,

  -- Error message if status = 'failed'
  error            text,

  -- Total Claude tool_use calls made this run
  tool_calls_count integer      DEFAULT 0,

  -- Total process_signal_batch calls made this run
  batch_calls_count integer     DEFAULT 0,

  -- NULL for scheduled runs (performed_by = agent); set for manual admin runs
  performed_by     uuid         REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_log_started_at
  ON agent_run_log (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_log_status
  ON agent_run_log (status);

-- ── 2. agent_action_log ──────────────────────────────────────────────────────
-- One row per tool call within a run. The granular audit trail.

CREATE TABLE IF NOT EXISTS agent_action_log (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links back to the parent run
  run_id                uuid         NOT NULL
                                     REFERENCES agent_run_log(id) ON DELETE CASCADE,

  -- Name of the tool called (matches ALLOWED_TOOLS in _agent-tools.js)
  tool_name             text         NOT NULL,

  -- High-level category (read | write | suggest)
  action_type           text
                        CHECK (action_type IN ('read', 'write', 'suggest')),

  -- Which Supabase table was the primary target (null for read-only or HTTP calls)
  target_table          text,

  -- UUID of the record acted on (e.g. cluster_id for suggest_ calls)
  target_id             uuid,

  -- Raw input Claude passed to the tool
  input                 jsonb,

  -- Raw output returned to Claude
  output                jsonb,

  -- Outcome of this specific tool call
  status                text         NOT NULL
                                     CHECK (status IN ('success', 'error', 'skipped')),

  -- True for suggest_review_move and suggest_cleanup — needs human follow-up
  requires_human_review boolean      NOT NULL DEFAULT false,

  created_at            timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_action_log_run_id
  ON agent_action_log (run_id);

CREATE INDEX IF NOT EXISTS idx_agent_action_log_tool_name
  ON agent_action_log (tool_name);

CREATE INDEX IF NOT EXISTS idx_agent_action_log_requires_review
  ON agent_action_log (requires_human_review)
  WHERE requires_human_review = true;

-- ── Done ─────────────────────────────────────────────────────────────────────
-- After running this:
--   1. Deploy the Netlify functions (_agent-tools.js, run-agent.js)
--   2. Update maintenance-run.js to accept x-internal-secret (same as batch-cluster.js)
--   3. Set env var INTERNAL_SECRET in Netlify (if not already set from security hardening)
--   4. Create the daily-agent-triage scheduled task in Cowork
