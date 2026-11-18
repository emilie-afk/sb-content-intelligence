/**
 * Netlify Function: update-sheet-metrics
 *
 * Receives scraped video metrics from the daily Cowork task and writes
 * them to the correct Day 1 / Day 2 / Day 3 Views column in the
 * "SB Videos" Google Sheet, based on how many days have passed since
 * the video was published.
 *
 * If the video URL is not yet in the sheet, inserts a new row.
 *
 * POST body:
 * {
 *   videos: [{
 *     url:         string,           // full post URL
 *     platform:    "instagram" | "tiktok",
 *     publishedOn: string,           // YYYY-MM-DD
 *     caption:     string,
 *     views:       number | null,
 *     likes:       number | null,
 *     comments:    number | null,
 *     saves:       number | null,
 *     shares:      number | null,
 *   }]
 * }
 *
 * Called via x-internal-secret header (Cowork scheduled task).
 *
 * Sheet column layout (18 cols, A–R):
 *   A  Post URL        B  Platform       C  Published On
 *   D  Topic           E  Format
 *   F  Day 1 Views     G  Day 2 Views    H  Day 3 Views
 *   I  Likes           J  Comments       K  Saves
 *   L  Shares          M  Follows        N  Checked On
 *   O  Rating          P  What Worked    Q  Improve
 *   R  Submitted
 */

const { google } = require("googleapis");
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireService } = require("../lib/auth");
const locks = require("../lib/locks");
const { sheetSafe } = require("../lib/validate");

const MAX_VIDEOS = 200;
function metric(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n) : null;
}

const SHEET_NAME = "SB Videos";

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

exports.handler = async (event) => {
  let lockHolder = null;
  try {
  const early = preflightOrMethod(event, ["POST"]);
  if (early) return early;
  // Only the metrics-ingest credential (scheduled scraper task). Not a user endpoint.
  await requireService(event, ["metrics"]);

  const sheetId        = process.env.GOOGLE_VIDEO_TRACKER_ID;
  let serviceAccount = null;
  try {
    serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
  } catch { throw new PublicError(503, "Video tracker credentials are misconfigured"); }
  if (!sheetId || !serviceAccount) throw new PublicError(503, "Google Sheet credentials not configured");

  const body = parseBody(event, { maxBytes: 512 * 1024 });
  const rawVideos = Array.isArray(body.videos) ? body.videos : [];
  if (rawVideos.length > MAX_VIDEOS) throw new PublicError(400, `Maximum ${MAX_VIDEOS} videos per request`);
  const videos = rawVideos
    .filter(v => v && typeof v === "object")
    .map(v => ({
      url:         String(v.url || "").trim().slice(0, 2048),
      platform:    String(v.platform || "").slice(0, 30),
      publishedOn: /^\d{4}-\d{2}-\d{2}$/.test(String(v.publishedOn || "")) ? String(v.publishedOn) : "",
      caption:     String(v.caption || "").slice(0, 500),
      views: metric(v.views), likes: metric(v.likes), comments: metric(v.comments), saves: metric(v.saves), shares: metric(v.shares),
    }))
    .filter(v => /^https?:\/\//i.test(v.url));
  if (!videos.length) {
    return json(200, { updated: 0, inserted: 0, message: "No videos provided" });
  }
  lockHolder = await locks.acquire("update_sheet_metrics", 5 * 60, "A metrics update is already running.");

  const auth   = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes:      ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // ── 1. Read existing sheet rows ─────────────────────────────────────────
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         `${SHEET_NAME}!A2:R`,
  });
  const rows = resp.data.values || [];

  // Build URL → { rowIndex, row } map (rowIndex is 1-based sheet row)
  const urlMap = new Map();
  rows.forEach((row, i) => {
    const url = (row[V.POST_URL - 1] || "").trim().replace(/\/$/, "");
    if (url) urlMap.set(url, { rowIndex: i + 2, row });
  });

  // ── 2. Process each video ───────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let updated  = 0;
  let inserted = 0;
  const checkedOn = today.toISOString().slice(0, 10);

  for (const v of videos) {
    const normalUrl = (v.url || "").trim().replace(/\/$/, "");
    if (!normalUrl) continue;

    // Determine Day 1 / 2 / 3 column based on days since publish
    let dayCol = V.DAY1_VIEWS;
    if (v.publishedOn) {
      const pub = new Date(v.publishedOn + "T00:00:00");
      pub.setHours(0, 0, 0, 0);
      const daysSince = Math.round((today - pub) / (1000 * 60 * 60 * 24));
      if (daysSince <= 1)      dayCol = V.DAY1_VIEWS; // F
      else if (daysSince <= 2) dayCol = V.DAY2_VIEWS; // G
      else                     dayCol = V.DAY3_VIEWS; // H
    }

    // Convert column number (1-based) → letter
    const colLetter = colToLetter(dayCol);

    if (urlMap.has(normalUrl) && urlMap.get(normalUrl).pending) {
      continue; // appended earlier in this request
    } else if (urlMap.has(normalUrl)) {
      // ── Update existing row ─────────────────────────────────────────────
      const { rowIndex } = urlMap.get(normalUrl);

      // Write the day's views into its column
      await sheets.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           `${SHEET_NAME}!${colLetter}${rowIndex}`,
        valueInputOption:"USER_ENTERED",
        resource:        { values: [[v.views ?? ""]] }, // numbers only
      });

      // Update engagement metrics + checked date (I–N)
      await sheets.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           `${SHEET_NAME}!I${rowIndex}:N${rowIndex}`,
        valueInputOption:"USER_ENTERED",
        resource: {
          values: [[
            v.likes    ?? "",
            v.comments ?? "",
            v.saves    ?? "",
            v.shares   ?? "",
            "",          // M: Follows — not scraped
            checkedOn,   // N: Checked On
          ]],
        },
      });

      updated++;
    } else {
      // ── Insert new row ──────────────────────────────────────────────────
      const row = new Array(18).fill("");
      row[V.POST_URL     - 1] = sheetSafe(normalUrl);
      row[V.PLATFORM     - 1] = sheetSafe(v.platform || "");
      row[V.PUBLISHED_ON - 1] = v.publishedOn || "";
      row[V.TOPIC        - 1] = sheetSafe(v.caption || "");
      row[dayCol         - 1] = v.views       ?? "";
      row[V.LIKES        - 1] = v.likes       ?? "";
      row[V.COMMENTS     - 1] = v.comments    ?? "";
      row[V.SAVES        - 1] = v.saves       ?? "";
      row[V.SHARES       - 1] = v.shares      ?? "";
      row[V.CHECKED_ON   - 1] = checkedOn;

      await sheets.spreadsheets.values.append({
        spreadsheetId:   sheetId,
        range:           `${SHEET_NAME}!A:A`,
        valueInputOption:"USER_ENTERED",
        insertDataOption:"INSERT_ROWS",
        resource:        { values: [row] },
      });
      // the same URL twice in one request must not append two rows
      urlMap.set(normalUrl, { rowIndex: null, row, pending: true });

      inserted++;
    }
  }

  return json(200, { updated, inserted, total: videos.length });
  } catch (err) {
    return errorResponse(err, "update-sheet-metrics");
  } finally {
    if (lockHolder) await locks.release("update_sheet_metrics", lockHolder);
  }
};

function colToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
