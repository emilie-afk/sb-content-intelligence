/**
 * Netlify Function: push-videos-to-sheet
 *
 * Finds published_videos rows where sheet_logged_at IS NULL,
 * appends each as a new row in the "SB Videos" Google Sheet,
 * then sets sheet_logged_at = NOW() so they aren't re-inserted.
 *
 * Called by:
 *   - savePublishedVideo() in the dashboard immediately on "+ Add Video"
 *   - Daily scheduled task as a safety net
 *   - POST with x-internal-secret header (GitHub Actions / Cowork task)
 */

const { createClient } = require("@supabase/supabase-js");
const { google }       = require("googleapis");
const { requireUserRole, CORS_HEADERS } = require("./_auth");

const SHEET_NAME = "SB Videos";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Accept internal secret (scheduled task) or authenticated admin/owner/assistant
  const internalSecret = event.headers["x-internal-secret"];
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    const authError = await requireUserRole(event, supabase, ["admin", "owner", "assistant"]);
    if (authError) return authError;
  }

  const sheetId        = process.env.GOOGLE_VIDEO_TRACKER_ID;
  const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : null;

  if (!sheetId || !serviceAccount) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "GOOGLE_VIDEO_TRACKER_ID or GOOGLE_SERVICE_ACCOUNT_JSON not configured" }),
    };
  }

  try {
    // ── 1. Find videos not yet logged to the sheet ────────────────────────
    const { data: videos, error: fetchErr } = await supabase
      .from("published_videos")
      .select("id, video_url, platform, publish_datetime, topic, video_title")
      .is("sheet_logged_at", null)
      .order("publish_datetime", { ascending: true })
      .limit(50);

    if (fetchErr) throw fetchErr;
    if (!videos?.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushed: 0, message: "No new videos to log" }),
      };
    }

    // ── 2. Set up Google Sheets client ────────────────────────────────────
    const auth   = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // ── 3. Append each unlogged video as a new sheet row ─────────────────
    let pushed = 0;
    const loggedIds = [];

    for (const v of videos) {
      try {
        // Columns: Post URL | Platform | Published on | Topic | Format | (metrics blank) | Submitted
        const row = new Array(16).fill("");
        row[0]  = v.video_url || "";
        row[1]  = v.platform  || "";
        row[2]  = v.publish_datetime
          ? new Date(v.publish_datetime).toISOString().slice(0, 10)
          : "";
        row[3]  = v.topic || v.video_title || "";
        row[15] = "— add metrics in 5–7 days";   // col P: Submitted to dashboard

        await sheets.spreadsheets.values.append({
          spreadsheetId:   sheetId,
          range:           `${SHEET_NAME}!A:A`,
          valueInputOption:"USER_ENTERED",
          insertDataOption:"INSERT_ROWS",
          resource:        { values: [row] },
        });

        loggedIds.push(v.id);
        pushed++;
      } catch (rowErr) {
        console.warn(`Failed to log video ${v.id}:`, rowErr.message);
      }
    }

    // ── 4. Mark as logged in Supabase ─────────────────────────────────────
    if (loggedIds.length) {
      await supabase
        .from("published_videos")
        .update({ sheet_logged_at: new Date().toISOString() })
        .in("id", loggedIds);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushed, total_found: videos.length }),
    };

  } catch (err) {
    console.error("push-videos-to-sheet error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
