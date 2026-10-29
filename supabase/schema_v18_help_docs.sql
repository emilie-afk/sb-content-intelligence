-- Help docs table — stores the user manual in Supabase (not in public GitHub repo)
CREATE TABLE IF NOT EXISTS help_docs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,  -- markdown
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE help_docs ENABLE ROW LEVEL SECURITY;

-- Only authenticated users can read
-- [policy removed 2026-10-28: access rules live in migrations/20261028_ci_access_control.sql]

-- Only service_role can write (via Netlify functions or Supabase dashboard)
-- No INSERT/UPDATE policy for authenticated = only admins via Supabase dashboard can edit

-- The manual's content is maintained privately in the database (help_docs rows), not in
-- this public repository. Import or edit it from the Supabase SQL editor.
