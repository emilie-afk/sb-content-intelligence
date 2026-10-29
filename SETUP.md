# SB Content Intelligence — Setup Guide
## Social Listening + Script Production

This repository is **public**. It contains code only. Sheet locations, Apps Script
deployment URLs, credentials, member lists, prompts, brand rules and the user manual
live in private configuration (Netlify environment variables and protected Supabase
tables). Security model, rollout and rollback: [docs/SECURITY-ROLLOUT.md](docs/SECURITY-ROLLOUT.md).
Inventories and test results: [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

---

## Components

| Part | Where | Notes |
|---|---|---|
| Dashboard page | `public/index.html` (Netlify) | Signs in with Google through Supabase Auth |
| Server functions | `netlify/functions/*` + shared `netlify/lib/*` | Every endpoint checks its caller first |
| Database | Supabase project (shared with SB Keyword Intelligence) | Row-level security: approved members only |
| Daily schedules | `.github/workflows/*` (GitHub Actions) | Use the `INTERNAL_SECRET` repository secret |
| Script sheet export + history | `calendar-apps-script/Code.gs` (Apps Script web app) | Requires `SCRIPT_SECRET` |
| Intake sheet / video tracker | `intake-sheet/*.gs` | Use a submission token in Script Properties |
| Social Submission site, Instagram scraper | separate code (not in this repo) | Call `submit-signal` with a submission token |

## Access and roles

Signing in is not enough: an owner must **approve** each account. New Google sign-ins
appear as *pending* and see a "Waiting for approval" screen.

| Role | Can do |
|---|---|
| `owner` / `admin` | Everything, including approving final scripts and learning rules, deleting, brand rules, plant watchlist, prompt versions, sheet link |
| `assistant` | Intake, clustering review, briefs, script drafts, publishing log; cannot approve scripts or learning rules, delete, or change brand rules |
| `viewer` | Read-only |

Membership is managed by the owner in the Supabase SQL editor (never through the app):

```sql
select * from ci_private.list_members();                       -- who is pending / approved
select ci_private.approve_member('<EMAIL>', 'assistant');      -- approve with a role
select ci_private.revoke_member('<EMAIL>');                    -- remove access (next request)
```

## Environment variables (Netlify → Site configuration → Environment variables)

| Name | Scope | Purpose |
|---|---|---|
| `SUPABASE_URL` | Functions | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Functions | server-only key — never a browser variable |
| `CLAUDE_API_KEY` | Functions | AI calls |
| `INTERNAL_SECRET` | Functions | scheduler credential (same value as the GitHub Actions secret) |
| `INTERNAL_FUNCTION_SECRET` | Functions | function-to-function calls only; never shared outside Netlify |
| `METRICS_INGEST_SECRET` | Functions | the scheduled metrics task that calls `update-sheet-metrics` |
| `CALENDAR_SCRIPT_SECRET` | Functions | equals `SCRIPT_SECRET` in the Apps Script project |
| `GOOGLE_VIDEO_TRACKER_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Functions | Video Tracker sheet (Sheets API) |

All secrets: 32+ random characters, all different from each other (the functions refuse
service calls when two scoped secrets share a value). Generate with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Fresh database install

Run `supabase/schema.sql`, the `schema_v*` and other files in `supabase/` (order: see
`tests/db/load_baseline.sh`), then `supabase/migrations/20261028_ci_access_control.sql`, then
`supabase/migrations/20261029_signals_client_submission_id.sql` (in that order).
Until that migration runs, tables have row-level security with no policies (closed).

## Private configuration (SQL editor, values are placeholders)

```sql
-- Apps Script web app used for export + repetition history
insert into ci_integration_config (key, value) values ('script_apps_script', '{"url":"<APPS_SCRIPT_EXEC_URL>"}')
  on conflict (key) do update set value = excluded.value, updated_at = now();
-- "Open sheet" link and monthly tab ids (approved members receive these links)
insert into ci_integration_config (key, value) values
  ('script_sheet', '{"base_url":{"<YEAR>":"https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit"},"gids":{"<YEAR>":{"1":<GID_JAN>}}}')
  on conflict (key) do update set value = excluded.value, updated_at = now();
-- submission token for an integration: the raw value is shown ONCE — paste it into that
-- integration's settings, never into a file
select ci_private.create_submission_token('<label>', 'submit_signal');
```

## For a new year

1. Open the new script sheet → Extensions → Apps Script → paste `calendar-apps-script/Code.gs`.
2. Project Settings → Script Properties → `SCRIPT_SECRET` = the `CALENDAR_SCRIPT_SECRET` value.
3. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
4. Update `script_apps_script` and `script_sheet` with the SQL above (an owner/admin can also
   change the sheet link from Scripts → ⚙ in the dashboard).

## Troubleshooting

- **"Waiting for approval"** — the owner has not approved the account yet (see Access).
- **"Prompt configuration is missing"** — no active prompt version; see docs/SECURITY-ROLLOUT.md (prompts).
- **Repetition check shows no sheet history** — check `CALENDAR_SCRIPT_SECRET` equals the Apps Script
  `SCRIPT_SECRET`, and the `script_apps_script` row.
- **Intake rows show "❌ Invalid or inactive token"** — the integration's token was revoked or mistyped.
- **Daily workflow fails with 401** — `INTERNAL_SECRET` differs between GitHub and Netlify.
- **Plant watchlist import** — Dashboard → Plant Watchlist → choose the revenue-by-genus CSV/XLSX → Import.
