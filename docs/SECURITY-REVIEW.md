# Security review — SB Content Intelligence (2026-10-28)

Branch `security-hardening`. Local implementation and verification only: **nothing has
been deployed, no production migration has run, and the live system is not yet secured.**
Rollout, rollback and the history clean-up are in [SECURITY-ROLLOUT.md](SECURITY-ROLLOUT.md).

## 1. Earlier findings — status

| Finding | Still applied? | Fix |
|---|---|---|
| Real sheet + Apps Script URLs in `SETUP.md` | Yes | Removed; placeholders only |
| Sheet URLs and monthly tab ids in `public/index.html` and `supabase/add_app_settings.sql` | Yes (also the Video Tracker sheet link in the page) | Moved to private `ci_integration_config`; links returned only to approved members by `app-config` |
| Supabase URL + publishable key in browser code | Yes | Kept (public by design); protection is RLS |
| `Code.gs` skips the secret check when `SCRIPT_SECRET` is missing (read and write) | Yes | Missing/short secret now denies everything; GET disabled; POST-body secret |
| `schema_v20_rls_authenticated.sql` gives every signed-in account update/delete | Yes — reproduced on a production-shaped database: an **unapproved** account read signals, changed a brand rule and deleted a signal | All policies replaced; file retired |
| `_auth.js` role checks | Partly | Rebuilt as `netlify/lib/auth.js`: approved membership + role + durable limit on every request |

New findings during this review (all fixed locally):

| # | Finding | Severity |
|---|---|---|
| N1 | Any Google/email account in the shared Supabase project was auto-created as `viewer` and, with the old policies, could read all content (and update/delete most tables) | Critical |
| N2 | `scheduled-agent` had no authentication and called `run-agent` with the internal secret → anyone could trigger paid agent runs | High |
| N3 | `generate-learning`, `sync-video-metrics`, `update-sheet-metrics` compared `header !== process.env.INTERNAL_SECRET`: with the variable unset, a request **without** the header passed | High |
| N4 | `write-to-sheet` accepted `Bearer <INTERNAL_SECRET>` (literally `Bearer undefined` when unset) and any valid session, approved or not | High |
| N5 | A real submission token value was committed in `intake-sheet/*.gs`; a token id + hash in `reset-scraper-token.js` (a one-time function never deleted) | High (treat as compromised until checked) |
| N6 | `seed-brand-rules.sql` ("PRIVATE — do not commit") and the full user manual (`update_help_docs_v*.sql`) were committed | Medium |
| N7 | `ai-analyze` used browser-supplied record fields (e.g. topic, `is_manual_submission`) instead of the stored row; `delete_scraper_cleanup` let assistants delete any signals by id | Medium |
| N8 | `javascript:` URLs from imported signals / AI output became clickable links; several AI-produced values were inserted into the page without escaping | Medium |
| N9 | Public GitHub Actions logs printed the agent's full response (internal content summaries) | Medium |
| N10 | Errors returned raw provider / database / Apps Script messages; one log line dumped a whole row | Low |
| N11 | No body-size, batch or id validation; no durable rate limits for user-triggered AI calls; overlapping runs could dispatch the same signal twice | Medium (cost) |
| N12 | `users_profile` allowed `INSERT` of one's own row (with any role) if the sign-up trigger ever failed | Medium |
| N13 | Unpinned `@supabase/supabase-js@2` from a CDN, no SRI; no security headers | Low |
| N14 | Two places fetched the Apps Script URL **without** the secret (worked only while the check was fail-open) | Low |

## 2. Endpoint / caller / permission inventory

Every function authorizes first; nothing touches tables, Google, Apps Script or Claude
before that (proven by the matrix test: 24 endpoint variants × 17 caller types).
"Service" scopes: **scheduler** = `INTERNAL_SECRET` (GitHub Actions), **internal** =
`INTERNAL_FUNCTION_SECRET` (function → function only), **metrics** = `METRICS_INGEST_SECRET`.

| Endpoint | Intended caller | Allowed | Durable limit / lock | Validation |
|---|---|---|---|---|
| `ai-analyze` (analysis, generate/revise brief & script, opportunity) | Dashboard | owner, admin, assistant | `ai` 300/user/day; lock per brief/script/cluster | type allow-list, 256 KB body, ids are UUIDs, stored row used |
| `ai-analyze` `delete_scraper_cleanup` | (unused by UI) | owner, admin | `admin` | ≤500 UUIDs |
| `ai-analyze` `cluster` / `cluster-signal-background` | Dashboard, `batch-cluster`, `submit-signal` | writers; **internal** only for clustering | atomic claim per signal | signal loaded from DB; background must hold the claim |
| `ai-briefing` | Dashboard | writers | `ai_batch` 40/day; single-run lock | type enum, filters clamped; `generated_by` = session user |
| `ai-cleanup-batch` | Dashboard | writers | `ai_batch`; lock | offset/limit bounded, `dry_run` strict |
| `batch-cluster` | GitHub schedule, agent, "Cluster all" | owner, admin, scheduler, internal | `dispatch` 300/day; `FOR UPDATE SKIP LOCKED` claims | — |
| `generate-learning` | Dashboard | owner, admin, scheduler | `ai_batch`; lock; ≤40 videos/run | — |
| `get-sheet-history` | Dashboard | writers | `sheet` 300/day | no URL in response |
| `import-watchlist` | Dashboard | writers (unchanged) | `import` 50/day | 3 MB, ≤20k rows |
| `log-published` | Dashboard | writers | `sheet`; lock per URL | URL/date/ids validated; sheet + DB row created once |
| `maintenance-run` | Dashboard, agent | writers, internal, scheduler | `admin`; lock | limit 1–200 |
| `merge-clusters` | Dashboard | writers | `ai`; lock per pair | UUIDs; prompts loaded before any change |
| `run-agent` | GitHub schedule, dashboard | writers, scheduler, internal | `ai_batch`; one run at a time | run type from credential, not body; tool input validated |
| `scheduled-agent` | optional trigger | scheduler | → run-agent lock | — |
| `scheduled-batch-cluster-background` | optional trigger | scheduler | loop lock | — |
| `sync-video-metrics` | GitHub schedule, dashboard | owner, admin, scheduler | `sheet`; lock | — |
| `update-sheet-metrics` | scheduled metrics task | **metrics** only | lock | ≤200 videos, numbers, URLs, formula-safe |
| `write-to-sheet` | Dashboard (approval) | writers; script must be Approved | `sheet`; lock per script | exactly-once export |
| `submit-signal` | intake sheet, video tracker, Social Submission, scraper | token `submit_signal` | token hourly limit (atomic); auto-cluster ≤300/token/day | ≤200 rows, 2 MB, field lengths; retry-safe |
| `submit-performance` | integrations | token `submit_performance_snapshot` | token hourly limit | numeric fields; idempotent |
| `app-config` GET / POST | Dashboard | GET all approved roles; POST owner, admin | `read` / `admin` | sheet URL format |
| `prompt-versions` | owner/admin tooling | owner, admin | `admin` | complete template set required |
| `push-to-calendar` | removed | nobody (410) | — | — |
| ~~`reset-scraper-token`~~ | one-time function | **deleted** | — | — |

Missing configuration fails closed: no Supabase service key → 503; missing/short/duplicated
service secrets → service calls refused; no Apps Script secret → 503 before calling Google;
no active prompt version → 503 before any model call; `CLAUDE_API_KEY` missing → 503.

## 3. Database inventory (this app's objects)

| Object | Browser (authenticated) | anon |
|---|---|---|
| signals, sources, opportunities, opportunity_sources, briefs, script_outputs, published_videos, learning_memory, discovery_clusters, signal_cluster_links, content_review_candidates | read: approved members · insert/update: owner/admin/assistant · delete: owner/admin (trigger raises a clear error) | none |
| today_board_items, cluster_review_suggestions, competitor_activity, market_watch_plants | read: members · update: writers · delete: admins | none |
| market_watch_signal_links | read: members · delete: admins | none |
| brand_content_rules, plant_watchlist | read: members · write: owner/admin | none |
| settings | read: members · writers only `competitor_blocked_accounts`, other keys owner/admin · constraint forbids source locations | none |
| performance_snapshots, activity_log, cluster_audit_log, discovery_briefings, help_docs | read: members | none |
| users_profile | own row only (to show approval status); **no writes** (trigger also blocks) | none |
| submission_tokens, app_settings, sb_products, agent_run_log, agent_action_log | server only | none |
| ci_integration_config, ci_prompt_versions, ci_usage_counters, ci_locks (new) | server only | none |
| views over these tables | revoked from API roles (reported by the migration) | none |
| storage buckets | none used by this app (inventory lists any) | — |

Row rules (triggers): only owner/admin approve or un-approve scripts and change the text of
an approved script (`approved_by`/`approved_at` set by the database); only owner/admin promote
or edit "Approved rule" learning memories (`reviewed_by` set by the database).
Callable functions: `ci_private.*` helpers (policies only), owner procedures (SQL editor only),
`public.ci_*` RPCs (`service_role` only). `get_user_role()` now returns only an approved role
and is not callable by anon. Legacy trigger functions: execute revoked from API roles.

Other apps in the same project: SB Keyword Intelligence tables (`gsc_uploads`,
`search_queries`, `ad_keywords`, `keyword_projects`, `app_members`, `app_prompt_versions`,
`app_usage_limits`, schema `app_private`) are **not touched**; its code does not use this
app's tables. The Social Submission site (local folder `Intake/netlify-site`) and the
Instagram scraper only call `submit-signal` with a token — no direct table access.

## 4. Exposure inventory and private destination

| Item | Was in | Now |
|---|---|---|
| Script sheet URL + id | SETUP.md, index.html, add_app_settings.sql | `ci_integration_config.script_sheet` (link given to approved members) |
| Monthly tab ids (gids) | index.html, add_app_settings.sql | same row |
| Intake sheet URL | SETUP.md | not needed by the app; removed |
| Video Tracker sheet URL | index.html | env `GOOGLE_VIDEO_TRACKER_ID` (link via `app-config`) |
| Apps Script deployment URL | SETUP.md | `ci_integration_config.script_apps_script` (moved from `settings`) |
| Submission token value / id / hash | intake-sheet/*.gs, reset-scraper-token.js | removed; rotate (see rollout) |
| SB prompts, checklists, agent system prompt (62 templates) | 6 function files | `ci_prompt_versions` (private import) |
| Brand rules seed | supabase/seed-brand-rules.sql | already in `brand_content_rules`; file removed |
| User manual | supabase/update_help_docs_v2–v6.sql, schema_v18 | already in `help_docs`; content removed from repo |
| Agent summaries | public GitHub Actions logs | workflows now print status codes and counts only |
| Owner email | Git commit author metadata (172 commits) | history plan (no code copy) |

Kept public on purpose: generic parsing/validation/workflow code, plant category and
synonym lists, cluster qualification thresholds, agent tool descriptions, the Supabase URL
and publishable key, product catalog seed (public store data).

## 5. Test results (local)

| Suite | Result |
|---|---|
| `npm test` — unit, endpoint matrix, behaviour, Apps Script, exposure | 50/50 passed |
| Prompt equivalence (old inline prompts vs private templates, rich + empty inputs, 40+ cases incl. model calls in generate-learning) | byte-identical |
| `tests/db/run.sh` — real PostgreSQL 16 with a Supabase stand-in (roles anon / authenticated / service_role, `request.jwt.claims`): baseline finding reproduced → migration applied twice → RLS tests as anon, pending (with forged admin claims), revoked, viewer, assistant, admin, owner; revocation with the same token; maintenance; service RPCs; tokens; view closing; config move | passed; fresh install from the repository's SQL + migration also passed |
| `node tests/browser/check.js` — Chromium against the real page + real handlers: signed-out, pending, assistant (intake, dismiss, delete refused, Discovery, Content Review, script generation, approval refused, brand rules refused, help/history), admin (approve + export once, delete), no page errors | 22/22 passed |
| `npm run check` (syntax of all functions/libs/scripts) | passed |

There is no build step (Netlify publishes `public/` and bundles functions); "production
build" = syntax checks + all modules load with esbuild-compatible `require`s.

## 6. Production-only checks (unverified until done)

- Real Supabase Auth/JWT verification, Google OAuth round trip, and PostgREST behaviour
  (tested with a faithful stand-in, not the hosted service).
- That production tables/columns match: four tables exist only in production
  (`today_board_items`, `cluster_audit_log`, `cluster_review_suggestions`, `discovery_briefings`)
  and committed migrations don't apply cleanly on their own (e.g. `maintenance_status`).
  The migration skips missing tables and reports views.
- Which existing accounts are legitimate (pending viewers need an owner decision).
- Whether the committed submission token is still active; current token owners.
- Netlify function env size (< 4 KB total incl. `GOOGLE_SERVICE_ACCOUNT_JSON`), timeouts, Node version.
- Apps Script deployment update; the metrics task (caller of `update-sheet-metrics`) — not found
  in this account's cloud scheduled tasks, probably a local desktop task.
- GitHub fork count / existing clones; Netlify old deploys still reachable.

## 7. Remaining risks and intentional disclosures

- **Approved members receive the sheet links** (Open sheet / Video Tracker) — by design.
  The sheets stay public: anyone who already has a URL can still open them.
- Prompt confidentiality is "not in the repo, not readable by members", not absolute: an
  approved member could coax fragments out through model output.
- A signed-out access token stays valid until expiry (≈1 h) for direct reads; membership and
  revocation are checked on every database query and function call.
- Supabase grants new `public` tables to `anon` by default — re-run `rollout-inventory.sql`
  after any schema change.
- Shared Supabase project: open sign-ups remain (needed by both apps); unapproved accounts get nothing.
- AI-driven automations that existed before (auto-routing signals, cleanup closing clusters,
  scraper "needs catalog review" deletions) are preserved; untrusted text can still influence
  those decisions, never approvals, publishing or permissions.
- Owner-account compromise = full access; use 2-step verification.
