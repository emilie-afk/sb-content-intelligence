# SB Content Intelligence — Setup Guide
## Social Listening + Script Production

---

## ✅ DONE

### Infrastructure
- Supabase project created (`sb-social-listening`)
- All schema migrations run: schema.sql → v2 → v3 → v4 → v5
- Google OAuth configured, login working
- Netlify deployed: https://sb-content-intelligence.netlify.app
- GitHub repo connected (auto-deploy on push)
- Env vars set in Netlify: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLAUDE_API_KEY`
- Admin role set for Emilie

### Google Sheet (script output + content history)
- Sheet: https://docs.google.com/spreadsheets/d/1iDg61cxy6oSxb8vL2AkaivTnQJuTVJY5bKIbtNBLHAQ
- Apps Script deployed as Version 2 (Jun 17, 2026)
- Web app URL: `https://script.google.com/macros/s/AKfycbyaLjE54BUxcdbZWRkMjTz_j7rrO3PYJ9z-_UYoSN0rzvksTtlfZnfXQt5WrFcv7ch1/exec`
- URL saved in dashboard settings (Scripts → ⚙ Calendar URL)
- `doGet` reads all 12 monthly tabs for repetition checking
- `doPost` writes approved scripts to the current month tab

### Intake Sheet (assistant signal submission)
- Sheet: https://docs.google.com/spreadsheets/d/1M_GUihNRFgODfQuwB6PnBrbP145Rr1fwjdtUKE6Ckd4
- 6 columns: Raw input | Source URL | Platform | Source name | Status | Submitted at
- Auto-submits to dashboard when Raw input is filled (no manual steps)
- Script token: create one in dashboard → Settings → Submission Tokens (rotate any old token immediately)

### Instagram Scraper
- File: `SB content/sb_instagram_scraper.py` (outside sb-dashboard — not pushed to GitHub)
- Configured with Netlify URL and submit token

### Dashboard features live
- Command Center, Inbox, Daily Board, Briefs, Scripts, Published, Learning, Sources, Brand Rules, Activity Log
- **Plant Watchlist** — import revenue CSV by genus; auto-tiers (High/Medium/Watch); product names from individual genus tabs (collapsible)
- **AI analysis** on signals (🤖), briefs (🤖 AI Review), scripts (🤖 AI Brand Check)
- **Revenue priority badges** on signals and Daily Board cards
- **Repetition check** (🔁 Rep. Check) on Daily Board — reads 2026 sheet history + Supabase published videos
- **Content repetition guardrails** (Low/Medium/High/Block risk) with freshness reason
- Script approval → auto-pushes to Google Sheet current month tab
- **Discovery Board** — audience patterns clustered across signals; 5 sections (Most Mentioned, Most Asked, Emerging, New & Unfamiliar, Contradictions); reviewer actions: pin, keep watching, move to review, dismiss
- **Content Review queue** — AI-prepared candidate cards with repetition risk, owned-channel history, possible directions; reviewer decision: Approve direction / Needs research / Hold / Already covered / Dismiss
- **Auto-clustering** — every 🤖 signal analysis automatically clusters the signal and shows which cluster it joined

### Netlify functions deployed
- `submit-signal` — intake sheet + scraper submissions
- `ai-analyze` — Claude Haiku analysis for signals, briefs, scripts, opportunities, **and cluster extraction/matching**
- `import-watchlist` — CSV/XLSX upload → plant_watchlist table
- `get-sheet-history` — fetches script sheet history from Apps Script for repetition checking (set URL in Supabase settings: key = `calendar_script_url`)

### Instagram scraper
- Rewritten with `instagrapi` (mimics mobile app — avoids Instagram API blocks)
- Session saved to `sb_ig_session.json` for reuse
- Runs daily at 8:00 AM via Windows Task Scheduler (`setup_schedule.bat`)

---

## ⏳ STILL TO DO

### Run schema v7 migration (Discovery + Content Review)

Required before the Discovery Board and Content Review queue will work:

1. Supabase → SQL Editor → New Query
2. Open `supabase/schema_v7_migration.sql` → Copy all → Paste → Run
3. Creates: `discovery_clusters`, `signal_cluster_links`, `content_review_candidates`
4. Adds RLS policies, indexes, and updated_at triggers

Also run `schema_v6_migration.sql` if not already done (adds `top_products` to plant_watchlist).

---

### Import the plant watchlist

1. Download your Revenue by genus file (CSV or XLSX)
2. Dashboard → **Plant Watchlist** → click **📂 Choose file** → select your file
3. If XLSX: the importer auto-finds the "Revenue by genus" tab
4. Click **Import**
5. Plants populate with tiers: High ≥ $5,000 / Medium ≥ $1,000 / Watch < $1,000

After this, AI analysis on signals and Daily Board cards shows revenue priority badges automatically.

---

## Roles

Set roles in Supabase → Table Editor → users_profile:

| Role | Can do |
|---|---|
| `owner` / `admin` | Approve/reject everything including final scripts |
| `assistant` | Approve/reject opportunities and briefs; cannot approve scripts |
| `viewer` | Read-only |

---

## For a new year

When the new year's script Google Sheet is ready:
1. Open the new sheet → Extensions → Apps Script → paste `Code.gs` → deploy as Web App
2. Copy the new web app URL
3. Dashboard → Scripts → ⚙ Calendar URL → update the URL → Save

---

## Troubleshooting

- **Login not working**: Check Supabase → Authentication → Providers → Google is on and redirect URI matches
- **SQL errors on migration**: Run schemas in order — schema.sql first, then v2, then seed, then v3, then v4, then v5
- **Repetition check fails**: Make sure the Apps Script URL is set in Supabase → Settings table, key = `calendar_script_url`, value = `{ "url": "https://script.google.com/macros/s/.../exec" }`. Also confirm `CALENDAR_SCRIPT_SECRET` matches `SCRIPT_SECRET` in Apps Script properties.
- **Plant watchlist not showing**: Run schema_v4_migration.sql first, then re-import the CSV/XLSX file
- **Discovery Board empty**: Run schema_v7_migration.sql. Clusters populate as you analyze signals with 🤖
- **Content Review empty**: Clusters need to hit a qualification threshold first (3+ questions, 2+ sources, etc.)
- **Auto-clustering fails silently**: Check Netlify Function logs for `ai-analyze` — verify `CLAUDE_API_KEY` is set
