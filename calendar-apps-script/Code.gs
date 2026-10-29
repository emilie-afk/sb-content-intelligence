// ============================================================
// SB Script Export — Google Apps Script
// POST only (secret in the body):
//   { action: "append",  ... }  → appends one approved script to the current month tab
//                                 (idempotent per export_id via the hidden _exports tab)
//   { action: "history" }       → returns all entries for repetition checking
//
// Sheet structure expected in each month tab:
//   Row ~15: headers — No. | Style | Title | Script | Link sample | Note | Status
//   Rows below: one script per row
//
// How to deploy:
//   1. Open the script Google Sheet → Extensions → Apps Script
//   2. Paste this entire file into Code.gs, replacing any existing code
//   3. Click Deploy → New deployment
//   4. Type: Web app | Execute as: Me | Who has access: Anyone
//   5. Click Deploy → copy the Web app URL
//   6. Store the Web app URL privately (Supabase SQL editor, see docs/SECURITY-ROLLOUT.md);
//      never in the repository or the dashboard page
//   7. Script Property SCRIPT_SECRET (REQUIRED, 32+ random characters) = the value of
//      CALENDAR_SCRIPT_SECRET in Netlify. Without it every request is refused.
//
// Updating an existing deployment: Deploy → Manage deployments → edit (pencil) →
// Version: New version → Deploy. The URL stays the same.
// For a new year: deploy the same script on the new year's sheet and update the
// private config (docs/SECURITY-ROLLOUT.md).
// ============================================================

var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];

// ── Shared-secret guard ───────────────────────────────────────────────────────
// Netlify sends the secret in the POST body as "x-script-secret".
// SCRIPT_SECRET (Apps Script → Project Settings → Script Properties) is REQUIRED:
// when it is missing every request is refused (no unauthenticated setup mode).
function checkSecret(data) {
  var expected = PropertiesService.getScriptProperties().getProperty('SCRIPT_SECRET');
  if (!expected || expected.length < 16) throw new Error('Unauthorized');
  var given = (data && typeof data['x-script-secret'] === 'string') ? data['x-script-secret'] : '';
  // compare digests so the comparison time doesn't depend on the secret
  var a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given);
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, expected);
  if (a.join(',') !== b.join(',')) throw new Error('Unauthorized');
}

var LIMITS = { title: 300, thumbnail_title: 300, script_text: 20000, caption: 5000, platform: 50, export_id: 100 };

function field(data, name) {
  var v = data[name];
  if (v === undefined || v === null) return '';
  v = String(v);
  if (v.length > LIMITS[name]) throw new Error(name + ' is too long');
  return v;
}

// Text that starts with = + - @ would be treated as a formula by Sheets.
function safe(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON' });
  }
  try {
    checkSecret(data);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Unauthorized' });
  }
  var action = data.action || 'append'; // older Netlify code sends no action (append only)
  try {
    if (action === 'history') return jsonResponse(readHistory());
    if (action === 'append') return jsonResponse(appendScript(data));
    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message || 'Error').slice(0, 200) });
  }
}

// GET is disabled: a secret in a query string ends up in logs and browser history.
function doGet(e) {
  return jsonResponse({ success: false, error: 'Unauthorized' });
}

// ── Exports ledger (hidden tab) so the same script is never appended twice ───
function exportsSheet(ss) {
  var sh = ss.getSheetByName('_exports');
  if (!sh) {
    sh = ss.insertSheet('_exports');
    sh.getRange(1, 1, 1, 3).setValues([['export_id', 'placed', 'exported_at']]);
    sh.hideSheet();
  }
  return sh;
}

function findExport(sh, exportId) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var values = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === exportId) return String(values[i][1]);
  }
  return null;
}

function appendScript(data) {
  var title           = field(data, 'title');
  var thumbnail_title = field(data, 'thumbnail_title');
  var script_text     = field(data, 'script_text');
  var caption         = field(data, 'caption');
  var platform        = field(data, 'platform');
  var exportId        = field(data, 'export_id');
  var note            = platform ? 'Platform: ' + platform : '';
  if (!title) throw new Error('title is required');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // one append at a time → no duplicate row numbers / rows
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ledger = exportsSheet(ss);
    if (exportId) {
      var already = findExport(ledger, exportId);
      if (already) return { success: true, duplicate: true, placed: already };
    }

    var monthName = MONTHS[new Date().getMonth()];
    var sheet     = ss.getSheetByName(monthName);
    if (!sheet) throw new Error('Sheet not found: ' + monthName);

    var header = findHeaderRow(sheet);
    if (!header) throw new Error('Could not find header row in ' + monthName);
    var cols = getColumnMap(sheet, header.row, header.startCol);

    var lastDataRow = findLastDataRow(sheet, header.row);
    var nextNum     = lastDataRow > header.row ? lastDataRow - header.row : 1;
    var newRow      = lastDataRow + 1;

    // Headers: No. | Title | Thumbnail Title | Script | Link sample | Note | Status | Uploaded | Caption
    if (cols['no.'])             sheet.getRange(newRow, cols['no.']).setValue(nextNum);
    if (cols['title'])           sheet.getRange(newRow, cols['title']).setValue(safe(title));
    if (cols['thumbnail title']) sheet.getRange(newRow, cols['thumbnail title']).setValue(safe(thumbnail_title));
    if (cols['script'])          sheet.getRange(newRow, cols['script']).setValue(safe(script_text));
    if (cols['link sample'])     sheet.getRange(newRow, cols['link sample']).setValue('');
    if (cols['note'])            sheet.getRange(newRow, cols['note']).setValue(safe(note));
    if (cols['status'])          sheet.getRange(newRow, cols['status']).setValue('');
    if (cols['uploaded'])        sheet.getRange(newRow, cols['uploaded']).setValue('');
    if (cols['caption'])         sheet.getRange(newRow, cols['caption']).setValue(safe(caption));
    if (cols['script'])          sheet.getRange(newRow, cols['script']).setWrap(true);
    sheet.setRowHeight(newRow, 21);

    var placed = monthName + ' row ' + newRow;
    if (exportId) ledger.appendRow([exportId, placed, new Date()]);
    SpreadsheetApp.flush();
    return { success: true, placed: placed, number: nextNum };
  } finally {
    lock.releaseLock();
  }
}

// ── Find the row that contains "No." ─────────────────────────────────
function findHeaderRow(sheet) {
  var data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      if (data[r][c].toString().trim() === 'No.') {
        return { row: r + 1, startCol: c + 1 }; // 1-indexed
      }
    }
  }
  return null;
}


// ── Map lowercased header names to column indices ─────────────────────
function getColumnMap(sheet, headerRow, startCol) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(headerRow, startCol, 1, lastCol - startCol + 1).getValues()[0];
  var map     = {};
  headers.forEach(function(h, i) {
    map[h.toString().toLowerCase().trim()] = startCol + i;
  });
  return map;
}


// ── Find the last row that has data after the header ──────────────────
function findLastDataRow(sheet, headerRow) {
  var lastRow   = sheet.getLastRow();
  var lastDataR = headerRow;
  for (var r = headerRow + 1; r <= lastRow; r++) {
    var rowData = sheet.getRange(r, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (rowData.some(function(v) { return v !== ''; })) {
      lastDataR = r;
    }
  }
  return lastDataR;
}


// ── Helpers ───────────────────────────────────────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── History: all content entries (all month tabs) for repetition checking ────
function readHistory() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var entries = [];

  MONTHS.forEach(function(monthName) {
    var sheet = ss.getSheetByName(monthName);
    if (!sheet) return;

    var header = findHeaderRow(sheet);
    if (!header) return;

    var cols    = getColumnMap(sheet, header.row, header.startCol);
    var lastRow = findLastDataRow(sheet, header.row);

    for (var r = header.row + 1; r <= lastRow; r++) {
      var rowData = sheet.getRange(r, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (!rowData.some(function(v) { return v !== ''; })) continue;

      var getCol = function(key) {
        var idx = cols[key];
        return idx ? String(rowData[idx - 1] || '').trim() : '';
      };

      var title = getCol('title');
      if (!title) continue;

      entries.push({
        month:  monthName,
        no:     getCol('no.'),
        title:  title,
        style:  getCol('style'),
        script: getCol('script').slice(0, 300), // first 300 chars only
        link:   getCol('link sample'),
        note:   getCol('note'),
        status: getCol('status'),
      });
    }
  });

  return { success: true, entries: entries, sheet: ss.getName() };
}
