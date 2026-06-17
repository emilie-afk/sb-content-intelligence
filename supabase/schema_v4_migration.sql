-- ============================================================
-- SB Content Intelligence — Schema v4 Migration
-- Run AFTER schema_v3_migration.sql is applied.
-- Supabase → SQL Editor → New Query → paste → Run
-- ============================================================


-- ── 1. PLANT WATCHLIST TABLE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS plant_watchlist (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plant_name        TEXT NOT NULL,          -- genus name, e.g. Echeveria
  common_names      TEXT,                   -- e.g. "Hen and chicks, Stone rose"
  genus_species     TEXT,                   -- optional scientific name detail
  revenue           NUMERIC(10,2),          -- total sales from revenue sheet
  net_sales         NUMERIC(10,2),
  skus              INT,                    -- number of products (SKUs)
  net_items_sold    INT,
  pct_total_revenue NUMERIC(5,2),           -- % of total revenue
  revenue_tier      TEXT CHECK (revenue_tier IN ('High','Medium','Watch')),
  stock_status      TEXT DEFAULT 'Unknown' CHECK (stock_status IN ('In stock','Low stock','Out of stock','Unknown')),
  priority_level    TEXT DEFAULT 'Normal'  CHECK (priority_level IN ('High','Normal','Watch','Pause')),
  search_keywords   TEXT,                   -- comma-separated search terms
  notes             TEXT,
  last_imported_at  TIMESTAMPTZ,
  last_checked_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plant_name)
);

CREATE OR REPLACE TRIGGER plant_watchlist_updated_at
  BEFORE UPDATE ON plant_watchlist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE plant_watchlist ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read; admin/owner can write
CREATE POLICY "auth_read_watchlist" ON plant_watchlist
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "admin_manage_watchlist" ON plant_watchlist
  FOR ALL USING (get_user_role() IN ('admin', 'owner'));


-- ── 2. ADD REVENUE PRIORITY FIELDS TO SIGNALS ─────────────────
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS revenue_priority_match TEXT
    CHECK (revenue_priority_match IN ('Yes','No','Needs check')),
  ADD COLUMN IF NOT EXISTS revenue_priority_note TEXT;


-- ── 3. ADD REVENUE PRIORITY FIELDS TO OPPORTUNITIES ───────────
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS revenue_priority_match TEXT
    CHECK (revenue_priority_match IN ('Yes','No','Needs check')),
  ADD COLUMN IF NOT EXISTS revenue_priority_note TEXT;
