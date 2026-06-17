/**
 * Succulents Box — Signal Intake Sheet Script
 *
 * HOW TO INSTALL:
 * 1. Open your intake Google Sheet
 * 2. Extensions → Apps Script
 * 3. Delete the default code and paste this entire file
 * 4. Click the gear icon (Project Settings) and add Script Properties:
 *    - CLAUDE_API_KEY    → your Anthropic API key (get one at console.anthropic.com)
 *    - NETLIFY_URL       → e.g. https://sb-social-dashboard.netlify.app
 *    - SUBMIT_TOKEN      → the token you created in Supabase (plain text)
 * 5. Save and refresh the Google Sheet
 * 6. You'll see an "SB Intake" menu in the toolbar
 */

// ── COLUMN MAP ────────────────────────────────────────────────────────────────
// Matches the order in the sheet. Update if you reorder columns.
const COL = {
  SUBMITTED_AT:      1,
  SUBMITTED_BY:      2,
  RAW_INPUT:         3,
  SOURCE_URL:        4,
  SIGNAL_TYPE:       5,
  PLATFORM:          6,
  SOURCE_NAME:       7,
  DATE_FOUND:        8,
  TOPIC:             9,
  PLANT_PRODUCT:     10,
  CAPTION_SUMMARY:   11,
  METRICS:           12,
  REPEATED_QUESTION: 13,
  AUDIENCE_LANGUAGE: 14,
  WHY_MATTERS:       15,
  CATALOG_FIT:       16,
  CONTENT_PILLAR:    17,
  SHELF_LIFE:        18,
  PRIORITY_GUESS:    19,
  SUGGESTED_HOOK:    20,
  SUGGESTED_FORMAT:  21,
  DUPLICATE_MATCH:   22,
  AI_CONFIDENCE:     23,
  NEEDS_REVIEW:      24,
  REVIEW_STATUS:     25,
  NOTES:             26,
  IMPORT_STATUS:     27,
  IMPORT_ID:         28,
  IMPORT_ERROR:      29,
};

const HEADER_ROW    = 1;
const DATA_START    = 2;
const SHEET_NAME    = "Intake"; // Change if your sheet tab has a different name


// ── MENU ──────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🌵 SB Intake")
    .addItem("✨ Fill selected rows with AI",    "fillSelectedWithAI")
    .addSeparator()
    .addItem("✅ Mark selected as Ready to Import", "markSelectedReady")
    .addItem("🚫 Mark selected as Not Useful",      "markSelectedNotUseful")
    .addSeparator()
    .addItem("📡 Import ready rows to Supabase",  "importReadyToSupabase")
    .addSeparator()
    .addItem("📋 Set up sheet headers",           "setupHeaders")
    .addToUi();
}


// ── SET UP HEADERS ────────────────────────────────────────────────────────────
function setupHeaders() {
  const sheet = getSheet();
  if (!sheet) return;

  const headers = [
    "Submitted at", "Submitted by", "Raw input", "Source URL",
    "Signal type", "Platform", "Source name", "Date found",
    "Topic", "Plant/product", "Caption/post summary", "Metrics",
    "Repeated question/theme", "Audience language", "Why it matters",
    "Catalog fit guess", "Content pillar", "Shelf life", "Priority guess",
    "Suggested hook", "Suggested format", "Duplicate/similar topic match",
    "AI confidence", "Needs human review?", "Assistant review status",
    "Notes", "Import status", "Import ID", "Import error"
  ];

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground("#1a2e1a").setFontColor("white").setFontWeight("bold");

  // Freeze header row
  sheet.setFrozenRows(1);

  // Set column widths
  sheet.setColumnWidth(COL.RAW_INPUT, 300);
  sheet.setColumnWidth(COL.SUGGESTED_HOOK, 250);
  sheet.setColumnWidth(COL.WHY_MATTERS, 200);
  sheet.setColumnWidth(COL.CAPTION_SUMMARY, 200);
  sheet.setColumnWidth(COL.REPEATED_QUESTION, 200);
  sheet.setColumnWidth(COL.AUDIENCE_LANGUAGE, 200);

  // Add validation for key columns
  addDropdown(sheet, COL.SIGNAL_TYPE, [
    "TikTok manual observation", "TikTok scraped/imported result",
    "Instagram manual observation", "Instagram scraped/imported result",
    "Facebook Group manual observation", "YouTube observation",
    "Competitor observation", "Customer comment / DM theme",
    "Published video comment theme", "Other community signal"
  ]);
  addDropdown(sheet, COL.PLATFORM, ["TikTok","Instagram","Facebook","YouTube","Pinterest","Website","Email","Other"]);
  addDropdown(sheet, COL.SHELF_LIFE, ["Trend","Seasonal","Evergreen","Experimental"]);
  addDropdown(sheet, COL.PRIORITY_GUESS, ["High","Medium","Low"]);
  addDropdown(sheet, COL.AI_CONFIDENCE, ["High","Medium","Low"]);
  addDropdown(sheet, COL.NEEDS_REVIEW, ["Yes","No"]);
  addDropdown(sheet, COL.REVIEW_STATUS, ["Unchecked","Looks good","Needs correction","Not useful","Ready to import"]);
  addDropdown(sheet, COL.IMPORT_STATUS, ["New","Imported","Needs review","Error","Skipped duplicate"]);
  addDropdown(sheet, COL.CONTENT_PILLAR, [
    "Repeated Questions","Common Mistakes","Plant Rescue","Myths and Debates",
    "Experiments","Unusual Plant Features","Seasonal Problems","Trend Adaptation","Product / Catalog Fit"
  ]);

  SpreadsheetApp.getUi().alert("Headers set up! You can now start adding signals.");
}

function addDropdown(sheet, col, values) {
  const range = sheet.getRange(DATA_START, col, 500, 1);
  const rule  = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(true)
    .build();
  range.setDataValidation(rule);
}


// ── AI FILL ───────────────────────────────────────────────────────────────────
function fillSelectedWithAI() {
  const sheet     = getSheet();
  const selection = sheet.getActiveRange();
  const rows      = getSelectedDataRows(sheet, selection);

  if (rows.length === 0) {
    SpreadsheetApp.getUi().alert("Select one or more data rows first (not the header).");
    return;
  }

  const props   = PropertiesService.getScriptProperties();
  const apiKey  = props.getProperty("CLAUDE_API_KEY");

  if (!apiKey) {
    // No API key — generate a prompt to copy-paste into Claude manually
    generateManualPrompt(rows, sheet);
    return;
  }

  // Auto-fill via Claude API
  let filled = 0;
  rows.forEach(rowNum => {
    const rowData = sheet.getRange(rowNum, 1, 1, Object.keys(COL).length).getValues()[0];
    const rawInput = rowData[COL.RAW_INPUT - 1];

    if (!rawInput || String(rawInput).trim() === "") {
      return; // skip empty rows
    }

    try {
      const result = callClaudeAPI(apiKey, rawInput, rowData);
      if (result) {
        applyAIResult(sheet, rowNum, result);
        filled++;
      }
    } catch (e) {
      sheet.getRange(rowNum, COL.NOTES).setValue("AI fill error: " + e.message);
    }

    Utilities.sleep(500); // Respect API rate limits
  });

  SpreadsheetApp.getUi().alert(`AI fill complete. ${filled} row(s) updated.`);
}

function callClaudeAPI(apiKey, rawInput, rowData) {
  const sourceUrl  = rowData[COL.SOURCE_URL - 1]  || "";
  const metrics    = rowData[COL.METRICS - 1]      || "";
  const sourceName = rowData[COL.SOURCE_NAME - 1]  || "";
  const platform   = rowData[COL.PLATFORM - 1]     || "";

  const prompt = buildAIPrompt(rawInput, sourceUrl, metrics, sourceName, platform);

  const payload = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", options);
  const data     = JSON.parse(response.getContentText());

  if (data.error) throw new Error(data.error.message);

  const text = data.content?.[0]?.text || "";

  // Extract JSON from response
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse AI response");

  return JSON.parse(jsonMatch[1] || jsonMatch[0]);
}

function buildAIPrompt(rawInput, sourceUrl, metrics, sourceName, platform) {
  return `You are helping Succulents Box, a succulent plant subscription company, process social listening signals.

A team member found this signal:

RAW INPUT:
${rawInput}

ADDITIONAL CONTEXT:
Source URL: ${sourceUrl || "not provided"}
Metrics: ${metrics || "not provided"}
Source name: ${sourceName || "not provided"}
Platform: ${platform || "not provided"}

Fill in these fields based on the raw input. Return ONLY valid JSON, no explanation.

JSON format:
{
  "signal_type": "one of: TikTok manual observation | TikTok scraped/imported result | Instagram manual observation | Instagram scraped/imported result | Facebook Group manual observation | YouTube observation | Competitor observation | Customer comment / DM theme | Published video comment theme | Other community signal",
  "platform": "one of: TikTok | Instagram | Facebook | YouTube | Pinterest | Website | Email | Other",
  "topic": "short clear topic name, e.g. Echeveria stretching / etiolation",
  "plant_product": "plant name or product name, e.g. Echeveria, String of Pearls, Lithops",
  "caption_summary": "1-2 sentence factual summary of the content",
  "repeated_question": "what audience members are asking or what theme repeats",
  "audience_language": "2-3 short verbatim-style phrases the audience uses, comma separated",
  "why_matters": "1 sentence on why this is worth filming",
  "catalog_fit": "matched SB product name, or Needs check, or Not applicable",
  "content_pillar": "one of: Repeated Questions | Common Mistakes | Plant Rescue | Myths and Debates | Experiments | Unusual Plant Features | Seasonal Problems | Trend Adaptation | Product / Catalog Fit",
  "shelf_life": "one of: Trend | Seasonal | Evergreen | Experimental",
  "priority_guess": "one of: High | Medium | Low",
  "suggested_hook": "one strong opening hook sentence",
  "suggested_format": "brief format recommendation, e.g. Diagnosis and quick fix | Visual comparison | Talking head explanation",
  "duplicate_match": "leave blank unless obviously duplicate of a common topic",
  "ai_confidence": "one of: High | Medium | Low",
  "needs_review": "Yes or No — Yes if weak evidence, uncertain plant ID, or Facebook private group"
}

Rules:
- Do not invent metrics or URLs.
- For Facebook Group signals, summarize patterns — do not name individuals.
- If plant/product is unclear, set catalog_fit to "Needs check".
- Keep audience_language short and natural — phrases real people write.
- Priority High = strong comment demand + clear product fit. Low = vague or evergreen only.`;
}

function applyAIResult(sheet, rowNum, result) {
  const set = (col, val) => { if (val != null) sheet.getRange(rowNum, col).setValue(val); };

  set(COL.SIGNAL_TYPE,       result.signal_type);
  set(COL.PLATFORM,          result.platform);
  set(COL.TOPIC,             result.topic);
  set(COL.PLANT_PRODUCT,     result.plant_product);
  set(COL.CAPTION_SUMMARY,   result.caption_summary);
  set(COL.REPEATED_QUESTION, result.repeated_question);
  set(COL.AUDIENCE_LANGUAGE, result.audience_language);
  set(COL.WHY_MATTERS,       result.why_matters);
  set(COL.CATALOG_FIT,       result.catalog_fit);
  set(COL.CONTENT_PILLAR,    result.content_pillar);
  set(COL.SHELF_LIFE,        result.shelf_life);
  set(COL.PRIORITY_GUESS,    result.priority_guess);
  set(COL.SUGGESTED_HOOK,    result.suggested_hook);
  set(COL.SUGGESTED_FORMAT,  result.suggested_format);
  set(COL.DUPLICATE_MATCH,   result.duplicate_match || "");
  set(COL.AI_CONFIDENCE,     result.ai_confidence);
  set(COL.NEEDS_REVIEW,      result.needs_review);

  // Auto-set review status based on confidence and review flag
  const needsReview    = result.needs_review === "Yes";
  const lowConfidence  = result.ai_confidence === "Low";
  set(COL.REVIEW_STATUS,  needsReview || lowConfidence ? "Needs correction" : "Unchecked");
  set(COL.IMPORT_STATUS,  "New");
}


// ── MANUAL PROMPT (no API key) ────────────────────────────────────────────────
function generateManualPrompt(rows, sheet) {
  const parts = [];

  rows.forEach(rowNum => {
    const rowData   = sheet.getRange(rowNum, 1, 1, 29).getValues()[0];
    const rawInput  = rowData[COL.RAW_INPUT - 1];
    const sourceUrl = rowData[COL.SOURCE_URL - 1] || "";
    const metrics   = rowData[COL.METRICS - 1]    || "";
    const source    = rowData[COL.SOURCE_NAME - 1] || "";
    const platform  = rowData[COL.PLATFORM - 1]   || "";

    if (!rawInput) return;
    parts.push(`ROW ${rowNum}:\n${buildAIPrompt(rawInput, sourceUrl, metrics, source, platform)}`);
  });

  if (parts.length === 0) {
    SpreadsheetApp.getUi().alert("Selected rows have no raw input.");
    return;
  }

  // Write prompt to a temp sheet for easy copying
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  let promptSheet = ss.getSheetByName("AI Prompt (temp)");
  if (!promptSheet) promptSheet = ss.insertSheet("AI Prompt (temp)");
  promptSheet.clear();
  promptSheet.getRange(1, 1).setValue(parts.join("\n\n---\n\n"));
  promptSheet.getRange(1, 1).setWrap(true);
  promptSheet.setColumnWidth(1, 700);

  ss.setActiveSheet(promptSheet);
  SpreadsheetApp.getUi().alert(
    "No Claude API key set.\n\n" +
    "A prompt has been generated in the 'AI Prompt (temp)' tab.\n" +
    "Copy it into Claude, paste the JSON response back, then manually fill the columns.\n\n" +
    "To enable automatic AI fill:\n" +
    "Extensions → Apps Script → Project Settings → Script Properties\n" +
    "Add property: CLAUDE_API_KEY = your-key"
  );
}


// ── MARK STATUS ───────────────────────────────────────────────────────────────
function markSelectedReady() {
  setReviewStatus("Ready to import");
  setImportStatus("New");
}

function markSelectedNotUseful() {
  setReviewStatus("Not useful");
}

function setReviewStatus(status) {
  const sheet     = getSheet();
  const selection = sheet.getActiveRange();
  const rows      = getSelectedDataRows(sheet, selection);
  rows.forEach(r => sheet.getRange(r, COL.REVIEW_STATUS).setValue(status));
}

function setImportStatus(status) {
  const sheet     = getSheet();
  const selection = sheet.getActiveRange();
  const rows      = getSelectedDataRows(sheet, selection);
  rows.forEach(r => {
    if (sheet.getRange(r, COL.IMPORT_STATUS).getValue() !== "Imported") {
      sheet.getRange(r, COL.IMPORT_STATUS).setValue(status);
    }
  });
}


// ── IMPORT TO SUPABASE ────────────────────────────────────────────────────────
function importReadyToSupabase() {
  const props      = PropertiesService.getScriptProperties();
  const netlifyUrl = props.getProperty("NETLIFY_URL");
  const token      = props.getProperty("SUBMIT_TOKEN");

  if (!netlifyUrl || !token) {
    SpreadsheetApp.getUi().alert(
      "NETLIFY_URL and SUBMIT_TOKEN are not set.\n\n" +
      "Go to Extensions → Apps Script → Project Settings → Script Properties and add them."
    );
    return;
  }

  const sheet  = getSheet();
  const data   = sheet.getDataRange().getValues();
  const rows   = [];
  const rowNums = [];

  for (let i = DATA_START - 1; i < data.length; i++) {
    const row          = data[i];
    const reviewStatus = String(row[COL.REVIEW_STATUS - 1]).trim();
    const importStatus = String(row[COL.IMPORT_STATUS - 1]).trim();
    const rawInput     = String(row[COL.RAW_INPUT - 1]).trim();

    if (reviewStatus === "Ready to import" && importStatus === "New" && rawInput) {
      rows.push({
        date_found:            formatDate(row[COL.DATE_FOUND - 1]),
        platform:              row[COL.PLATFORM - 1]          || null,
        source_url:            row[COL.SOURCE_URL - 1]        || null,
        creator_name:          row[COL.SOURCE_NAME - 1]       || null,
        topic:                 row[COL.TOPIC - 1]             || null,
        plant_or_product:      row[COL.PLANT_PRODUCT - 1]     || null,
        caption_summary:       row[COL.CAPTION_SUMMARY - 1]   || null,
        metrics_summary:       row[COL.METRICS - 1]           || null,
        comment_theme_summary: row[COL.REPEATED_QUESTION - 1] || null,
        audience_problem:      row[COL.WHY_MATTERS - 1]       || null,
        ai_cleanup_notes:      [
          row[COL.AUDIENCE_LANGUAGE - 1] ? "Audience language: " + row[COL.AUDIENCE_LANGUAGE - 1] : "",
          row[COL.CATALOG_FIT - 1]       ? "Catalog fit: "       + row[COL.CATALOG_FIT - 1]       : "",
          row[COL.SUGGESTED_HOOK - 1]    ? "Hook: "              + row[COL.SUGGESTED_HOOK - 1]     : "",
          row[COL.SUGGESTED_FORMAT - 1]  ? "Format: "            + row[COL.SUGGESTED_FORMAT - 1]   : "",
        ].filter(Boolean).join(" | ") || null,
        priority:              row[COL.PRIORITY_GUESS - 1]    || null,
        shelf_life:            row[COL.SHELF_LIFE - 1]        || null,
        status:                "New",
      });
      rowNums.push(i + 1); // 1-based row number
    }
  }

  if (rows.length === 0) {
    SpreadsheetApp.getUi().alert("No rows with 'Ready to import' status and 'New' import status found.");
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    `Import ${rows.length} row(s) to the dashboard?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // POST to Netlify Function
  const endpoint = netlifyUrl.replace(/\/$/, "") + "/.netlify/functions/submit-signal";
  const options  = {
    method:           "post",
    contentType:      "application/json",
    headers:          { "x-submission-token": token },
    payload:          JSON.stringify(rows),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(endpoint, options);
    const result   = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      // Mark all rows as Imported
      rowNums.forEach(r => {
        sheet.getRange(r, COL.IMPORT_STATUS).setValue("Imported");
        sheet.getRange(r, COL.IMPORT_ERROR).setValue("");
        sheet.getRange(r, COL.IMPORT_ID).setValue("imported-" + new Date().toISOString().slice(0,10));
      });
      ui.alert(`✅ Import complete!\n${result.inserted} new signal(s) added\n${result.skipped} duplicate(s) skipped`);
    } else {
      rowNums.forEach(r => {
        sheet.getRange(r, COL.IMPORT_STATUS).setValue("Error");
        sheet.getRange(r, COL.IMPORT_ERROR).setValue(result.error || "Unknown error");
      });
      ui.alert("❌ Import failed: " + (result.error || response.getContentText()));
    }
  } catch (e) {
    rowNums.forEach(r => {
      sheet.getRange(r, COL.IMPORT_STATUS).setValue("Error");
      sheet.getRange(r, COL.IMPORT_ERROR).setValue(e.message);
    });
    ui.alert("❌ Network error: " + e.message);
  }
}


// ── HELPERS ───────────────────────────────────────────────────────────────────
function getSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert(`Sheet tab named "${SHEET_NAME}" not found. Rename your sheet tab or update the SHEET_NAME constant.`);
    return null;
  }
  return sheet;
}

function getSelectedDataRows(sheet, selection) {
  const rows = [];
  const startRow = Math.max(selection.getRow(), DATA_START);
  const endRow   = selection.getLastRow();
  for (let r = startRow; r <= endRow; r++) rows.push(r);
  return rows;
}

function formatDate(val) {
  if (!val) return new Date().toISOString().slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}


// ── AUTO-TIMESTAMP ON EDIT ────────────────────────────────────────────────────
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const col = e.range.getColumn();
  const row = e.range.getRow();

  // Skip header row
  if (row <= HEADER_ROW) return;

  // Auto-fill "Submitted at" when raw input is added
  if (col === COL.RAW_INPUT && e.value) {
    const timestampCell = sheet.getRange(row, COL.SUBMITTED_AT);
    if (!timestampCell.getValue()) {
      timestampCell.setValue(new Date());
    }
    // Auto-fill "Import status" to New if blank
    const importCell = sheet.getRange(row, COL.IMPORT_STATUS);
    if (!importCell.getValue()) importCell.setValue("New");
    // Auto-fill "Review status" to Unchecked if blank
    const reviewCell = sheet.getRange(row, COL.REVIEW_STATUS);
    if (!reviewCell.getValue()) reviewCell.setValue("Unchecked");
  }

  // Auto-fill "Submitted by" with current user if blank
  if (col === COL.RAW_INPUT && e.value) {
    const byCell = sheet.getRange(row, COL.SUBMITTED_BY);
    if (!byCell.getValue()) {
      byCell.setValue(Session.getActiveUser().getEmail() || "unknown");
    }
  }
}
