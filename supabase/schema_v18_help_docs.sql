-- Help docs table — stores the user manual in Supabase (not in public GitHub repo)
CREATE TABLE IF NOT EXISTS help_docs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,  -- markdown
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE help_docs ENABLE ROW LEVEL SECURITY;

-- Only authenticated users can read
CREATE POLICY "help_docs_read" ON help_docs
  FOR SELECT USING (auth.role() = 'authenticated');

-- Only service_role can write (via Netlify functions or Supabase dashboard)
-- No INSERT/UPDATE policy for authenticated = only admins via Supabase dashboard can edit

INSERT INTO help_docs (id, title, content) VALUES (
'user-manual',
'Dashboard User Manual',
$MANUAL$
# SB Content Intelligence — User Manual

## Overview
This dashboard turns Instagram signals into content briefs automatically. Signals flow in daily from the Instagram scraper, get clustered by the AI, and surface as content opportunities for review.

---

## Signal Flow
1. **Instagram Scraper** runs weekdays at 11 AM → submits posts to the dashboard
2. **Auto-cluster** runs at 7:30 AM daily → groups signals into topic clusters
3. **You** review clusters in Discovery → approve directions → generate briefs

---

## Tabs

### 📅 Today
Your daily action board. Shows clusters ready for a decision and cleanup suggestions.
- **→ Content Review**: move a cluster to the review queue
- **🪄 Brief**: skip review and generate a brief directly
- **Cleanup suggestions**: AI flags clusters to close, merge, or watch

### 🔍 Discovery
All active clusters grouped by signal strength.
- **Pattern detected**: enough signals to act on — click to open the cluster panel
- **Collecting**: still gathering signals, not ready yet
- Click a cluster title to see all source posts and possible directions
- Use **🪄 Brief** to fast-lane straight to a brief without going through Content Review

### 📋 Content Review
Clusters that have been moved for a direction decision.
- **Approve direction + Generate Brief**: pick a direction note and generate the brief in one click
- **🔬 Needs research**: sends the cluster back to Discovery for more signal collection
- **⏸ Hold**: keep it in queue but don't act yet
- **✓ Already covered**: mark as done if we've made this content before
- **✕ Dismiss**: remove from queue

### 📄 Briefs
All generated content briefs. Click to view the full brief and script.

### 📢 Published
Log videos after publishing. Fill in the URL, platform, and publish date.
- Use **↺ Sync metrics from sheet** to pull performance data from the SB Videos Google Sheet

### 🧠 Learning
Performance summaries fed back from published videos — what worked, what to improve.

### 🔗 Sources
All raw signals in the inbox. Filter by platform, status, or priority.

### 📝 Scripts
Generated video scripts ready for production.

### 🎯 Brand Rules
Content and tone guidelines used by the AI when generating briefs and scripts.

### 🌿 Plant Watchlist
Plants to monitor for trending signals.

### 👀 Competitor Activity
Signals flagged as competitor content.

### 📈 Market Watch
Broader plant trend signals outside SB catalog.

### 📋 Activity Log
Full audit trail of all actions taken in the dashboard.

---

## Cluster Lifecycle
```
Collecting → Pattern detected → Content review ready → Brief created → Published
                    ↑                   |
                    └── Needs research ─┘
```

## Tips
- Run the scraper manually any time: open PowerShell → `python sb_instagram_scraper.py`
- Check `sb_scraper_log.txt` if signals aren't coming in
- The daily auto-cluster runs at 7:30 AM — new signals from the previous day will be clustered by the time you start work
$MANUAL$
) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW();
