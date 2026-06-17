-- ============================================================
-- SB Content Intelligence — Schema v3 Migration
-- Run AFTER schema.sql AND schema_v2_migration.sql are applied.
-- Supabase → SQL Editor → New Query → paste → Run
-- ============================================================


-- ── 1. ADD updated_by TO BRIEFS AND SCRIPT_OUTPUTS ───────────
-- Tracks who made the last status change (for audit log)
ALTER TABLE briefs
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users_profile(id);

ALTER TABLE script_outputs
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users_profile(id);


-- ── 2. ACTIVITY LOG TABLE ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('opportunity', 'brief', 'script')),
  entity_id    UUID NOT NULL,
  entity_title TEXT,                     -- human-readable name for display
  action       TEXT NOT NULL,            -- e.g. "Approve brief", "Status → Approved"
  old_value    TEXT,
  new_value    TEXT,
  performed_by UUID REFERENCES users_profile(id),
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read the log
CREATE POLICY "auth_read_log" ON activity_log
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Triggers insert via SECURITY DEFINER — no direct user insert policy needed


-- ── 3. ALLOW ASSISTANT TO APPROVE/REJECT OPPORTUNITIES AND BRIEFS ──
-- Opportunities: assistant can approve/reject
DROP POLICY IF EXISTS "reviewer_update_opportunities" ON opportunities;

CREATE POLICY "reviewer_update_opportunities" ON opportunities
  FOR UPDATE USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- Briefs: assistant can approve/reject
DROP POLICY IF EXISTS "reviewer_update_briefs" ON briefs;

CREATE POLICY "reviewer_update_briefs" ON briefs
  FOR UPDATE USING (
    get_user_role() IN ('admin', 'owner', 'assistant')
  );

-- Scripts: only owner/admin can approve (unchanged — assistant cannot approve scripts)
-- reviewer_update_scripts already set correctly in schema_v2_migration.sql


-- ── 4. TRIGGER: LOG OPPORTUNITY DECISIONS ────────────────────
CREATE OR REPLACE FUNCTION log_opportunity_decision()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.reviewer_decision IS DISTINCT FROM NEW.reviewer_decision)
     AND NEW.reviewer_decision IS NOT NULL
  THEN
    INSERT INTO activity_log (
      entity_type, entity_id, entity_title,
      action, old_value, new_value, performed_by
    ) VALUES (
      'opportunity',
      NEW.id,
      NEW.topic,
      NEW.reviewer_decision,
      OLD.reviewer_decision,
      NEW.reviewer_decision,
      NEW.reviewer_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS opportunity_decision_log ON opportunities;
CREATE TRIGGER opportunity_decision_log
  AFTER UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION log_opportunity_decision();


-- ── 5. TRIGGER: LOG BRIEF STATUS CHANGES ─────────────────────
CREATE OR REPLACE FUNCTION log_brief_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO activity_log (
      entity_type, entity_id, entity_title,
      action, old_value, new_value, performed_by
    ) VALUES (
      'brief',
      NEW.id,
      NEW.title,
      'Status → ' || NEW.status,
      OLD.status,
      NEW.status,
      NEW.updated_by
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS brief_status_log ON briefs;
CREATE TRIGGER brief_status_log
  AFTER UPDATE ON briefs
  FOR EACH ROW EXECUTE FUNCTION log_brief_status();


-- ── 6. TRIGGER: LOG SCRIPT STATUS CHANGES ────────────────────
CREATE OR REPLACE FUNCTION log_script_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.review_status IS DISTINCT FROM NEW.review_status THEN
    INSERT INTO activity_log (
      entity_type, entity_id, entity_title,
      action, old_value, new_value, performed_by
    ) VALUES (
      'script',
      NEW.id,
      NEW.script_title,
      'Status → ' || NEW.review_status,
      OLD.review_status,
      NEW.review_status,
      NEW.updated_by
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS script_status_log ON script_outputs;
CREATE TRIGGER script_status_log
  AFTER UPDATE ON script_outputs
  FOR EACH ROW EXECUTE FUNCTION log_script_status();
