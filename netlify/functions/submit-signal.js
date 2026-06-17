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
    .select("id, label, active, expires_at, allowed_action")
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
  const rows = signals.map((s) => ({
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
    priority:              s.priority || null,
    search_tag:            s.search_tag || null,
    shelf_life:            s.shelf_life || null,
    likes:                 s.likes !== undefined ? Number(s.likes) : null,
    comments_count:        s.comments !== undefined ? Number(s.comments) : null,
    post_date:             s.post_date || null,
    status:                "New",
  }));

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
  const { error: insertErr } = await supabase.from("signals").insert(newRows);

  if (insertErr) {
    console.error("Insert error:", insertErr);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to insert signals", detail: insertErr.message }) };
  }

  await supabase
    .from("submission_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

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
