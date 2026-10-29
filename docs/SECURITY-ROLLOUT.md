# Security rollout — SB Content Intelligence

Status: **prepared, not applied.** Every production step below needs the owner's approval.
Values in `<ANGLE_BRACKETS>` are placeholders: type real values only into Netlify, GitHub
secrets, Apps Script properties or the Supabase SQL editor — never into files, chats or
saved SQL snippets.

## A. What changes in production

| Area | Before | After |
|---|---|---|
| Who gets data | any signed-in account (auto-created `viewer`) | approved members only; new sign-ins are *pending* |
| Database | `USING (true)` update/delete for every signed-in user | per-role policies; anon has no privileges; deletes owner/admin |
| Functions | several open or fail-open | every endpoint authorizes first; scoped service secrets; durable limits/locks |
| Sheets / Apps Script | URLs in public code; secret optional | private config; secret required; POST only; retry-safe export (reservation ledger) |
| Runtime | Node 18 | Node 22 (required by the locked Supabase client) |
| Prompts | in public source | private, versioned rows in `ci_prompt_versions` |

## B. Rollout sequence (≈45 min window)

### 1. Back up and record (read-only)
1. SQL editor → run `supabase/rollout-inventory.sql`; save the results privately ("before").
2. Table editor → export CSV of: signals, discovery_clusters, signal_cluster_links,
   content_review_candidates, opportunities, briefs, script_outputs, published_videos,
   performance_snapshots, learning_memory, brand_content_rules, plant_watchlist, settings,
   app_settings, users_profile, submission_tokens, help_docs, today_board_items,
   cluster_review_suggestions, cluster_audit_log, discovery_briefings. Keep them off GitHub.
3. Apps Script: copy the current code of the script-sheet project and note the active
   deployment version (Deploy → Manage deployments).
4. Note the Netlify env var names in use and the GitHub Actions secret names.

### 2. Identify the owner and the team (private)
```sql
select id, email, role, active from users_profile order by role, email;
```
Confirm with the owner which accounts are staff and which role each keeps. Do not infer
ownership from display names or GitHub usernames.

### 3. Prepare configuration (no effect on the live app yet)
- Runtime: the branch sets `NODE_VERSION = "22"` (build). Also add the Netlify env var
  `AWS_LAMBDA_JS_RUNTIME = nodejs22.x` (Functions scope) so functions run on Node 22, not only
  the build. On older runtimes the functions refuse with 503 instead of crashing.
- Netlify env (Functions scope): add `INTERNAL_FUNCTION_SECRET` and `METRICS_INGEST_SECRET`
  (32+ random chars each, all distinct); make sure `CALENDAR_SCRIPT_SECRET` is set (32+ chars).
  Leave `INTERNAL_SECRET` as is (GitHub uses it). Leave `ALLOWED_ORIGIN` unset.
- Private prompt set: the file `sb-content-prompts.private.json` (delivered privately, not in Git).
- Prepare new submission tokens (step 6) for: intake sheet, video tracker, Social Submission
  site, Instagram scraper, CSV submit script.

### 4. Start the window — handle in-flight work
1. Tell the team; GitHub → Actions → disable the three daily workflows.
2. Wait for running work to finish:
   ```sql
   select status, count(*) from signals where status in ('New','Clustering') group by 1;
   select id, status, started_at from agent_run_log where status = 'running';
   ```
   Background clustering finishes within 15 minutes; anything still `Clustering` later is
   returned to `New` automatically by the next batch run (nothing is lost).

### 5. Apply the migration and set up access (SQL editor)
1. Paste and run `supabase/migrations/20261028_ci_access_control.sql`. Note any
   `ci: view … closed to the API` notices.
2. Owner and team (one statement each; values typed here only):
   ```sql
   select ci_private.bootstrap_owner('<OWNER_EMAIL>');
   select ci_private.approve_member('<TEAM_EMAIL>', 'assistant');   -- or 'admin' / 'viewer'
   select * from ci_private.list_members();      -- remaining 'pending' rows: approve or leave
   select ci_private.revoke_member('<EMAIL>');   -- any unexpected admin/assistant
   ```
   The migration keeps existing owner/admin/assistant rows approved and makes automatically
   created `viewer` rows pending.
3. Prompts — either:
   - SQL editor (dollar quotes, because prompts contain apostrophes): `select ci_create_prompt_version('content', $p$<contents of sb-content-prompts.private.json>$p$::jsonb, 'initial import', 'owner', true);`
   - or trusted machine: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-prompts.js <path>/sb-content-prompts.private.json --activate --note "initial import"`
   Check: `select id, version, is_active from ci_prompt_versions;`
4. Integration config — check the moved rows: `select key from ci_integration_config;`
   expect `script_apps_script` (from `settings.calendar_script_url`) and `script_sheet`
   (from `app_settings`). If either is missing, insert it as in SETUP.md.
5. Re-run `rollout-inventory.sql` ("after"): no non-`ci_` policies on app tables, anon has no
   privileges, views closed, row counts unchanged (settings/app_settings −1 each if moved).

### 6. Rotate submission tokens (approval required: revokes integrations)
```sql
select ci_private.create_submission_token('intake sheet', 'submit_signal');        -- shown once
select ci_private.create_submission_token('video tracker', 'submit_signal');
select ci_private.create_submission_token('social submission site', 'submit_signal');
select ci_private.create_submission_token('instagram scraper', 'submit_signal');
```
Put each value into its integration (Apps Script → Script Properties `SUBMIT_TOKEN`; Social
Submission Netlify env `SUBMIT_TOKEN`; scraper config), test one submission each, then revoke
the old tokens: `select id, label, last_used_at from submission_tokens;` →
`select ci_private.revoke_submission_token('<TOKEN_ID>');`. Check whether the value that was
committed to GitHub is still active (compare its SHA-256 with `token_hash`); if so, revoke it.

### 7. Deploy Netlify
Merge `security-hardening` into `main` (Netlify builds). Keep the window open.

### 8. Update the Apps Script deployment (approval required)
Script sheet → Extensions → Apps Script → replace `Code.gs` with `calendar-apps-script/Code.gs`
→ Project Settings → Script Properties: `SCRIPT_SECRET` = the `CALENDAR_SCRIPT_SECRET` value →
Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The URL stays the same.
(Until this step, repetition history returns nothing; export keeps working.)

### 9. Verify
- Runtime: Netlify → Logs → Functions → any function: the runtime shows Node.js 22 and no
  "Server runtime is misconfigured" message.
- Owner signs in → dashboard. A team member signs in → their role. An unapproved Google
  account → "Waiting for approval".
- Anonymous checks (should be refused):
  `curl "https://<project-ref>.supabase.co/rest/v1/signals?select=id" -H "apikey: <PUBLISHABLE_KEY>"` → 401/403
  `curl -X POST https://<site>/.netlify/functions/ai-analyze -d '{}'` → 401
  `curl -X POST https://<site>/.netlify/functions/scheduled-agent` → 401
  `curl -X POST https://<site>/.netlify/functions/update-sheet-metrics -d '{}'` → 401
- Workflows: Inbox, Discovery, Content Review, generate a brief and a script, Rep. Check
  (sheet history entries appear), approve one real script → one row in the month tab;
  click 📊 again → "already exported", no second row; Published, Learning, Brand Rules,
  Watchlist, Activity Log, Help.
- Intake sheet row → appears in Inbox; Social Submission test → appears; scraper run → counts.
- GitHub → Actions → run each workflow manually (workflow_dispatch): HTTP 200.
- The metrics task: update it to send `x-internal-secret: <METRICS_INGEST_SECRET>`; one run.

### 10. Finish
Re-enable the GitHub workflows, end the window. Optional clean-up afterwards: delete
`SCRIPT_SHEET_HOOK_URL` / `SCRIPT_SHEET_TOKEN` from Netlify once `script_apps_script` and
`CALENDAR_SCRIPT_SECRET` are confirmed.

## C. Rollback (data-preserving; never reopens access)

- **The migration changes no content rows.** Moved config rows stay in `ci_integration_config`.
- **Something is wrong and the team must be kept out:** `select ci_private.set_maintenance(true);`
  (all browser and service access to app data stops), fix, then `set_maintenance(false)`.
- **A legitimate person is blocked:** fix membership/role with `ci_private.approve_member`; if a
  workflow genuinely needs more access, add a role-specific policy. Do **not** re-run
  `schema_v20_*` or add `using (true)` policies.
- **Function bug after deploy:** fix forward on the branch. Do not republish the previous
  deploy: the old functions contain the fail-open checks (N2–N4). If you must, turn on
  maintenance first and Netlify password protection.
- **Apps Script problem:** Manage deployments → edit → choose the previous version. With
  `SCRIPT_SECRET` set, the old version still checks the secret; history will be empty, export works.
- **Bad prompt version:** `select ci_activate_prompt_version(<PREVIOUS_ID>);` (versions are immutable).
- **Owner locked out:** `select ci_private.bootstrap_owner('<OWNER_EMAIL>');`
- **Token problem:** create a new token and update the integration; old tokens can be
  re-enabled (`update submission_tokens set active = true where id = '<ID>'`) only if they
  were never exposed.

## D. Companion changes in connected apps (not made here)

| App | Change | When |
|---|---|---|
| Social Submission site (`Intake/netlify-site`) | new `SUBMIT_TOKEN` env value; no code change (`is_manual` still honoured) | step 6 |
| Instagram scraper / `submit_csv.py` | new token (the CSV script has a token in its source — move it to an env var or delete the script) | step 6 |
| Intake sheet / video tracker Apps Scripts | new `SUBMIT_TOKEN` Script Property (code comments updated; no logic change) | step 6 |
| Metrics task calling `update-sheet-metrics` | send `METRICS_INGEST_SECRET` instead of `INTERNAL_SECRET` | step 9 |
| GitHub Actions | no secret change; workflows now print only status codes | merge |
| SB Keyword Intelligence | none (separate tables; Google provider / redirect URLs unchanged) | — |

## E. Git history and other copies — separate clean-up plan (needs approval)

Still public in history / elsewhere: sheet URLs + ids and tab ids (since 2026-06-30), the
Apps Script deployment URL, the committed submission token (since 2026-06-17) and token
hash/id, all SB prompts (since 2026-06-17), the brand-rules seed (since 2026-06-22), the user
manual (since 2026-07-06), the owner email in commit metadata, agent summaries in public
GitHub Actions logs, and old Netlify deploys containing the same page.

1. **Rotate first** (independent of history): submission tokens (step 6). Optionally create a
   new Apps Script deployment (new URL) and retire the old one — approval required; the
   sheets themselves stay public by decision.
2. **Assume prompts, brand rules and the manual are known.** Revise them if needed by
   importing a new prompt version.
3. **GitHub Actions logs:** delete old runs of "Daily Agent Triage" (`gh run list` / `gh run delete`).
4. **Old Netlify deploys:** delete superseded deploys so old bundles stop being served.
5. **Git history (optional):** `git filter-repo` to drop `supabase/seed-brand-rules.sql`,
   `supabase/update_help_docs_v*.sql`, `netlify/functions/reset-scraper-token.js` and to
   replace the sheet/Apps Script ids, token value and prompt text with placeholders; force-push;
   ask GitHub Support to purge cached views; everyone re-clones. Forks and existing clones
   keep the old history — it cannot be recalled.
6. **Commit email:** enable GitHub "Keep my email address private" and use the noreply
   address for future commits.
