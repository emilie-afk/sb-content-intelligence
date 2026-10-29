/**
 * Netlify Function: log-published
 *
 * Called when a video is marked as published in the dashboard.
 * Writes a pre-filled row to the Video Tracker Google Sheet, creates the
 * published_videos record, links the script and closes the opportunity/cluster.
 *
 * POST body: { opportunityId?, clusterId?, postUrl, platform?, publishedOn?, topic?, format? }
 * Auth: approved owner / admin / assistant session.
 *
 * Retry-safe: the sheet row and the published_videos record are only created when
 * the post URL isn't already there, under a per-URL lock.
 */
const crypto = require("crypto");
const { google } = require("googleapis");
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireUser, ROLES } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");
const { withLock } = require("../lib/locks");
const { optionalUuid, str, sheetSafe } = require("../lib/validate");

const SHEET_NAME = "SB Videos";
// 18-column layout: A Post URL · B Platform · C Published On · D Topic · E Format ·
// F–Q metrics/review (filled later) · R Submitted
const V = { POST_URL: 1, PLATFORM: 2, PUBLISHED_ON: 3, TOPIC: 4, FORMAT: 5, SUBMITTED: 18 };

const norm = (u) => String(u || "").trim().replace(/\/$/, "");

function sheetsClient() {
  const sheetId = process.env.GOOGLE_VIDEO_TRACKER_ID;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sheetId || !raw) return null;
  let credentials;
  try { credentials = JSON.parse(raw); } catch { throw new PublicError(503, "Video tracker credentials are misconfigured"); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return { sheetId, sheets: google.sheets({ version: "v4", auth }) };
}

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    await requireUser(event, { roles: ROLES.WRITERS, bucket: "sheet" });

    const body = parseBody(event, { maxBytes: 16 * 1024, allowEmpty: false });
    const postUrl = norm(str(body.postUrl, "postUrl", { max: 2048, required: true }));
    if (!/^https?:\/\//i.test(postUrl)) throw new PublicError(400, "Post URL must start with http:// or https://");
    const opportunityId = optionalUuid(body.opportunityId, "opportunityId");
    const clusterId     = optionalUuid(body.clusterId, "clusterId");
    const platform      = str(body.platform, "platform", { max: 50 });
    const topic         = str(body.topic, "topic", { max: 500 });
    const format        = str(body.format, "format", { max: 100 });
    const publishedOn   = body.publishedOn ? str(body.publishedOn, "publishedOn", { max: 10 }) : null;
    if (publishedOn && !/^\d{4}-\d{2}-\d{2}$/.test(publishedOn)) throw new PublicError(400, "publishedOn must be YYYY-MM-DD");

    const sb = serviceClient();
    const lockKey = "log_published:" + crypto.createHash("sha256").update(postUrl.toLowerCase()).digest("hex").slice(0, 32);

    return await withLock(lockKey, 120, async () => {
      const errors = [];

      // ── 1. Video Tracker sheet row (only if the URL isn't in column A yet) ──
      try {
        const client = sheetsClient();
        if (!client) {
          errors.push("Video tracker sheet is not configured on the server");
        } else {
          const existing = await client.sheets.spreadsheets.values.get({ spreadsheetId: client.sheetId, range: `${SHEET_NAME}!A2:A` });
          const urls = new Set((existing.data.values || []).map(r => norm(r[0])));
          if (!urls.has(postUrl)) {
            const row = new Array(18).fill("");
            row[V.POST_URL - 1]     = sheetSafe(postUrl);
            row[V.PLATFORM - 1]     = sheetSafe(platform || "");
            row[V.PUBLISHED_ON - 1] = publishedOn || new Date().toISOString().slice(0, 10);
            row[V.TOPIC - 1]        = sheetSafe(topic || "");
            row[V.FORMAT - 1]       = sheetSafe(format || "");
            row[V.SUBMITTED - 1]    = "— metrics auto-synced daily";
            await client.sheets.spreadsheets.values.append({
              spreadsheetId: client.sheetId, range: `${SHEET_NAME}!A:A`,
              valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
              resource: { values: [row] },
            });
          }
        }
      } catch (sheetErr) {
        console.warn("log-published: sheet write failed:", sheetErr.isPublic ? sheetErr.message : "google api error");
        errors.push(sheetErr.isPublic ? sheetErr.message : "Could not write to the video tracker sheet");
      }

      // ── 2. published_videos record (reuse an existing one for the same URL) ──
      let publishedVideoId = null;
      let briefId = null;
      if (opportunityId) {
        const { data: opp } = await sb.from("opportunities").select("brief_id").eq("id", opportunityId).maybeSingle();
        briefId = opp?.brief_id || null;
      }
      const { data: found } = await sb.from("published_videos").select("id")
        .in("video_url", [postUrl, postUrl + "/"]).limit(1);
      if (found && found.length) {
        publishedVideoId = found[0].id;
      } else {
        const { data: pubVideo, error: pubErr } = await sb.from("published_videos").insert({
          video_url:        postUrl,
          platform:         platform || null,
          topic:            topic || null,
          publish_datetime: publishedOn ? new Date(publishedOn + "T00:00:00").toISOString() : new Date().toISOString(),
          cluster_id:       clusterId,
          brief_id:         briefId,
        }).select("id").single();
        if (pubErr) {
          console.warn("log-published: insert failed:", pubErr.code || "db error");
          errors.push("Could not create the published video record");
        } else {
          publishedVideoId = pubVideo.id;
        }
      }

      // ── 3. Link the script used (opportunity → brief → script) ──────────────
      if (publishedVideoId && briefId) {
        try {
          const { data: scripts } = await sb.from("script_outputs").select("id")
            .eq("brief_id", briefId)
            .in("review_status", ["Approved", "Used in production", "Draft"])
            .order("updated_at", { ascending: false }).limit(1);
          if (scripts?.[0]) {
            await sb.from("script_outputs").update({ review_status: "Used in production" }).eq("id", scripts[0].id);
            await sb.from("published_videos").update({ script_output_id: scripts[0].id }).eq("id", publishedVideoId);
          }
        } catch (_) { console.warn("log-published: script link failed (non-fatal)"); }
      }

      // ── 4. Mark opportunity Published + close cluster ────────────────────────
      if (opportunityId) {
        const { error } = await sb.from("opportunities").update({ reviewer_decision: "Published", reviewed_at: new Date().toISOString() }).eq("id", opportunityId);
        if (error) errors.push("Could not update the opportunity");
      }
      if (clusterId) {
        const { error } = await sb.from("discovery_clusters").update({ status: "Published", reviewer_status: "Published" }).eq("id", clusterId);
        if (error) errors.push("Could not update the cluster");
      }

      return json(200, { success: errors.length === 0, errors: errors.length ? errors : undefined });
    }, "This video is already being logged.");
  } catch (err) {
    return errorResponse(err, "log-published");
  }
};
