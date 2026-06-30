/**
 * Netlify Function: submit-signal
 *
 * Accepts a raw signal (e.g. from the Instagram scraper)
 * without requiring a full dashboard login.
 *
 * POST to: /.netlify/functions/submit-signal
 * Header: x-submission-token: <your-token>
 * Body: JSON matching the signals table fields
 */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function hashToken(plain) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── 1. Validate token ────────────────────────────────────────
  const token = event.headers["x-submission-token"] || event.headers["X-Submission-Token"];
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing submission token" }) };
  }

  const tokenHash = hashToken(token);
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("submission_tokens")
    .select("id, label, active, expires_at, allowed_action, rate_limit_per_hour, requests_this_hour, hour_window_start")
    .eq("token_hash", tokenHash)
    .single();

  if (tokenErr || !tokenRow || !tokenRow.active) {
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid or inactive token" }) };
  }
  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    return { statusCode: 401, body: JSON.stringify({ error: "Token has expired" }) };
  }
  if (tokenRow.allowed_action !== "submit_signal") {
    return { statusCode: 403, body: JSON.stringify({ error: "Token not allowed for this action" }) };
  }

  // ── Rate limiting ─────────────────────────────────────────────
  const limit = tokenRow.rate_limit_per_hour ?? 500; // default 500 requests/hour
  const now   = new Date();
  const windowStart = tokenRow.hour_window_start ? new Date(tokenRow.hour_window_start) : null;
  const inSameHour  = windowStart && (now - windowStart) < 3600_000;
  const count       = inSameHour ? (tokenRow.requests_this_hour || 0) : 0;

  if (count >= limit) {
    return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded — try again next hour" }) };
  }

  // Update rate-limit counters (fire-and-forget, non-blocking)
  supabase.from("submission_tokens").update({
    requests_this_hour: count + 1,
    hour_window_start:  inSameHour ? tokenRow.hour_window_start : now.toISOString(),
    last_used_at:       now.toISOString(),
  }).eq("id", tokenRow.id).then(() => {}).catch(() => {});

  // ── 2. Parse body ────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  // Support single signal OR array of signals
  const signals = Array.isArray(body) ? body : [body];

  if (signals.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No signals provided" }) };
  }
  if (signals.length > 200) {
    return { statusCode: 400, body: JSON.stringify({ error: "Maximum 200 signals per request" }) };
  }

  // ── 3. Map to signals table columns ─────────────────────────
  const rows = signals.map((s) => {
    const isManual = s.is_manual ?? s.is_manual_submission ?? false;
    return {
    date_found:            s.date_discovered || s.date_found || new Date().toISOString().slice(0, 10),
    platform:              s.platform || null,
    source_url:            s.source_url || null,
    creator_name:          s.creator || s.creator_name || null,
    topic:                 s.plant_shown || s.topic || null,
    plant_or_product:      s.sb_product || s.plant_or_product || null,
    caption_summary:       s.caption ? s.caption.slice(0, 500) : null,
    metrics_summary:       s.likes !== undefined
                             ? `Likes: ${s.likes}, Comments: ${s.comments}`
                             : s.metrics_summary || null,
    score:                 s.score !== undefined ? Number(s.score) : null,
    priority:              isManual ? "High" : (s.priority || null),
    search_tag:            s.search_tag || null,
    shelf_life:            s.shelf_life || null,
    likes:                 s.likes !== undefined ? Number(s.likes) : null,
    comments_count:        s.comments !== undefined ? Number(s.comments) : null,
    post_date:             s.post_date || null,
    status:                "New",
    // is_manual: true  = intake sheet or dashboard modal (human submitted)
    // is_manual: false = scraper (not passed → defaults false)
    is_manual_submission:  isManual,
    };
  });

  // ── 4. Deduplicate against existing source_urls ──────────────
  const urls = rows.map((r) => r.source_url).filter(Boolean);
  let existingUrls = new Set();
  if (urls.length > 0) {
    const { data: existing } = await supabase
      .from("signals")
      .select("source_url")
      .in("source_url", urls);
    if (existing) existingUrls = new Set(existing.map((r) => r.source_url));
  }

  const newRows = rows.filter((r) => !r.source_url || !existingUrls.has(r.source_url));
  const skipped = rows.length - newRows.length;

  if (newRows.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, inserted: 0, skipped, message: "All signals already exist" }),
    };
  }

  // ── 5. Batch insert ──────────────────────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from("signals").insert(newRows).select("id, topic, platform, source_url, caption_summary, plant_or_product, is_manual_submission, priority");

  if (insertErr) {
    console.error("Insert error:", insertErr);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to insert signals", detail: insertErr.message }) };
  }

  // ── 6. Auto-cluster (fire and forget) ────────────────────────
  // Don't await — clustering runs in background so submit stays fast
  if (inserted?.length && process.env.CLAUDE_API_KEY) {
    const netlifyUrl = process.env.URL || "https://sb-content-intelligence.netlify.app";
    Promise.allSettled(
      inserted.map((sig) =>
        fetch(`${netlifyUrl}/.netlify/functions/ai-analyze`, {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.INTERNAL_SECRET || "",
          },
          body:    JSON.stringify({ type: "cluster", data: sig }),
        })
      )
    ).catch((e) => console.warn("Auto-cluster batch failed:", e.message));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      inserted: newRows.length,
      skipped,
      message: `${newRows.length} signal(s) added, ${skipped} duplicate(s) skipped`,
    }),
  };
};
