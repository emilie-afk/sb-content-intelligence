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
const { CORS_HEADERS } = require("./_auth");

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
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Only callable via internal secret (Cowork task / GitHub Actions)
  const internalSecret = event.headers["x-internal-secret"];
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const sheetId        = process.env.GOOGLE_VIDEO_TRACKER_ID;
  const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : null;

  if (!sheetId || !serviceAccount) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Google Sheet credentials not configured" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { videos = [] } = body;
  if (!videos.length) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updated: 0, inserted: 0, message: "No videos provided" }),
    };
  }

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

    if (urlMap.has(normalUrl)) {
      // ── Update existing row ─────────────────────────────────────────────
      const { rowIndex } = urlMap.get(normalUrl);

      // Write the day's views into its column
      await sheets.spreadsheets.values.update({
        spreadsheetId:   sheetId,
        range:           `${SHEET_NAME}!${colLetter}${rowIndex}`,
        valueInputOption:"USER_ENTERED",
        resource:        { values: [[v.views ?? ""]] },
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
      row[V.POST_URL     - 1] = normalUrl;
      row[V.PLATFORM     - 1] = v.platform    || "";
      row[V.PUBLISHED_ON - 1] = v.publishedOn || "";
      row[V.TOPIC        - 1] = v.caption     || "";
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

      inserted++;
    }
  }

  return {
    statusCode: 200,
    headers:    { "Content-Type": "application/json" },
    body:       JSON.stringify({ updated, inserted, total: videos.length }),
  };
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
