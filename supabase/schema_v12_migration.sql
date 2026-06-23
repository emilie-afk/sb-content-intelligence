-- ============================================================
-- schema_v12_migration.sql
-- SB Product Catalog table
--
-- Sourced from Shopify product export (June 2026)
-- Update is_active = false when you discontinue a product.
-- Add new rows when you add new products.
-- Run seed_sb_products.sql after this migration.
-- ============================================================

-- ── TABLE ────────────────────────────────────────────────────────────────────

create table if not exists sb_products (
  id               uuid primary key default gen_random_uuid(),

  -- Shopify identifiers
  handle           text not null unique,   -- shopify URL slug
  title            text not null,          -- full product title as on website

  -- Name variants for cluster matching
  common_name      text,    -- title with scientific name stripped out
  scientific_name  text,    -- binomial/trinomial extracted from parens in title
  short_name       text,    -- product short name metafield

  -- Classification
  genus            text,    -- verified genus from Shopify metafield (lowercase)
  tags             text,    -- raw Shopify tags (comma-separated)

  -- Status
  is_active        boolean  not null default true,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── INDEXES ──────────────────────────────────────────────────────────────────

create index if not exists sb_products_genus_idx     on sb_products (genus);
create index if not exists sb_products_is_active_idx on sb_products (is_active);

-- Full-text search across all name fields
create index if not exists sb_products_fts_idx on sb_products
  using gin(to_tsvector('english',
    coalesce(title, '') || ' ' ||
    coalesce(common_name, '') || ' ' ||
    coalesce(scientific_name, '')
  ));

-- ── AUTO-UPDATE updated_at ────────────────────────────────────────────────────

create or replace function update_sb_products_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists sb_products_updated_at on sb_products;
create trigger sb_products_updated_at
  before update on sb_products
  for each row execute function update_sb_products_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table sb_products enable row level security;
-- Functions use service_role key — no extra policy needed.
