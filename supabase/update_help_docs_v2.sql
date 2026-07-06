-- Run this in the Supabase SQL Editor to update the user manual.
-- This replaces the old help content with the full tab-by-tab guide.

UPDATE help_docs SET
  content = $MANUAL$
# SB Content Intelligence — User Manual

## How signals become content

Every piece of content this dashboard produces starts as a **signal** — a social post, comment, or trend spotted by you or the Instagram scraper. Signals flow through four stages before becoming a brief:

```
Signal → Inbox → Discovery (clustered) → Content Review → Brief → Script → Published
```

Here is what happens at each stage and where to find it.

---

## The tabs

### 🏠 Command Center

Your home screen. Shows four counters at the top:

- **High Priority** — clusters or opportunities flagged urgent
- **New in Inbox** — unreviewed signals waiting
- **Briefs Approved** — briefs ready for production
- **Snapshots Due** — published videos with performance checkpoints coming up

Below the counters: a snapshot of today's top decisions, briefs needing approval, and any performance checkpoints due. Clicking **Open Today →** takes you to the Today tab.

---

### 📥 Inbox

Raw signals land here first — both from the **Intake app** (your manual submissions) and the Instagram scraper.

**Filters** across the top let you narrow by platform, priority, or status.

**Buttons:**
- **+ Add Signal** — manually log a post directly in the dashboard (platform, creator, topic, engagement numbers, and the audience problem it reveals)
- **🔍 Cluster all** — sends all unclustered signals to the AI, which groups them into topic clusters and moves them to Discovery

Signals stay in the Inbox until they are clustered. Once clustered, they show a link to their cluster in Discovery.

---

### 📅 Today

AI-populated daily action board. Shows clusters that the AI has promoted to "review ready" and thinks you should act on today.

**Buttons on each item:**
- **✨ Generate Briefing** — asks the AI to pick the strongest clusters and populate this board with its recommendations (choose On-demand, Daily, or Weekly)
- **📄 Export .md** — downloads that day's topics as a Markdown file for offline reference

Each cluster card on this board shows a suggested direction and priority. Acting here sends the cluster to Content Review.

---

### 🔍 Discovery

All active clusters, grouped by status. A cluster is a group of signals that share the same topic or audience question.

**Cluster statuses:**
- **Collecting** — fewer than the threshold of signals, still gathering
- **Pattern detected** — enough signal to act on; ready for review
- **Content review ready** — already moved to Content Review queue
- **Keep watching** — low signal now, worth monitoring
- **Mention only** — not enough substance for a brief

**Filters:** narrow by plant, platform, or status. Toggle between **📋 Sections** view (grouped by status) and **☰ All** view (flat list).

**Buttons:**
- **↺ Refresh** — reload the board
- **⚙️ Run Maintenance** — re-runs qualification checks on all clusters (updates signal counts, checks if any should be promoted)
- **🧹 Run Cleanup** — AI reviews all clusters and removes or re-routes ones that are irrelevant or duplicates
- **✨ AI Briefing** — generates today's briefing and populates the Today board

**Inside a cluster card:** click the cluster title to expand it. You'll see all the source signals, the AI's pattern summary, and action buttons:
- **→ Content Review** — move this cluster to the review queue
- **🪄 Brief** — skip Content Review and generate a brief directly
- **🗑️ Delete / Block** — remove the cluster with a reason

---

### 🗂️ Content Review

Clusters waiting for your direction decision. The AI has already prepared a summary and suggested direction for each one. You decide what becomes a brief.

**Stats at the top:**
- Ready for review / Follow-up opportunities / Needs research / Approved for brief

**Filters:** status and repetition risk.

**On each candidate card:**
- **✅ Approve + Generate Brief** — confirm a direction and generate the brief in one step
- **🔬 Needs research** — sends the cluster back to Discovery (status: "Pattern detected") so more signal can collect before a decision
- **⏸ Hold** — keep it in the queue but take no action yet
- **✓ Already covered** — mark as done if this topic has been filmed before
- **✕ Dismiss** — remove from the queue permanently

---

### 📋 Briefs

All content briefs — drafted from Discovery clusters or created manually.

**Filter** by status: Draft → Needs review → Approved → Filming → Editing → Scheduled → Published → Measured.

**Buttons:**
- **+ New Brief** — create a brief manually (title, product, hook, format, flow, caption, CTA, deadline)
- **Action column on each row** — open, edit, update status, or generate a script from the brief

Once a brief is approved, the next step is to generate a script from it in the **Scripts** tab.

---

### 📝 Scripts

Production-ready video scripts generated from approved briefs. This is where the brief becomes something the creator can actually film from.

**Filters:** status (Draft → Needs review → Approved → Used in production) and platform.

**Buttons:**
- **+ New Script** — generate a script from a brief, or write one manually
- **Action column** — view the full script, run an **AI brand check** (reviews against Brand Rules and flags issues), revise, or approve

Once the script is approved, the video gets filmed and the result is logged in **Published**.

---

### 📊 Published

Log videos after they go live and track performance over time.

**Buttons:**
- **+ Add Video** — log a published video with URL, platform, format, and publish date
- **↺ Sync metrics from sheet** — pulls performance numbers (views, likes) from the SB Videos Google Sheet into the dashboard

The table shows 24h, 72h, and 7-day performance checkpoints. When a checkpoint is due, it appears in Command Center.

---

### 🧠 Learning

Performance lessons from past content — what worked, what to avoid, and what to change next time. The AI generates these after videos are measured.

**Filter** by status: Needs Review → Active → Approved Rules → Archived.

**Buttons:**
- **+ Add Memory** — manually add a learning (what happened, recommendation, confidence level)
- **Action column** — approve a learning to make it an active rule, or archive it

Active and approved rules feed back into the AI when it generates new briefs and scripts.

---

### 🔗 Sources

Tracks the accounts and creators that generate your most useful signals. Helps you know where to focus your social listening.

**Table shows:** source name, platform, type, how often they post, signal quality, and how many of their signals became approved ideas or published videos.

**Button:**
- **+ Add Source** — log a new account or creator to track

---

### 🎯 Brand Rules

The rules the AI follows when generating hooks, scripts, and captions. Covers brand voice, content guidelines, legal constraints, accuracy standards, and product messaging.

**Filters:** category and severity (Required / Recommended / Avoid / Forbidden).

**Button:**
- **+ Add Rule** — add a new rule with category, severity, platform scope, and the rule text itself

Changes here take effect immediately for any AI generation that happens after.

---

### 🌿 Plant Watchlist

Plants ranked by revenue tier, updated from the Revenue by Genus Google Sheet. The AI uses this to prioritize signals and briefs toward plants that sell.

**Import:** click **📥 Import CSV**, then download the Revenue by Genus tab from the Google Sheet as a CSV or XLSX and upload it here.

**Filter** by tier: High / Medium / Watch.

---

### 🔍 Competitor Activity

Social posts flagged by the AI as competitor content — giveaways, promotions, product launches, and showcases from other succulent sellers and third-party accounts.

**Filters:** status (New / Reviewed / Flagged / Dismissed), catalog match, and activity type.

Each card shows what the competitor posted, whether it matches something in SB's catalog, and what type of activity it is. Use this to spot gaps and react to competitor moves.

---

### 📈 Market Watch

Plants that are trending in social content but are not currently in SB's catalog. Potential future opportunities for merchandising.

**Filter** by reviewer status: Unreviewed / Watching / Flag for merchandising / Dismissed.

Flag interesting plants for the merchandising team directly from this tab.

---

### 📜 Activity Log

Full audit trail of every action taken in the dashboard — who approved, rejected, or changed the status of any opportunity, brief, or script, and when.

**Filter** by type: Opportunities / Briefs / Scripts.

---

## The full signal flow — from Intake submission to published video

1. **You spot something** — a comment asking how to care for a plant, a trending post, a competitor giveaway. You submit it through the **Intake app** (the Google Sheet + Apps Script). The submission goes directly into the dashboard Inbox.

2. **It lands in Inbox** — the signal appears in the Inbox tab with platform, creator, topic, and engagement data.

3. **Clustering** — either the daily auto-cluster (runs at 7:30 AM) or the **🔍 Cluster all** button groups the signal with others that share the same topic. A cluster is created or the signal is added to an existing one. The cluster moves to **Discovery**.

4. **Discovery watches the cluster** — as more signals come in on the same topic, the cluster accumulates signal count. When it crosses the threshold, it becomes **Pattern detected** — ready for a decision.

5. **Today board surfaces it** — the next AI Briefing run picks it up and adds it to the **Today** tab as a recommended action.

6. **You send it to Content Review** — from Discovery or Today, you click **→ Content Review**. The AI prepares a summary, suggested direction, and repetition risk check.

7. **You decide in Content Review:**
   - **Approve** → generates a brief automatically, moves to **Briefs** tab
   - **Needs research** → sends back to Discovery for more signal
   - **Dismiss** → removes from queue

8. **Brief is approved** — the brief moves through Draft → Needs review → Approved in the **Briefs** tab.

9. **Script is generated** — from the approved brief, generate a script in the **Scripts** tab. Run the AI brand check to catch any issues before filming. Once approved, the creator films it.

10. **You log the published video** — go to **Published**, click **+ Add Video**, and fill in the post URL and date.

11. **Performance is tracked** — at 24h, 72h, and 7 days, checkpoint reminders appear in Command Center. Use **Sync metrics from sheet** to pull the numbers in.

12. **Learning is captured** — once measured, a learning is added to the **Learning** tab. If approved, it becomes a rule that feeds into the next round of AI briefs.

$MANUAL$,
  updated_at = NOW()
WHERE id = 'user-manual';
