/**
 * Netlify Function: submit-performance
 *
 * Accepts a performance snapshot without a dashboard login.
 *
 * POST /.netlify/functions/submit-performance
 * Header: x-submission-token: <token issued for "submit_performance_snapshot">
 * Body:   { video_url, platform, snapshot_type: 24h|72h|7d|Manual, views, ... }
 *
 * Retries are safe, also when they arrive at the same moment: each snapshot gets an
 * idempotency key enforced by a unique index (INSERT … ON CONFLICT DO NOTHING).
 * Retry identity:
 *   - optional body field "idempotency_key" (recommended for integrations), else
 *   - with snapshot_timestamp: video + type + timestamp
 *   - without it: video + type + views within the same 10-minute UTC window
 *     (a retry that crosses a window boundary is stored as a new observation)
 */
const crypto = require("crypto");
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireSubmissionToken } = require("../lib/tokens");
const { serviceClient } = require("../lib/supabase");
const { str } = require("../lib/validate");

const TYPES = ["24h", "72h", "7d", "Manual"];

function count(v, name) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new PublicError(400, `${name} must be a non-negative number`);
  return Math.round(n);
}
function decimal(v, name) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new PublicError(400, `${name} must be a number`);
  return n;
}

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    const token = await requireSubmissionToken(event, "submit_performance_snapshot");

    const body = parseBody(event, { maxBytes: 32 * 1024, allowEmpty: false });
    for (const field of ["video_url", "platform", "snapshot_type", "views"]) {
      if (body[field] === undefined || body[field] === null) throw new PublicError(400, `Missing required field: ${field}`);
    }
    if (!TYPES.includes(body.snapshot_type)) throw new PublicError(400, `snapshot_type must be one of: ${TYPES.join(", ")}`);
    const videoUrl = str(body.video_url, "video_url", { max: 2048, required: true });
    let snapshotTs = null;
    if (body.snapshot_timestamp) {
      const d = new Date(body.snapshot_timestamp);
      if (isNaN(d)) throw new PublicError(400, "snapshot_timestamp must be a date");
      snapshotTs = d.toISOString();
    }
    const row = {
      platform:               str(body.platform, "platform", { max: 50 }),
      snapshot_type:          body.snapshot_type,
      snapshot_timestamp:     snapshotTs || new Date().toISOString(),
      views:                  count(body.views, "views"),
      likes:                  count(body.likes, "likes"),
      comments:               count(body.comments, "comments"),
      shares:                 count(body.shares, "shares"),
      saves:                  count(body.saves, "saves"),
      follows_gained:         count(body.follows_gained, "follows_gained"),
      profile_visits:         count(body.profile_visits, "profile_visits"),
      link_clicks:            count(body.link_clicks, "link_clicks"),
      average_watch_time:     decimal(body.average_watch_time, "average_watch_time"),
      completion_rate:        decimal(body.completion_rate, "completion_rate"),
      top_audience_questions: str(body.top_audience_questions, "top_audience_questions", { max: 5000 }),
      notable_comment_themes: str(body.notable_comment_themes, "notable_comment_themes", { max: 5000 }),
      submitted_by_label:     token.label,
      submission_token_id:    token.tokenId,
    };

    const sb = serviceClient();
    const { data: video, error: videoErr } = await sb.from("published_videos")
      .select("id").eq("video_url", videoUrl).limit(1).maybeSingle();
    if (videoErr) throw new PublicError(503, "Could not look up the video");
    if (!video) throw new PublicError(404, "Video not found. Add it to Published Results in the dashboard first.");

    // Idempotency: one atomic insert guarded by a unique key
    const basis = body.idempotency_key
      ? `client|${token.tokenId}|${str(body.idempotency_key, "idempotency_key", { max: 200 })}`
      : snapshotTs
        ? `ts|${video.id}|${row.snapshot_type}|${snapshotTs}`
        : `win|${video.id}|${row.snapshot_type}|${row.views}|${Math.floor(Date.now() / 600000)}`;
    const idempotency_key = crypto.createHash("sha256").update(basis).digest("hex");
    const { data: inserted, error: insertErr } = await sb.from("performance_snapshots")
      .upsert({ published_video_id: video.id, ...row, idempotency_key }, { onConflict: "idempotency_key", ignoreDuplicates: true })
      .select("id");
    if (insertErr) {
      console.error("submit-performance insert failed:", insertErr.code || "db error");
      throw new PublicError(500, "Failed to save snapshot");
    }
    if (!inserted || inserted.length === 0) {
      return json(200, { success: true, duplicate: true, message: "Snapshot already recorded" });
    }

    const statusField = { "24h": "snapshot_24h_status", "72h": "snapshot_72h_status", "7d": "snapshot_7d_status" }[row.snapshot_type];
    if (statusField) await sb.from("published_videos").update({ [statusField]: "Submitted" }).eq("id", video.id);

    return json(200, {
      success: true,
      message: `${row.snapshot_type} snapshot recorded`,
      submitted_by: token.label,
    });
  } catch (err) {
    return errorResponse(err, "submit-performance");
  }
};
