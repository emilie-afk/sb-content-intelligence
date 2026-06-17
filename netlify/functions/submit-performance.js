/**
 * Netlify Function: submit-performance
 *
 * Accepts a performance snapshot from Claude or the team
 * without requiring a full dashboard login.
 *
 * POST to: /.netlify/functions/submit-performance
 * Header: x-submission-token: <your-token>
 * Body: JSON with snapshot fields
 */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// Supabase admin client — uses SERVICE ROLE key (server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Hash a plain token the same way we stored it
function hashToken(plain) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── 1. Validate submission token ─────────────────────────────
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

  if (tokenErr || !tokenRow) {
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };
  }
  if (!tokenRow.active) {
    return { statusCode: 401, body: JSON.stringify({ error: "Token is inactive" }) };
  }
  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    return { statusCode: 401, body: JSON.stringify({ error: "Token has expired" }) };
  }
  if (tokenRow.allowed_action !== "submit_performance_snapshot") {
    return { statusCode: 403, body: JSON.stringify({ error: "Token not allowed for this action" }) };
  }

  // ── 2. Parse and validate body ───────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const required = ["video_url", "platform", "snapshot_type", "views"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${field}` }) };
    }
  }

  const validTypes = ["24h", "72h", "7d", "Manual"];
  if (!validTypes.includes(body.snapshot_type)) {
    return { statusCode: 400, body: JSON.stringify({ error: `snapshot_type must be one of: ${validTypes.join(", ")}` }) };
  }

  // ── 3. Look up the published video by URL ────────────────────
  const { data: video, error: videoErr } = await supabase
    .from("published_videos")
    .select("id, snapshot_24h_status, snapshot_72h_status, snapshot_7d_status")
    .eq("video_url", body.video_url)
    .single();

  if (videoErr || !video) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: "Video not found. Add it to Published Results in the dashboard first.",
        video_url: body.video_url
      })
    };
  }

  // ── 4. Insert the performance snapshot ───────────────────────
  const { error: insertErr } = await supabase
    .from("performance_snapshots")
    .insert({
      published_video_id:     video.id,
      platform:               body.platform,
      snapshot_type:          body.snapshot_type,
      snapshot_timestamp:     body.snapshot_timestamp || new Date().toISOString(),
      views:                  Number(body.views) || 0,
      likes:                  Number(body.likes) || 0,
      comments:               Number(body.comments) || 0,
      shares:                 Number(body.shares) || 0,
      saves:                  Number(body.saves) || 0,
      follows_gained:         Number(body.follows_gained) || 0,
      profile_visits:         Number(body.profile_visits) || 0,
      link_clicks:            Number(body.link_clicks) || 0,
      average_watch_time:     body.average_watch_time ? Number(body.average_watch_time) : null,
      completion_rate:        body.completion_rate ? Number(body.completion_rate) : null,
      top_audience_questions: body.top_audience_questions || null,
      notable_comment_themes: body.notable_comment_themes || null,
      submitted_by_label:     tokenRow.label,
      submission_token_id:    tokenRow.id,
    });

  if (insertErr) {
    console.error("Insert error:", insertErr);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to save snapshot", detail: insertErr.message }) };
  }

  // ── 5. Update checkpoint status on the video ─────────────────
  const statusField = {
    "24h": "snapshot_24h_status",
    "72h": "snapshot_72h_status",
    "7d":  "snapshot_7d_status",
  }[body.snapshot_type];

  if (statusField) {
    await supabase
      .from("published_videos")
      .update({ [statusField]: "Submitted" })
      .eq("id", video.id);
  }

  // ── 6. Update token last_used_at ─────────────────────────────
  await supabase
    .from("submission_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: `${body.snapshot_type} snapshot recorded for "${body.video_url}"`,
      submitted_by: tokenRow.label,
    }),
  };
};
