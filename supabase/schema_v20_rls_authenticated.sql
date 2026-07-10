-- Grant authenticated users full read/write on all dashboard tables.
-- Run in Supabase SQL Editor.

-- SIGNALS
DROP POLICY IF EXISTS "auth_delete_signals" ON signals;
CREATE POLICY "auth_delete_signals" ON signals FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_update_signals" ON signals;
CREATE POLICY "auth_update_signals" ON signals FOR UPDATE TO authenticated USING (true);

-- DISCOVERY CLUSTERS
DROP POLICY IF EXISTS "auth_update_clusters" ON discovery_clusters;
CREATE POLICY "auth_update_clusters" ON discovery_clusters FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_clusters" ON discovery_clusters;
CREATE POLICY "auth_delete_clusters" ON discovery_clusters FOR DELETE TO authenticated USING (true);

-- CONTENT REVIEW CANDIDATES
DROP POLICY IF EXISTS "auth_update_candidates" ON content_review_candidates;
CREATE POLICY "auth_update_candidates" ON content_review_candidates FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_candidates" ON content_review_candidates;
CREATE POLICY "auth_delete_candidates" ON content_review_candidates FOR DELETE TO authenticated USING (true);

-- BRIEFS
DROP POLICY IF EXISTS "auth_update_briefs" ON briefs;
CREATE POLICY "auth_update_briefs" ON briefs FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_briefs" ON briefs;
CREATE POLICY "auth_delete_briefs" ON briefs FOR DELETE TO authenticated USING (true);

-- SCRIPTS
DROP POLICY IF EXISTS "auth_update_scripts" ON script_outputs;
CREATE POLICY "auth_update_scripts" ON script_outputs FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_scripts" ON script_outputs;
CREATE POLICY "auth_delete_scripts" ON script_outputs FOR DELETE TO authenticated USING (true);

-- SIGNAL CLUSTER LINKS
DROP POLICY IF EXISTS "auth_delete_signal_links" ON signal_cluster_links;
CREATE POLICY "auth_delete_signal_links" ON signal_cluster_links FOR DELETE TO authenticated USING (true);

-- LEARNING MEMORY
DROP POLICY IF EXISTS "auth_update_learning" ON learning_memory;
CREATE POLICY "auth_update_learning" ON learning_memory FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_learning" ON learning_memory;
CREATE POLICY "auth_delete_learning" ON learning_memory FOR DELETE TO authenticated USING (true);

-- PUBLISHED VIDEOS
DROP POLICY IF EXISTS "auth_update_published" ON published_videos;
CREATE POLICY "auth_update_published" ON published_videos FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_published" ON published_videos;
CREATE POLICY "auth_delete_published" ON published_videos FOR DELETE TO authenticated USING (true);

-- BRAND CONTENT RULES
DROP POLICY IF EXISTS "auth_update_brand_rules" ON brand_content_rules;
CREATE POLICY "auth_update_brand_rules" ON brand_content_rules FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_brand_rules" ON brand_content_rules;
CREATE POLICY "auth_delete_brand_rules" ON brand_content_rules FOR DELETE TO authenticated USING (true);
