-- RETIRED 2026-10-28.
-- This file used to grant every signed-in account update/delete on all dashboard tables
-- (USING (true)). It must never be run again. Access rules are defined only in
-- supabase/migrations/20261028_ci_access_control.sql (approved members, per-role).
select 1;
