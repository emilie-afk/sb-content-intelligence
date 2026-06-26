/**
 * Succulents Box — Signal Intake Sheet (Simple Version)
 *
 * HOW IT WORKS:
 * Assistant fills in a row → as soon as Raw input is entered,
 * the signal is automatically submitted to the dashboard.
 * All reviewing, briefs, and opportunities are managed in the dashboard.
 *
 * HOW TO INSTALL:
 * 1. Open the intake Google Sheet
 * 2. Rename the tab to "Intake"
 * 3. Extensions → Apps Script → paste this file → Save
 * 4. Gear icon (Project Settings) → Script Properties → add:
 *    NETLIFY_URL  → https://sb-content-intelligence.netlify.app
 *    SUBMIT_TOKEN → sb-scraper-2026-xK9mP3qL7w
 * 5. Reload the sheet → click 🌵 SB Intake → Set up headers
 */

const SHEET_NAME = "Intake";

const COL = {
  RAW_INPUT:    1,   // ← assistant fills this (required)
  SOURCE_URL:   2,   // ← optional
  PLATFORM:     3,   // ← optional
  SOURCE_NAME:  4,   // ← optional
  STATUS:       5,   // auto — "✅ Sent" or "❌ Error"
  SUBMITTED_AT: 6,   // auto — timestamp
};


const PUB_SHEET_NAME = "Published";

const PUB = {
  POST_URL:     1,   // Link to live post
  PLATFORM:     2,   // Dropdown
  PUBLISHED_ON: 3,   // Date published
  TOPIC:        4,   // What it's about
  FORMAT:       5,   // Reel, TikTok, Carousel, etc.
  VIEWS:        6,   // Filled in after posting
  LIKES:        7,
  COMMENTS:     8,
  SAVES:        9,
  FOLLOWS:      10,  // Follows gained
  CHECKED_ON:   11,  // Date metrics were captured
  RATING:       12,  // Hit / Solid / Weak
  NOTES:        13,  // Learnings
};


// ── MENU ──────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🌵 SB Intake")
    .addItem("📋 Set up Intake headers", "setupHeaders")
    .addItem("📊 Set up Published tracker", "setupPublished")
    .addToUi();
}


// ── SET UP HEADERS ────────────────────────────────────────────────────────────
function setupHeaders() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { SpreadsheetApp.getUi().alert('Rename your sheet tab to "Intake" first.'); return; }

  const headers = ["Raw input", "Source URL", "Platform", "Source name", "Status", "Submitted at"];
  const range   = sheet.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);

  // Amber = assistant fills | Grey = auto
  range.setBackground("#1a2e1a").setFontColor("white").setFontWeight("bold");
  sheet.getRange(1, COL.RAW_INPUT).setBackground("#7B5800").setFontColor("white").setFontWeight("bold");
  sheet.getRange(1, COL.SOURCE_URL).setBackground("#7B5800").setFontColor("white").setFontWeight("bold");
  sheet.getRange(1, COL.PLATFORM).setBackground("#7B5800").setFontColor("white").setFontWeight("bold");
  sheet.getRange(1, COL.SOURCE_NAME).setBackground("#7B5800").setFontColor("white").setFontWeight("bold");
  sheet.getRange(1, COL.STATUS).setBackground("#444444").setFontColor("#aaaaaa").setFontWeight("bold");
  sheet.getRange(1, COL.SUBMITTED_AT).setBackground("#444444").setFontColor("#aaaaaa").setFontWeight("bold");

  // Column widths
  sheet.setColumnWidth(COL.RAW_INPUT,   400);
  sheet.setColumnWidth(COL.SOURCE_URL,  200);
  sheet.setColumnWidth(COL.PLATFORM,    100);
  sheet.setColumnWidth(COL.SOURCE_NAME, 150);
  sheet.setColumnWidth(COL.STATUS,      100);
  sheet.setColumnWidth(COL.SUBMITTED_AT,140);

  // Platform dropdown
  const platformRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["TikTok","Instagram","Facebook","YouTube","Pinterest","Other"], true)
    .build();
  sheet.getRange(2, COL.PLATFORM, 500, 1).setDataValidation(platformRule);

  sheet.setFrozenRows(1);

  SpreadsheetApp.getUi().alert(
    "Ready!\n\n" +
    "Amber columns = paste info here:\n" +
    "  • Raw input (required) — describe what you saw\n" +
    "  • Source URL, Platform, Source name (optional)\n\n" +
    "As soon as Raw input is filled, it auto-submits to the dashboard.\n" +
    "Everything else happens there."
  );
}


// ── AUTO-SUBMIT ON EDIT ───────────────────────────────────────────────────────
function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  if (row <= 1) return; // skip header

  // Trigger submit when Raw input is filled
  if (col === COL.RAW_INPUT && e.value && String(e.value).trim() !== "") {
    submitRow(sheet, row);
  }
}


// ── SUBMIT A ROW ──────────────────────────────────────────────────────────────
function submitRow(sheet, row) {
  const props      = PropertiesService.getScriptProperties();
  const netlifyUrl = props.getProperty("NETLIFY_URL");
  const token      = props.getProperty("SUBMIT_TOKEN");

  if (!netlifyUrl || !token) {
    sheet.getRange(row, COL.STATUS).setValue("❌ No config").setFontColor("red");
    return;
  }

  const rawInput   = String(sheet.getRange(row, COL.RAW_INPUT).getValue()).trim();
  const sourceUrl  = String(sheet.getRange(row, COL.SOURCE_URL).getValue()).trim()  || null;
  const platform   = String(sheet.getRange(row, COL.PLATFORM).getValue()).trim()    || null;
  const sourceName = String(sheet.getRange(row, COL.SOURCE_NAME).getValue()).trim() || null;

  const payload = [{
    topic:                rawInput,
    source_url:           sourceUrl,
    platform:             platform   !== "" ? platform   : null,
    creator_name:         sourceName !== "" ? sourceName : null,
    date_found:           new Date().toISOString().slice(0, 10),
    status:               "New",
    is_manual_submission: true,   // intake sheet = human-submitted, always High priority
    priority:             "High",
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

    const statusCode = response.getResponseCode();
    if (statusCode === 200) {
      sheet.getRange(row, COL.STATUS).setValue("✅ Sent").setFontColor("green");
      sheet.getRange(row, COL.SUBMITTED_AT).setValue(new Date());
    } else {
      const err = JSON.parse(response.getContentText());
      sheet.getRange(row, COL.STATUS).setValue("❌ Error").setFontColor("red");
      sheet.getRange(row, COL.SUBMITTED_AT).setValue(err.error || "HTTP " + statusCode);
    }
  } catch (e) {
    sheet.getRange(row, COL.STATUS).setValue("❌ Error").setFontColor("red");
    sheet.getRange(row, COL.SUBMITTED_AT).setValue(e.message);
  }
}


// ── SET UP PUBLISHED TRACKER ──────────────────────────────────────────────────
function setupPublished() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PUB_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(PUB_SHEET_NAME);
  }

  // ── Headers ──
  const headers = [
    "Post URL", "Platform", "Published on", "Topic", "Format",
    "Views", "Likes", "Comments", "Saves", "Follows gained",
    "Checked on", "Rating", "Notes / learnings"
  ];
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]).setFontWeight("bold").setFrozenRows;
  sheet.setFrozenRows(1);

  // Color groups: post info (green) | metrics (blue) | review (purple)
  const green  = "#1B5E20"; const greenText  = "#ffffff";
  const blue   = "#0D47A1"; const blueText   = "#ffffff";
  const purple = "#4A148C"; const purpleText = "#ffffff";

  [PUB.POST_URL, PUB.PLATFORM, PUB.PUBLISHED_ON, PUB.TOPIC, PUB.FORMAT].forEach(c =>
    sheet.getRange(1, c).setBackground(green).setFontColor(greenText)
  );
  [PUB.VIEWS, PUB.LIKES, PUB.COMMENTS, PUB.SAVES, PUB.FOLLOWS, PUB.CHECKED_ON].forEach(c =>
    sheet.getRange(1, c).setBackground(blue).setFontColor(blueText)
  );
  [PUB.RATING, PUB.NOTES].forEach(c =>
    sheet.getRange(1, c).setBackground(purple).setFontColor(purpleText)
  );

  // ── Column widths ──
  sheet.setColumnWidth(PUB.POST_URL,     280);
  sheet.setColumnWidth(PUB.PLATFORM,     100);
  sheet.setColumnWidth(PUB.PUBLISHED_ON, 120);
  sheet.setColumnWidth(PUB.TOPIC,        200);
  sheet.setColumnWidth(PUB.FORMAT,       110);
  sheet.setColumnWidth(PUB.VIEWS,         80);
  sheet.setColumnWidth(PUB.LIKES,         70);
  sheet.setColumnWidth(PUB.COMMENTS,      90);
  sheet.setColumnWidth(PUB.SAVES,         70);
  sheet.setColumnWidth(PUB.FOLLOWS,      110);
  sheet.setColumnWidth(PUB.CHECKED_ON,   110);
  sheet.setColumnWidth(PUB.RATING,       100);
  sheet.setColumnWidth(PUB.NOTES,        250);

  // ── Dropdowns ──
  const rows = 500;
  sheet.getRange(2, PUB.PLATFORM, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["Instagram","TikTok","Facebook","YouTube","Pinterest","Other"], true).build()
  );
  sheet.getRange(2, PUB.FORMAT, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["Reel","TikTok","Carousel","Static","YouTube Short","Story","Other"], true).build()
  );
  sheet.getRange(2, PUB.RATING, rows).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["🔥 Hit","✅ Solid","📉 Weak"], true).build()
  );

  // ── Conditional formatting: highlight hits ──
  const ratingCol  = sheet.getRange(2, PUB.RATING, rows);
  const hitRule    = SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains("Hit")
    .setBackground("#E8F5E9").setFontColor("#1B5E20")
    .setRanges([sheet.getRange(2, 1, rows, headers.length)])
    .build();
  const weakRule   = SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains("Weak")
    .setBackground("#FFF3E0").setFontColor("#BF360C")
    .setRanges([sheet.getRange(2, 1, rows, headers.length)])
    .build();
  sheet.setConditionalFormatRules([hitRule, weakRule]);

  SpreadsheetApp.getUi().alert(
    "Published tracker is ready!\n\n" +
    "🟢 Post info — fill when you publish\n" +
    "🔵 Metrics — fill in 5–7 days after posting\n" +
    "🟣 Rating & notes — your take on how it performed\n\n" +
    "Tip: sort by Views or Rating to see what's working."
  );
}
