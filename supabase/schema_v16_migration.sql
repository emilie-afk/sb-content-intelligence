-- schema_v16_migration.sql
-- Closes the cluster lifecycle loop:
--   briefs.cluster_id      → links a brief back to its source cluster
--   published_videos.cluster_id → links a published video back to its cluster
-- When a video is published, the cluster is set to status = 'Published'
-- so it drops off Discovery and Today board and feeds the AI learning loop.

-- 1. Add cluster_id to briefs
ALTER TABLE briefs
  ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES discovery_clusters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_briefs_cluster_id ON briefs(cluster_id);

-- 2. Add cluster_id to published_videos
ALTER TABLE published_videos
  ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES discovery_clusters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_published_videos_cluster_id ON published_videos(cluster_id);
