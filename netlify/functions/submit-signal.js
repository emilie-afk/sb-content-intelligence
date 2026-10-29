/**
 * Netlify Function: submit-signal
 *
 * Intake for signals from integrations that don't use a dashboard login:
 * the intake Google Sheet, the video tracker sheet, the Social Submission site
 * and the Instagram scraper.
 *
 * POST /.netlify/functions/submit-signal
 * Header: x-submission-token: <token issued for "submit_signal">
 * Body:   one signal object or an array (max 200)
 *
 * Safe to retry: every row gets a submission key (source URL, or the content of a
 * manual note) and duplicates are skipped instead of inserted twice.
 *
 * Optional `client_submission_id` (UUID) from integrations that retry with their own id
 * (the Social Submission site). It is a second, independent dedup key:
 *   - a row whose id is already stored is acknowledged without inserting;
 *   - `submission_key` dedup (ON CONFLICT DO NOTHING) is unchanged;
 *   - a concurrent insert of the same id is detected by its unique index and re-checked;
 *   - every skipped row is verified to exist before the request is acknowledged.
 * Rows without an id never touch the new column, so older callers work before the
 * migration (20261029_signals_client_submission_id.sql) is applied.
 */
const crypto = require("crypto");
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireSubmissionToken } = require("../lib/tokens");
const { internalHeaders, siteUrl } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");

const MAX_SIGNALS = 200;
const AUTO_CLUSTER_PER_TOKEN_PER_DAY = 300; // beyond this, the daily scheduled batch clusters them

function text(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function url(v) {
  const s = text(v, 2048);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}
function date(v) {
  const s = text(v, 40);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function oneOfOrNull(v, allowed) { return allowed.includes(v) ? v : null; }
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function clientId(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return CLIENT_ID_RE.test(s) ? s : null;
}
// The unique index on client_submission_id (not submission_key) was violated.
function isClientIdConflict(error) {
  if (!error || error.code !== "23505") return false;
  const text = `${error.message || ""} ${error.details || ""}`;
  return text.includes("signals_client_submission_id_key") || /\(client_submission_id\)/.test(text);
}
function chunks(list, size = 50) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
// The new column does not exist yet (migration not applied).
function isMissingColumn(error) {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && /client_submission_id/.test(`${error.message || ""} ${error.details || ""}`);
}

function submissionKey(row) {
  const basis = row.source_url
    ? "url:" + row.source_url.trim().replace(/\/$/, "").toLowerCase()
    : ["note", row.topic, row.creator_name, row.platform, row.date_found, row.is_manual_submission].join("|").toLowerCase();
  return crypto.createHash("sha256").update(basis).digest("hex");
}

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;

    // ── 1. Token (scope + hourly limit, atomically) before anything else ──
    const token = await requireSubmissionToken(event, "submit_signal");

    // ── 2. Parse + validate ─────────────────────────────────────────────
    const body = parseBody(event, { maxBytes: 2 * 1024 * 1024, allowEmpty: false });
    const signals = Array.isArray(body) ? body : [body];
    if (signals.length === 0) throw new PublicError(400, "No signals provided");
    if (signals.length > MAX_SIGNALS) throw new PublicError(400, `Maximum ${MAX_SIGNALS} signals per request`);
    if (signals.some(s => !s || typeof s !== "object" || Array.isArray(s))) throw new PublicError(400, "Each signal must be an object");

    // ── 3. Map to signals table columns (same mapping as before) ────────
    const rows = signals.map((s) => {
      const flag = s.is_manual ?? s.is_manual_submission ?? false;
      const isManual = flag === true || flag === 1 || String(flag).toLowerCase() === "true";
      const likes = num(s.likes), comments = num(s.comments);
      const row = {
        date_found:            date(s.date_discovered) || date(s.date_found) || new Date().toISOString().slice(0, 10),
        platform:              text(s.platform, 50),
        source_url:            url(s.source_url),
        creator_name:          text(s.creator, 200) || text(s.creator_name, 200),
        topic:                 text(s.plant_shown, 2000) || text(s.topic, 2000),
        plant_or_product:      text(s.sb_product, 300) || text(s.plant_or_product, 300),
        caption_summary:       s.caption ? text(s.caption, 500) : null, // (unchanged: only "caption" is read)
        metrics_summary:       s.likes !== undefined ? `Likes: ${s.likes}, Comments: ${s.comments}`.slice(0, 200) : text(s.metrics_summary, 500),
        score:                 num(s.score),
        priority:              isManual ? "High" : oneOfOrNull(s.priority, ["High", "Medium", "Low"]),
        search_tag:            text(s.search_tag, 200),
        shelf_life:            oneOfOrNull(s.shelf_life, ["Trend", "Seasonal", "Evergreen", "Experimental"]),
        likes,
        comments_count:        comments,
        post_date:             date(s.post_date),
        status:                "New",
        // true = intake sheet / Social Submission (human); false = scraper
        is_manual_submission:  isManual,
      };
      row.submission_key = submissionKey(row);
      const cid = clientId(s.client_submission_id);
      if (cid) row.client_submission_id = cid; // only set when provided (see header)
      return row;
    }).filter(r => r.topic || r.source_url || r.caption_summary);
    if (!rows.length) throw new PublicError(400, "Signals need a topic, source URL or caption");

    const sb = serviceClient();

    // ── 4. Deduplicate: within the batch, by client id, against old rows by URL, and by key ──
    // Within the batch: one row per submission_key, and one row per client id.
    // An id must identify exactly one piece of content, and identical content must not carry
    // two different ids: such a batch is ambiguous, so it is refused instead of silently
    // dropping (and still acknowledging) one of the rows. Exact duplicates collapse as before.
    const keyById = new Map(), idByKey = new Map();
    for (const r of rows) {
      if (!r.client_submission_id) continue;
      const k = keyById.get(r.client_submission_id);
      if (k !== undefined && k !== r.submission_key) throw new PublicError(400, "The same client_submission_id was sent with different content");
      keyById.set(r.client_submission_id, r.submission_key);
      const i = idByKey.get(r.submission_key);
      if (i !== undefined && i !== r.client_submission_id) throw new PublicError(400, "The same content was sent with different client_submission_id values");
      idByKey.set(r.submission_key, r.client_submission_id);
    }
    const unique = [...new Map(rows.map(r => [r.submission_key, r])).values()];
    const withIds = unique.filter(r => r.client_submission_id);

    // Ids already stored → acknowledged, not inserted again.
    const storedIds = async (ids) => {
      if (!ids.length) return new Set();
      const found = new Set();
      for (const part of chunks(ids)) { // bounded URL length for .in()
        const { data, error } = await sb.from("signals").select("client_submission_id").in("client_submission_id", part);
        if (error) {
          if (isMissingColumn(error)) throw new PublicError(503, "Signal intake is not ready for submission ids yet. Nothing was saved; it is safe to retry.");
          throw new PublicError(503, "Could not check for duplicates");
        }
        (data || []).forEach(r => found.add(r.client_submission_id));
      }
      return found;
    };
    let alreadyReceived = await storedIds(withIds.map(r => r.client_submission_id));

    const urls = unique.map(r => r.source_url).filter(Boolean);
    let existingUrls = new Set();
    if (urls.length) {
      const { data: existing, error } = await sb.from("signals").select("source_url").in("source_url", urls);
      if (error) throw new PublicError(503, "Could not check for duplicates");
      existingUrls = new Set((existing || []).map(r => r.source_url));
    }
    const pending = () => unique.filter(r =>
      !(r.client_submission_id && alreadyReceived.has(r.client_submission_id)) &&
      !(r.source_url && existingUrls.has(r.source_url)));
    let candidates = pending();

    let inserted = [];
    const insert = (list) => sb.from("signals")
      // ON CONFLICT (submission_key) DO NOTHING → retries and concurrent sends are safe
      .upsert(list, { onConflict: "submission_key", ignoreDuplicates: true })
      .select("id, is_manual_submission, submission_key");
    if (candidates.length) {
      let { data, error } = await insert(candidates);
      if (error && isClientIdConflict(error) && withIds.length) {
        // A concurrent request stored one of these ids first (the whole statement was rolled
        // back). Re-check which ids now exist and insert the rest once more.
        alreadyReceived = await storedIds(withIds.map(r => r.client_submission_id));
        candidates = pending();
        ({ data, error } = candidates.length ? await insert(candidates) : { data: [], error: null });
      }
      if (error) {
        if (isMissingColumn(error)) {
          console.error("submit-signal insert failed: client_submission_id column missing (migration pending)");
          throw new PublicError(503, "Signal intake is not ready for submission ids yet. Nothing was saved; it is safe to retry.");
        }
        console.error("submit-signal insert failed:", error.code || "db error");
        throw new PublicError(500, "Failed to save signals. Nothing was saved; it is safe to retry.");
      }
      inserted = data || [];
    }

    // Verify every candidate that was not inserted (ON CONFLICT on submission_key) really
    // exists before acknowledging it; never report delivery for a row that is not stored.
    const insertedKeys = new Set(inserted.map(r => r.submission_key));
    const notInserted = candidates.filter(r => !insertedKeys.has(r.submission_key)).map(r => r.submission_key);
    if (notInserted.length) {
      const have = new Set();
      let verifyError = null;
      for (const part of chunks(notInserted)) { // bounded URL length for .in()
        const { data: found, error } = await sb.from("signals").select("submission_key").in("submission_key", part);
        if (error) { verifyError = error; break; }
        (found || []).forEach(r => have.add(r.submission_key));
      }
      if (verifyError || notInserted.some(k => !have.has(k))) {
        console.error("submit-signal: skipped rows could not be verified");
        throw new PublicError(500, "Failed to confirm saved signals. It is safe to retry.");
      }
    }
    const skipped = signals.length - inserted.length;

    // ── 5. Auto-cluster the new rows (bounded per token per day) ──────────
    let autoClustered = 0;
    if (inserted.length && process.env.CLAUDE_API_KEY) {
      try {
        const { data: allowed } = await sb.rpc("ci_consume_usage", {
          p_subject: `token:${token.tokenId}`, p_bucket: "auto_cluster",
          p_limit: AUTO_CLUSTER_PER_TOKEN_PER_DAY, p_window_seconds: 86400, p_cost: inserted.length,
        });
        if (allowed === true) autoClustered = await dispatchClustering(sb, inserted.map(r => r.id));
      } catch (e) {
        console.warn("submit-signal: auto-cluster skipped:", e.message); // the daily batch picks them up
      }
    }

    return json(200, {
      success: true,
      inserted: inserted.length,
      skipped,
      // rows that carried an id and were acknowledged without a new insert (all verified)
      already_received: withIds.filter(r => !insertedKeys.has(r.submission_key)).length,
      auto_clustering: autoClustered,
      message: inserted.length
        ? `${inserted.length} signal(s) added, ${skipped} duplicate(s) skipped`
        : "All signals already exist",
    });
  } catch (err) {
    return errorResponse(err, "submit-signal");
  }
};

// Claim each new signal and hand it to the background analysis (202 returns fast).
async function dispatchClustering(sb, ids) {
  const promptsLib = require("../lib/prompts");
  const set = await promptsLib.loadPromptSet(sb);
  const target = `${siteUrl()}/.netlify/functions/cluster-signal-background`;
  const callHeaders = internalHeaders();
  let dispatched = 0;
  await Promise.allSettled(ids.map(async (id) => {
    const claim = crypto.randomUUID();
    const { data: prev } = await sb.rpc("ci_claim_signal", { p_id: id, p_claim: claim, p_expected: null });
    if (!prev) return;
    try {
      const r = await fetch(target, {
        method: "POST", headers: callHeaders,
        body: JSON.stringify({ type: "cluster", data: { id }, claim, prompt_version: set.id }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 202 || r.ok) { dispatched++; return; }
      throw new Error(`HTTP ${r.status}`);
    } catch (_) {
      // put it back in the queue for the scheduled batch
      await sb.from("signals").update({ status: "New" }).eq("id", id).eq("clustering_claim", claim);
    }
  }));
  return dispatched;
}
