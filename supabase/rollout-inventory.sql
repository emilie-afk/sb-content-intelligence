-- ============================================================================
-- SB Content Intelligence — READ-ONLY inventory. Changes nothing.
-- Run in Supabase → SQL Editor before the migration (save the results as the
-- "before" record) and again after it. Each block is a separate result; run the
-- blocks one at a time if the editor only shows the last result.
-- Contains no secrets; results may contain member emails — do not paste them
-- into GitHub issues or chat.
-- ============================================================================

-- 1. Every policy on public tables (who can do what)
select tablename, policyname, cmd, roles::text, permissive, qual, with_check
  from pg_policies where schemaname = 'public'
 order by tablename, cmd, policyname;

-- 2. Table privileges held by the API roles
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated')
 group by 1, 2 order by 1, 2;

-- 3. Tables without RLS (anything listed here is readable with the publishable key if anon has grants)
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relrowsecurity, c.relname;

-- 4. Views / materialized views in public and whether the API roles can read them
select c.relname as view_name, c.relkind,
       has_table_privilege('anon', c.oid, 'select') as anon_can_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v','m') order by 1;

-- 5. SECURITY DEFINER functions and who may execute them
select n.nspname as schema, p.proname as function, pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.prosecdef and n.nspname in ('public','ci_private')
 order by 1, 2;

-- 6. Storage buckets (this app uses none; anything public here is world-readable)
select id, name, public from storage.buckets order by 1;

-- 7. Row counts (compare before/after: the migration must not change them,
--    except settings −1 and app_settings −1 when those rows were moved)
select 'signals' t, count(*) from signals union all
select 'discovery_clusters', count(*) from discovery_clusters union all
select 'signal_cluster_links', count(*) from signal_cluster_links union all
select 'content_review_candidates', count(*) from content_review_candidates union all
select 'opportunities', count(*) from opportunities union all
select 'briefs', count(*) from briefs union all
select 'script_outputs', count(*) from script_outputs union all
select 'published_videos', count(*) from published_videos union all
select 'performance_snapshots', count(*) from performance_snapshots union all
select 'learning_memory', count(*) from learning_memory union all
select 'brand_content_rules', count(*) from brand_content_rules union all
select 'plant_watchlist', count(*) from plant_watchlist union all
select 'settings', count(*) from settings union all
select 'app_settings', count(*) from app_settings union all
select 'users_profile', count(*) from users_profile union all
select 'submission_tokens', count(*) from submission_tokens union all
select 'activity_log', count(*) from activity_log union all
select 'today_board_items', count(*) from today_board_items union all
select 'cluster_review_suggestions', count(*) from cluster_review_suggestions union all
select 'cluster_audit_log', count(*) from cluster_audit_log union all
select 'discovery_briefings', count(*) from discovery_briefings union all
select 'competitor_activity', count(*) from competitor_activity union all
select 'market_watch_plants', count(*) from market_watch_plants;

-- 8. Members by role (and, after the migration, by access status)
select role, count(*) from users_profile group by 1 order by 1;
-- after migration:  select role, access_status, count(*) from users_profile group by 1, 2 order by 1, 2;
-- private list (owner only, do not share):  select * from ci_private.list_members();

-- 9. Settings keys that are browser-readable (no values) and app_settings ids
select 'settings' as source, key from settings union all select 'app_settings', id from app_settings order by 1, 2;

-- 10. Submission tokens (no hashes)
select id, label, allowed_action, active, expires_at, rate_limit_per_hour, last_used_at from submission_tokens order by created_at;

-- 11. Public tables that are NOT part of this app (other apps sharing the project)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname <> all (array['users_profile','sources','signals','opportunities','opportunity_sources','briefs',
     'published_videos','performance_snapshots','learning_memory','submission_tokens','settings','script_outputs',
     'brand_content_rules','activity_log','plant_watchlist','discovery_clusters','signal_cluster_links',
     'content_review_candidates','competitor_activity','market_watch_plants','market_watch_signal_links','sb_products',
     'help_docs','app_settings','agent_run_log','agent_action_log','cluster_audit_log','today_board_items',
     'cluster_review_suggestions','discovery_briefings','ci_integration_config','ci_prompt_versions',
     'ci_usage_counters','ci_locks'])
 order by 1;
