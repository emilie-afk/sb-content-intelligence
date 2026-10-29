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
      return row;
    }).filter(r => r.topic || r.source_url || r.caption_summary);
    if (!rows.length) throw new PublicError(400, "Signals need a topic, source URL or caption");

    const sb = serviceClient();

    // ── 4. Deduplicate: within the batch, against old rows by URL, and by key ──
    const unique = [...new Map(rows.map(r => [r.submission_key, r])).values()];
    const urls = unique.map(r => r.source_url).filter(Boolean);
    let existingUrls = new Set();
    if (urls.length) {
      const { data: existing, error } = await sb.from("signals").select("source_url").in("source_url", urls);
      if (error) throw new PublicError(503, "Could not check for duplicates");
      existingUrls = new Set((existing || []).map(r => r.source_url));
    }
    const candidates = unique.filter(r => !r.source_url || !existingUrls.has(r.source_url));

    let inserted = [];
    if (candidates.length) {
      // ON CONFLICT (submission_key) DO NOTHING → retries and concurrent sends are safe
      const { data, error } = await sb.from("signals")
        .upsert(candidates, { onConflict: "submission_key", ignoreDuplicates: true })
        .select("id, is_manual_submission");
      if (error) {
        console.error("submit-signal insert failed:", error.code || "db error");
        throw new PublicError(500, "Failed to save signals. Nothing was saved; it is safe to retry.");
      }
      inserted = data || [];
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
