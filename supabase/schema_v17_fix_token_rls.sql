-- Fix: submission_tokens should NOT be writable by the anon key.
-- Only service_role (Netlify functions) should read/write this table.

-- Remove any existing policies
DROP POLICY IF EXISTS "submission_tokens_select" ON submission_tokens;
DROP POLICY IF EXISTS "submission_tokens_update" ON submission_tokens;
DROP POLICY IF EXISTS "submission_tokens_insert" ON submission_tokens;
DROP POLICY IF EXISTS "submission_tokens_delete" ON submission_tokens;

-- Enable RLS (in case it wasn't already)
ALTER TABLE submission_tokens ENABLE ROW LEVEL SECURITY;

-- No policies = anon and authenticated roles see nothing.
-- service_role bypasses RLS entirely (Netlify functions use service_role key).
-- This is the correct setup: only your backend can read/write tokens.
