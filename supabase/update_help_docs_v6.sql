-- Run this in the Supabase SQL Editor to update the user manual.
-- v6: Updates sheet column names to match new Thumbnail Title + Caption columns

UPDATE help_docs SET
  content = $MANUAL$
# SB Content Intelligence — User Manual

## How signals become content

Every piece of content this dashboard produces starts as a **signal** — a social post, comment, or trend spotted by you or the Instagram scraper. Signals flow through stages before becoming a published video:

```
Signal → Inbox → Discovery (clustered) → Content Review → Brief → Script → Sheet → Published
```

---

## The tabs

### 🏠 Command Center

Your home screen. Shows four counters at the top:

- **High Priority** — clusters or opportunities flagged urgent
- **New in Inbox** — unreviewed signals waiting
- **Briefs Approved** — briefs ready for production
- **Snapshots Due** — published videos with performance checkpoints coming up

Below the counters: a snapshot of today's top decisions, briefs needing approval, and any performance checkpoints due.

---

### 📥 Inbox

Raw signals land here — from the **Intake app** and the Instagram scraper.

**Filters:** source (Instagram Scraper / Manual Intake), platform, priority, and status.

**Bulk actions:**
- Checkbox each row to select signals, then click **✕ Dismiss Selected** to dismiss in bulk
- Click the **✕** button on any row to dismiss a single signal instantly

**Instagram Scraper cleanup:** if the scraper has imported signals that need cleanup, a callout appears at the top with a **🗑️ Delete All** button to remove them in one click.

**Buttons:**
- **+ Add Signal** — manually log a signal directly in the dashboard
- **🔍 Cluster all** — sends unclustered signals to the AI to group into topic clusters and move to Discovery

---

### 📅 Today

AI-populated daily action board. Shows clusters the AI has promoted and thinks you should act on today.

**Buttons on each item:**
- **✨ Generate Briefing** — asks the AI to populate this board (On-demand, Daily, or Weekly)
- **📄 Export .md** — downloads today's topics as a Markdown file

---

### 🔍 Discovery

All active clusters, grouped by status. A cluster is a group of signals sharing the same topic or audience question.

**Cluster statuses:**
- **Collecting** — not enough signals yet, still gathering
- **Pattern detected** — enough signal to act on; ready for review
- **Content review ready** — already moved to Content Review (hidden from other sections)
- **Keep watching** — low signal, worth monitoring
- **Mention only** — not enough substance for a brief

**Filters:** plant, platform, status. Toggle between **📋 Sections** view and **☰ All** view.

**Inside a cluster card:** click to expand. You'll see source signals, the AI's pattern summary, and action buttons:
- **→ Content Review** — move to the review queue
- **🪄 Brief** — skip Content Review and generate a brief directly
- **🗑️ Delete / Block** — remove with a reason

---

### 🗂️ Content Review

Clusters waiting for your direction decision.

**On each candidate card:**
- **✅ Approve + Generate Brief** — confirm a direction and generate the brief in one step
- **🔬 Needs research** — sends the cluster back to Discovery for more signal
- **⏸ Hold** — keep in queue, take no action yet
- **✓ Already covered** — mark done if this topic has been filmed before
- **✕ Dismiss** — remove permanently

---

### 📋 Briefs

All content briefs — drafted from Discovery clusters or created manually.

**Default view** shows only active briefs: Draft, Needs review, and Approved. Briefs with scripts in progress are hidden by default — use the status filter to see them.

**Status flow:** Draft → Needs review → Approved → Script in review → Filming → Editing → Scheduled → Published → Measured

**Approving a brief:**
When you change a brief's status to **Approved**, the dashboard immediately asks for a target video length (in seconds), then automatically sends it to the AI to generate a script. The brief moves to **Script in review** status and disappears from the default view. Find it again by filtering for "Script in review".

**Buttons:**
- **+ New Brief** — create a brief manually
- **🎬 on each row** — manually trigger script generation (if you need to regenerate)

---

### 📝 Scripts

Production-ready video scripts generated from approved briefs.

**Two sections:**

**⏳ Needs Review** — scripts that just came from the AI and are waiting for your review. No delete button here.

**📄 All Scripts** — everything else (Draft, Needs revision, Approved, Used in production, Archived). Has a status filter, a **📊 sheet button**, and a **🗑 delete button** per row.

**Spreadsheet integration:**

When you change a script's status to **Approved**, it is automatically written to the correct month tab in the Short Video Script Spreadsheet. The script in the sheet always starts with the hook as the first line.

Each row in the sheet receives:
- **Title** — script title
- **Thumbnail Title** — the bold 3–6 word phrase for the video cover image (falls back to hook if not set)
- **Script** — full voiceover with hook as the opening line, plus CTA at the end
- **Caption** — suggested post caption
- **Note** — platform

You can also click **📊** on any row to manually send a script to the sheet (useful for re-syncing). Only Approved scripts can be sent — clicking 📊 on a Draft will show a warning.

**📊 Short Video Script Spreadsheet button** (top right of the section) — opens the sheet directly, routed to the correct month tab. To update the URL for a new year, click **⚙️** next to it, paste the new URL, and save — no code change needed.

**Viewing a script:**
Click **View** to open the full script. You'll see:

- **Hook** — the first spoken line of the video (under 10 words). This is also literally the opening sentence of the voiceover.
- **🖼 Thumbnail title** — a bold 3–6 word phrase for the video cover image (shown in yellow). Use this as the text overlay on your TikTok/Reel thumbnail.
- **Script** — the full voiceover text
- **CTA** — closing call to action
- **Caption** — suggested post caption

At the bottom of the view:

- **Your notes for AI** — optional direction you type before regenerating
- **Hook pattern selector** — choose how the AI should open the next version:
  - **Let AI choose** — AI picks the strongest pattern
  - **Symptom first** — lead with what the viewer already sees
  - **Challenge a belief** — counterintuitive opener
  - **Stakes / urgency** — something is at risk now
  - **Bold claim** — specific, surprising payoff
  - **Mid-action start** — drop into the middle of something
- **🤖 AI Brand Check** — reviews the script against Brand Rules; flags violations, scores the hook, and suggests improvements
- **✨ Regenerate Script** — generates a fresh new version using the hook pattern you selected. If you ran a brand check first, the new version fixes the flagged issues. If you haven't, it writes a genuinely different take.

**Hook rules the AI always follows:** uses "you"/"your", under 10 words, never starts with "Today"/"Hi"/"In this video", must name a problem or make a bold claim, no em dashes.

---

### 📊 Published

Log videos after they go live and track performance.

**Buttons:**
- **+ Add Video** — log a published video with URL, platform, format, and publish date
- **↺ Sync metrics from sheet** — pulls performance numbers from the SB Videos Google Sheet

The table shows 24h, 72h, and 7-day performance checkpoints.

---

### 🧠 Learning

Performance lessons from past content. Active and approved rules feed into the AI when generating new briefs and scripts.

**Filter** by status: Needs Review → Active → Approved Rules → Archived.

---

### 🔗 Sources

Tracks accounts and creators that generate your most useful signals.

---

### 🎯 Brand Rules

The rules the AI follows when generating hooks, scripts, and captions. Changes take effect immediately for any AI generation that follows.

**Filters:** category and severity (Required / Recommended / Avoid / Forbidden).

---

### 🌿 Plant Watchlist

Plants ranked by revenue tier, updated from the Revenue by Genus Google Sheet. The AI uses this to prioritize signals toward plants that sell.

---

### 🔍 Competitor Activity

Social posts flagged as competitor content — giveaways, promotions, product launches.

---

### 📈 Market Watch

Plants trending in social content but not currently in SB's catalog. Flag interesting ones for the merchandising team.

---

### 📜 Activity Log

Full audit trail of every action in the dashboard.

**Who appears:**
- Your name — for status changes and manual actions you take
- **🤖 AI** (shown in purple) — for actions taken automatically by the AI: generating a brief, generating a script, revising a script, or revising a brief

For AI-generated scripts, the log shows which brief it came from (e.g. "From brief: Watering Problems") so you can trace the full chain from approval to script.

**Filter** by type: Opportunities / Briefs / Scripts.

---

## The full flow — signal to published video

1. **You spot something** — submit it through the **Intake app**. It lands in the Inbox.

2. **Clustering** — the daily auto-cluster (7:30 AM) or the **🔍 Cluster all** button groups it with signals on the same topic. The cluster moves to **Discovery**.

3. **Discovery watches** — as more signals arrive, the cluster grows. When it crosses the threshold it becomes **Pattern detected**.

4. **Today board surfaces it** — the next AI Briefing run picks it up and adds it to the **Today** tab.

5. **You send it to Content Review** — from Discovery or Today, click **→ Content Review**.

6. **You decide:**
   - **Approve** → brief is generated automatically → goes to Briefs tab as Draft
   - **Needs research** → sent back to Discovery
   - **Dismiss** → removed

7. **Brief is reviewed** — move through Draft → Needs review → **Approved**.

8. **Script is auto-generated** — approving a brief immediately triggers AI script generation (you choose the duration). The brief moves to "Script in review" and disappears from the default Briefs view. The script lands in **Scripts → Needs Review** as a Draft.

9. **Script is reviewed** — open it to see the hook, thumbnail title, and full voiceover. Run AI Brand Check if you want, choose a hook pattern, regenerate as needed.

10. **Script is approved** — change status to **Approved**. The script is automatically written to the correct month tab in the Short Video Script Spreadsheet. A toast confirms which row it landed on.

11. **You film it** — change the brief status to **Filming** when production starts. Use **📊 Short Video Script Spreadsheet** to open the tracking sheet.

12. **You log the published video** — go to **Published**, click **+ Add Video**.

13. **Performance is tracked** — 24h, 72h, 7-day checkpoints appear in Command Center.

14. **Learning is captured** — once measured, a learning goes to the **Learning** tab. Approved learnings feed into the next round of AI briefs and scripts.

$MANUAL$,
  updated_at = NOW()
WHERE id = 'user-manual';
