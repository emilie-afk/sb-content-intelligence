/**
 * Succulents Box — Video Performance Tracker
 *
 * Tracks SB's own published videos and feeds performance data
 * back into the Content Intelligence Dashboard for learning.
 *
 * HOW IT WORKS:
 * 1. Log a post when you publish (columns A–E)
 * 2. Fill in metrics 5–7 days later (columns F–L)
 * 3. Add your rating + notes (columns M–O)
 * 4. As soon as Rating is filled, performance is auto-submitted
 *    to the dashboard so the AI can learn from it
 *
 * HOW TO INSTALL:
 * 1. Open this Google Sheet (Video Tracker)
 * 2. Extensions → Apps Script → paste this file → Save
 * 3. Gear icon → Script Properties → add:
 *    NETLIFY_URL  → https://sb-content-intelligence.netlify.app
 *    SUBMIT_TOKEN → sb-scraper-2026-xK9mP3qL7w
 * 4. Reload sheet → click 🎬 SB Videos → Set up tracker
 */

const VID_SHEET = "SB Videos";

const V = {
  POST_URL:     1,   // A — link to live post
  PLATFORM:     2,   // B — dropdown
  PUBLISHED_ON: 3,   // C — date published
  TOPIC:        4,   // D — what it's about
  FORMAT:       5,   // E — Reel, TikTok, etc.
  VIEWS:        6,   // F — fill 5–7 days after posting
  LIKES:        7,   // G
  COMMENTS:     8,   // H
  SAVES:        9,   // I
  SHARES:       10,  // J
  FOLLOWS:      11,  // K — follows gained
  CHECKED_ON:   12,  // L — date metrics captured
  RATING:       13,  // M — 🔥 Hit / ✅ Solid / 📉 Weak
  WHAT_WORKED:  14,  // N
  IMPROVE:      15,  // O
  SUBMITTED:    16,  // P — auto: timestamp when sent to dashboard
};


// ── MENU ──────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🎬 SB Videos")
    .addItem("📊 Set up tracker", "setupTracker")
    .addItem("📤 Submit selected row", "submitSelectedRow")
    .addToUi();
}


// ── SET UP SHEET ──────────────────────────────────────────────────────────────
function setupTracker() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(VID_SHEET);
  if (!sheet) {
    // Rename Sheet1 if it's the only sheet and still default
    const existing = ss.getSheets();
    if (existing.length === 1 && existing[0].getName() === "Sheet1") {
      existing[0].setName(VID_SHEET);
      sheet = existing[0];
    } else {
      sheet = ss.insertSheet(VID_SHEET);
    }
  }

  const headers = [
    "Post URL", "Platform", "Published on", "Topic", "Format",
    "Views", "Likes", "Comments", "Saves", "Shares", "Follows gained",
    "Checked on", "Rating", "What worked", "What to improve",
    "Submitted to dashboard"
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  // Color groups
  const green  = "#1B5E20", greenTxt  = "#ffffff";
  const blue   = "#0D47A1", blueTxt   = "#ffffff";
  const purple = "#4A148C", purpleTxt = "#ffffff";
  const grey   = "#424242", greyTxt   = "#aaaaaa";

  // Post info (green)
  sheet.getRange(1, V.POST_URL, 1, 5)
    .setBackground(green).setFontColor(greenTxt).setFontWeight("bold");
  // Metrics (blue)
  sheet.getRange(1, V.VIEWS, 1, 7)
    .setBackground(blue).setFontColor(blueTxt).setFontWeight("bold");
  // Review (purple)
  sheet.getRange(1, V.RATING, 1, 3)
    .setBackground(purple).setFontColor(purpleTxt).setFontWeight("bold");
  // Auto (grey)
  sheet.getRange(1, V.SUBMITTED)
    .setBackground(grey).setFontColor(greyTxt).setFontWeight("bold");

  // Column widths
  const widths = {
    [V.POST_URL]: 260, [V.PLATFORM]: 100, [V.PUBLISHED_ON]: 120,
    [V.TOPIC]: 220, [V.FORMAT]: 110,
    [V.VIEWS]: 80, [V.LIKES]: 70, [V.COMMENTS]: 90,
    [V.SAVES]: 70, [V.SHARES]: 70, [V.FOLLOWS]: 110,
    [V.CHECKED_ON]: 110, [V.RATING]: 110,
    [V.WHAT_WORKED]: 220, [V.IMPROVE]: 220,
    [V.SUBMITTED]: 160,
  };
  Object.entries(widths).forEach(([col, w]) => sheet.setColumnWidth(Number(col), w));

  const rows = 500;

  // Platform dropdown
  sheet.getRange(2, V.PLATFORM, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["Instagram","TikTok","Facebook","YouTube","Pinterest","Other"], true).build()
  );

  // Format dropdown
  sheet.getRange(2, V.FORMAT, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["Reel","TikTok","Carousel","Static","YouTube Short","Story","Other"], true).build()
  );

  // Rating dropdown
  sheet.getRange(2, V.RATING, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["🔥 Hit","✅ Solid","📉 Weak"], true).build()
  );

  // Conditional formatting — whole row tinted by rating
  const allCols = sheet.getRange(2, 1, rows, headers.length);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains("Hit").setBackground("#E8F5E9").setFontColor("#1B5E20")
      .setRanges([allCols]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains("Weak").setBackground("#FFF3E0").setFontColor("#BF360C")
      .setRanges([allCols]).build(),
  ]);

  SpreadsheetApp.getUi().alert(
    "Video tracker is ready!\n\n" +
    "🟢 Fill when you publish: URL, platform, date, topic, format\n" +
    "🔵 Fill 5–7 days later: views, likes, comments, saves, shares, follows\n" +
    "🟣 Fill after reviewing: rating + what worked / what to improve\n\n" +
    "As soon as Rating is filled, the row auto-submits to the\n" +
    "Content Intelligence Dashboard for the AI to learn from."
  );
}


// ── AUTO-SUBMIT WHEN RATING IS FILLED ────────────────────────────────────────
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== VID_SHEET) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row <= 1) return;

  // Trigger when Rating is set and Views is present
  if (col === V.RATING && e.value && String(e.value).trim() !== "") {
    const views = sheet.getRange(row, V.VIEWS).getValue();
    if (views !== "" && views !== null) {
      submitPerformance(sheet, row);
    }
  }
}


// ── MANUAL SUBMIT FROM MENU ───────────────────────────────────────────────────
function submitSelectedRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== VID_SHEET) {
    SpreadsheetApp.getUi().alert('Switch to the "' + VID_SHEET + '" sheet first.');
    return;
  }
  const row = SpreadsheetApp.getActiveRange().getRow();
  if (row <= 1) { SpreadsheetApp.getUi().alert("Select a data row, not the header."); return; }
  submitPerformance(sheet, row);
}


// ── SUBMIT PERFORMANCE TO DASHBOARD ──────────────────────────────────────────
function submitPerformance(sheet, row) {
  const props      = PropertiesService.getScriptProperties();
  const netlifyUrl = props.getProperty("NETLIFY_URL");
  const token      = props.getProperty("SUBMIT_TOKEN");

  if (!netlifyUrl || !token) {
    sheet.getRange(row, V.SUBMITTED).setValue("❌ No config").setFontColor("red");
    return;
  }

  const get = col => {
    const v = sheet.getRange(row, col).getValue();
    return v !== null && v !== "" ? String(v).trim() : null;
  };

  const postUrl     = get(V.POST_URL);
  const platform    = get(V.PLATFORM);
  const publishedOn = get(V.PUBLISHED_ON);
  const topic       = get(V.TOPIC);
  const format      = get(V.FORMAT);
  const views       = get(V.VIEWS);
  const likes       = get(V.LIKES);
  const comments    = get(V.COMMENTS);
  const saves       = get(V.SAVES);
  const shares      = get(V.SHARES);
  const follows     = get(V.FOLLOWS);
  const checkedOn   = get(V.CHECKED_ON);
  const rating      = get(V.RATING);
  const whatWorked  = get(V.WHAT_WORKED);
  const improve     = get(V.IMPROVE);

  // Build a rich caption summary the AI can learn from
  const metricsSummary = [
    views    ? `Views: ${views}`    : null,
    likes    ? `Likes: ${likes}`    : null,
    comments ? `Comments: ${comments}` : null,
    saves    ? `Saves: ${saves}`    : null,
    shares   ? `Shares: ${shares}`  : null,
    follows  ? `Follows: ${follows}` : null,
  ].filter(Boolean).join(" | ");

  const captionParts = [
    `[OWN CONTENT PERFORMANCE — ${rating || "unrated"}]`,
    topic   ? `Topic: ${topic}`   : null,
    format  ? `Format: ${format}` : null,
    publishedOn ? `Published: ${publishedOn}` : null,
    checkedOn   ? `Checked: ${checkedOn}`     : null,
    metricsSummary || null,
    whatWorked ? `What worked: ${whatWorked}` : null,
    improve    ? `Improve: ${improve}`         : null,
  ].filter(Boolean).join("\n");

  const payload = [{
    topic:           topic || "SB video performance",
    source_url:      postUrl,
    platform:        platform,
    creator_name:    "Succulents Box",
    caption_summary: captionParts,
    date_found:      new Date().toISOString().slice(0, 10),
    status:          "New",
  }];

  const endpoint = netlifyUrl.replace(/\/$/, "") + "/.netlify/functions/submit-signal";

  try {
    const response = UrlFetchApp.fetch(endpoint, {
      method:             "post",
      contentType:        "application/json",
      headers:            { "x-submission-token": token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code === 200) {
      sheet.getRange(row, V.SUBMITTED)
        .setValue("✅ " + new Date().toLocaleDateString()).setFontColor("green");
    } else {
      const err = JSON.parse(response.getContentText());
      sheet.getRange(row, V.SUBMITTED)
        .setValue("❌ " + (err.error || "HTTP " + code)).setFontColor("red");
    }
  } catch (err) {
    sheet.getRange(row, V.SUBMITTED).setValue("❌ " + err.message).setFontColor("red");
  }
}
