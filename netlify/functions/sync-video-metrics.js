/**
 * Netlify Function: sync-video-metrics
 *
 * Reads all rows from the "SB Videos" Google Sheet tab, finds rows
 * where metrics + rating are filled but not yet synced to Supabase,
 * matches them to published_videos by post_url, and updates:
 *   - performance_summary
 *   - audience_followup_questions (from comments field if present)
 *   - snapshot_7d_status = 'Done'
 *   - learning_status = 'Ready'
 *
 * Called by GitHub Actions daily cron via x-internal-secret header.
 * Can also be triggered manually from the dashboard.
 *
 * POST (no body required)
 */

const { createClient } = require("@supabase/supabase-js");
const { google }       = require("googleapis");
const { CORS_HEADERS } = require("./_auth");

const SHEET_NAME = "SB Videos";

// Sheet column layout (18 cols, A–R):
//   A  Post URL        B  Platform       C  Published On
//   D  Topic           E  Format
//   F  Day 1 Views     G  Day 2 Views    H  Day 3 Views
//   I  Likes           J  Comments       K  Saves
//   L  Shares          M  Follows        N  Checked On
//   O  Rating          P  What Worked    Q  Improve
//   R  Submitted
const V = {
  POST_URL:     1,  // A
  PLATFORM:     2,  // B
  PUBLISHED_ON: 3,  // C
  TOPIC:        4,  // D
  FORMAT:       5,  // E
  DAY1_VIEWS:   6,  // F
  DAY2_VIEWS:   7,  // G
  DAY3_VIEWS:   8,  // H
  LIKES:        9,  // I
  COMMENTS:     10, // J
  SAVES:        11, // K
  SHARES:       12, // L
  FOLLOWS:      13, // M
  CHECKED_ON:   14, // N
  RATING:       15, // O
  WHAT_WORKED:  16, // P
  IMPROVE:      17, // Q
  SUBMITTED:    18, // R
};

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

  // Allow internal secret (GitHub Actions) or authenticated users
  const internalSecret = event.headers["x-internal-secret"];
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    const { requireUserRole } = require("./_auth");
    const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
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
    // ── 1. Read all rows from the sheet ───────────────────────────────────
    const auth   = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range:         `${SHEET_NAME}!A2:R`,  // skip header row, 18 cols
    });

    const rows = resp.data.values || [];
    if (!rows.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ synced: 0, skipped: 0, message: "No data rows in sheet" }),
      };
    }

    // ── 2. Filter rows that have metrics + rating but aren't synced yet ───
    const toSync = rows
      .map((row, i) => ({
        rowIndex: i + 2, // 1-based, offset by header
        postUrl:     (row[V.POST_URL     - 1] || "").trim(),
        platform:    (row[V.PLATFORM     - 1] || "").trim(),
        publishedOn: (row[V.PUBLISHED_ON - 1] || "").trim(),
        topic:       (row[V.TOPIC        - 1] || "").trim(),
        format:      (row[V.FORMAT       - 1] || "").trim(),
        day1Views:   (row[V.DAY1_VIEWS   - 1] || "").trim(),
        day2Views:   (row[V.DAY2_VIEWS   - 1] || "").trim(),
        day3Views:   (row[V.DAY3_VIEWS   - 1] || "").trim(),
        // "views" alias: use the most recent day with data
        views:       (row[V.DAY3_VIEWS   - 1] || row[V.DAY2_VIEWS - 1] || row[V.DAY1_VIEWS - 1] || "").trim(),
        likes:       (row[V.LIKES        - 1] || "").trim(),
        comments:    (row[V.COMMENTS     - 1] || "").trim(),
        saves:       (row[V.SAVES        - 1] || "").trim(),
        shares:      (row[V.SHARES       - 1] || "").trim(),
        follows:     (row[V.FOLLOWS      - 1] || "").trim(),
        checkedOn:   (row[V.CHECKED_ON   - 1] || "").trim(),
        rating:      (row[V.RATING       - 1] || "").trim(),
        whatWorked:  (row[V.WHAT_WORKED  - 1] || "").trim(),
        improve:     (row[V.IMPROVE      - 1] || "").trim(),
        submitted:   (row[V.SUBMITTED    - 1] || "").trim(),
      }))
      .filter(r =>
        r.postUrl &&   // must have URL to match
        r.views &&     // must have at least one day's views (rating not required — scraper fills views automatically)
        !r.submitted.startsWith("✅ synced") // not already synced to Supabase
      );

    if (!toSync.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ synced: 0, skipped: rows.length, message: "Nothing new to sync" }),
      };
    }

    // ── 3. Fetch all published_videos so we can match by URL ─────────────
    const { data: published } = await supabase
      .from("published_videos")
      .select("id, video_url, cluster_id, topic, plant_or_product, script_output_id");

    const urlMap = new Map((published || []).map(v => [
      (v.video_url || "").trim().replace(/\/$/, ""),
      v,
    ]));

    // ── 4. Sync each row ──────────────────────────────────────────────────
    let synced = 0;
    let notMatched = 0;
    const sheetUpdates = [];

    for (const r of toSync) {
      const normalUrl = r.postUrl.replace(/\/$/, "");
      const video = urlMap.get(normalUrl);

      if (!video) {
        // Row in sheet has no matching published_videos record —
        // insert a new one so it's tracked going forward
        const effectiveRatingIns = r.rating || performanceTier(toInt(r.views));
        const rWithRatingIns = { ...r, rating: effectiveRatingIns };
        const insertRow = {
          video_url:          r.postUrl,
          platform:           r.platform || null,
          publish_datetime:   r.publishedOn || null,
          topic:              r.topic || null,
          performance_summary: buildSummary(rWithRatingIns),
          learning_status:    "Ready",
          snapshot_7d_status: "Submitted",
          ...parseMetrics(r),
        };
        const { data: ins, error: insErr } = await supabase
          .from("published_videos")
          .insert(insertRow)
          .select("id")
          .single();

        if (insErr) console.error("INSERT FAILED:", insErr.message, JSON.stringify(insertRow));

        if (ins) {
          sheetUpdates.push({ rowIndex: r.rowIndex, label: "✅ synced (new)" });
          synced++;
        } else {
          notMatched++;
        }
        continue;
      }

      // Update the existing record
      // Use auto-calculated tier from views if no manual rating is set
      const effectiveRating = r.rating || performanceTier(toInt(r.views));
      const rWithRating = { ...r, rating: effectiveRating };
      const updates = {
        performance_summary:  buildSummary(rWithRating),
        learning_status:      "Ready",
        snapshot_7d_status:   "Done",
        snapshot_24h_status:  video.snapshot_24h_status === "Pending" ? "Submitted" : video.snapshot_24h_status,
        snapshot_72h_status:  video.snapshot_72h_status === "Pending" ? "Submitted" : video.snapshot_72h_status,
        ...parseMetrics(r),
      };

      // Parse comments for follow-up questions if they look like questions
      if (r.comments && r.comments.includes("?")) {
        // Store raw comments field as follow-up question evidence
        updates.audience_followup_questions = [r.comments];
      }

      await supabase.from("published_videos").update(updates).eq("id", video.id);

      // If the cluster is still "Published", leave it — it's done.
      // If there are follow-up questions, bump the cluster back to
      // "Pattern detected" so the AI can suggest a follow-up video.
      if (video.cluster_id && updates.audience_followup_questions?.length) {
        const { data: cluster } = await supabase
          .from("discovery_clusters")
          .select("status")
          .eq("id", video.cluster_id)
          .single();

        if (cluster?.status === "Published") {
          await supabase.from("discovery_clusters").update({
            status:           "Pattern detected",
            reviewer_status:  "Follow-up demand detected",
            new_signals_since_review: 1,
          }).eq("id", video.cluster_id);
        }
      }

      // ── Feed performance back to the originating script ─────────────────
      if (video.script_output_id) {
        const scriptPerf = buildScriptPerformanceNote(rWithRating);
        await supabase.from("script_outputs").update({
          performance_tier: effectiveRating,
          performance_note: scriptPerf,
          measured_at:      new Date().toISOString(),
          review_status:    "Measured",
        }).eq("id", video.script_output_id);
      }

      sheetUpdates.push({ rowIndex: r.rowIndex, label: "✅ synced" });
      synced++;
    }

    // ── 5. Write "✅ synced" back to the SUBMITTED column ────────────────
    if (sheetUpdates.length) {
      const data = sheetUpdates.map(u => [u.label]);
      // Write individually since rows may not be contiguous
      for (const u of sheetUpdates) {
        await sheets.spreadsheets.values.update({
          spreadsheetId:   sheetId,
          range:           `${SHEET_NAME}!R${u.rowIndex}`,
          valueInputOption:"USER_ENTERED",
          resource:        { values: [[u.label]] },
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        synced,
        not_matched: notMatched,
        skipped: rows.length - toSync.length,
        total_rows: rows.length,
      }),
    };

  } catch (err) {
    console.error("sync-video-metrics error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Shared helpers ────────────────────────────────────────────────────────────
function toInt(s) { const n = parseInt((s || "").replace(/,/g, ""), 10); return isNaN(n) ? null : n; }

// ── Determine which day's views are being used ───────────────────────────────
function viewsDay(r) {
  if (r.day3Views) return 3;
  if (r.day2Views) return 2;
  return 1;
}

// ── Parse numeric metrics + compute performance tier ─────────────────────────
function parseMetrics(r) {
  const views = toInt(r.views);
  const day   = viewsDay(r);
  return {
    views_count:      views,
    views_day:        day,
    likes_count:      toInt(r.likes),
    comments_count:   toInt(r.comments),
    saves_count:      toInt(r.saves),
    shares_count:     toInt(r.shares),
    follows_count:    toInt(r.follows),
    performance_tier: performanceTier(views, day),
  };
}

function performanceTier(views, day) {
  if (views === null || views === undefined) return null;
  if (views >= 10000) return "Doing something good!";
  if (day === 1) {
    // Day 1 thresholds
    if (views >= 500)  return "Normal";
    if (views >= 201)  return "Needs huge improvement";
    return "Unacceptable";
  }
  // Day 2 and Day 3+ thresholds
  if (views >= 1000) return "Normal";
  if (views >= 200)  return "Needs huge improvement";
  return "Unacceptable";
}

// ── Build a short performance note written back to the script ────────────────
function buildScriptPerformanceNote(r) {
  const parts = [
    `Result: ${r.rating || "unrated"} — ${r.views ? r.views + " views" : "no view data"}`,
    [
      r.likes    ? `${r.likes} likes`    : null,
      r.saves    ? `${r.saves} saves`    : null,
      r.comments ? `${r.comments} comments` : null,
      r.shares   ? `${r.shares} shares`  : null,
      r.follows  ? `${r.follows} follows` : null,
    ].filter(Boolean).join(", ") || null,
    r.whatWorked ? `What worked: ${r.whatWorked}` : null,
    r.improve    ? `Improve: ${r.improve}` : null,
  ].filter(Boolean).join(" | ");
  return parts;
}

// ── Build a rich performance_summary string the AI can read ──────────────────
function buildSummary(r) {
  const parts = [
    `[VIDEO PERFORMANCE — ${r.rating || "unrated"}]`,
    r.topic       ? `Topic: ${r.topic}`         : null,
    r.format      ? `Format: ${r.format}`        : null,
    r.publishedOn ? `Published: ${r.publishedOn}` : null,
    r.checkedOn   ? `Checked: ${r.checkedOn}`    : null,
    [
      r.views    ? `Views: ${r.views}`       : null,
      r.likes    ? `Likes: ${r.likes}`       : null,
      r.comments ? `Comments: ${r.comments}` : null,
      r.saves    ? `Saves: ${r.saves}`       : null,
      r.shares   ? `Shares: ${r.shares}`     : null,
      r.follows  ? `Follows gained: ${r.follows}` : null,
    ].filter(Boolean).join(" | ") || null,
    r.whatWorked ? `What worked: ${r.whatWorked}` : null,
    r.improve    ? `What to improve: ${r.improve}` : null,
  ].filter(Boolean).join("\n");
  return parts;
}
