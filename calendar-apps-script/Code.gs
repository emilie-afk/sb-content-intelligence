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

// ── Exports ledger (hidden tab "_exports") ───────────────────────────────────
// One ledger row per export id:  export_id | sheet | row | number | status | updated_at
// The target row is RESERVED (and flushed) before any content cell is written, then
// marked "complete". A retry of the same export id after any failure re-fills that same
// reserved row (also across a month change) instead of allocating a new one, and a
// completed export is never written again. The script lock serialises overlapping calls.
var LEDGER_HEADERS = ['export_id', 'sheet', 'row', 'number', 'status', 'updated_at'];

function exportsSheet(ss) {
  var sh = ss.getSheetByName('_exports');
  if (!sh) {
    sh = ss.insertSheet('_exports');
    sh.getRange(1, 1, 1, LEDGER_HEADERS.length).setValues([LEDGER_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}

function ledgerEntries(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, LEDGER_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    out.push({ ledgerRow: i + 2, id: String(values[i][0]), sheet: String(values[i][1]),
               row: Number(values[i][2]), number: values[i][3], status: String(values[i][4]) });
  }
  return out;
}

function findExport(entries, exportId) {
  for (var i = 0; i < entries.length; i++) if (entries[i].id === exportId) return entries[i];
  return null;
}

// highest row already reserved in a month tab (a reserved row may still be empty)
function maxReservedRow(entries, sheetName) {
  var max = 0;
  for (var i = 0; i < entries.length; i++) if (entries[i].sheet === sheetName && entries[i].row > max) max = entries[i].row;
  return max;
}

function writeScriptRow(sheet, cols, row, number, f) {
  if (cols['no.'])             sheet.getRange(row, cols['no.']).setValue(number);
  if (cols['title'])           sheet.getRange(row, cols['title']).setValue(safe(f.title));
  if (cols['thumbnail title']) sheet.getRange(row, cols['thumbnail title']).setValue(safe(f.thumbnail_title));
  if (cols['script'])          sheet.getRange(row, cols['script']).setValue(safe(f.script_text));
  if (cols['link sample'])     sheet.getRange(row, cols['link sample']).setValue('');
  if (cols['note'])            sheet.getRange(row, cols['note']).setValue(safe(f.note));
  if (cols['status'])          sheet.getRange(row, cols['status']).setValue('');
  if (cols['uploaded'])        sheet.getRange(row, cols['uploaded']).setValue('');
  if (cols['caption'])         sheet.getRange(row, cols['caption']).setValue(safe(f.caption));
  if (cols['script'])          sheet.getRange(row, cols['script']).setWrap(true);
  sheet.setRowHeight(row, 21);
}

function appendScript(data) {
  var f = {
    title:           field(data, 'title'),
    thumbnail_title: field(data, 'thumbnail_title'),
    script_text:     field(data, 'script_text'),
    caption:         field(data, 'caption'),
    platform:        field(data, 'platform'),
  };
  var exportId = field(data, 'export_id');
  f.note = f.platform ? 'Platform: ' + f.platform : '';
  if (!f.title) throw new Error('title is required');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // one export at a time
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ledger = exportsSheet(ss);
    var entries = exportId ? ledgerEntries(ledger) : [];
    var entry = exportId ? findExport(entries, exportId) : null;

    if (entry && entry.status === 'complete') {
      return { success: true, duplicate: true, placed: entry.sheet + ' row ' + entry.row, number: entry.number };
    }

    var sheet, cols, row, number;
    if (entry) {
      // repair the reserved row of an earlier, interrupted attempt
      sheet = ss.getSheetByName(entry.sheet);
      if (!sheet) throw new Error('Sheet not found: ' + entry.sheet);
      var h0 = findHeaderRow(sheet);
      if (!h0) throw new Error('Could not find header row in ' + entry.sheet);
      cols = getColumnMap(sheet, h0.row, h0.startCol);
      row = entry.row; number = entry.number;
    } else {
      var monthName = MONTHS[new Date().getMonth()];
      sheet = ss.getSheetByName(monthName);
      if (!sheet) throw new Error('Sheet not found: ' + monthName);
      var header = findHeaderRow(sheet);
      if (!header) throw new Error('Could not find header row in ' + monthName);
      cols = getColumnMap(sheet, header.row, header.startCol);
      var lastDataRow = Math.max(findLastDataRow(sheet, header.row), maxReservedRow(entries, monthName));
      number = lastDataRow > header.row ? lastDataRow - header.row : 1;   // numbering unchanged
      row = lastDataRow + 1;
      if (exportId) {
        ledger.appendRow([exportId, monthName, row, number, 'reserved', new Date()]);
        SpreadsheetApp.flush(); // reservation is durable before any content is written
        entry = findExport(ledgerEntries(ledger), exportId);
        if (!entry || entry.row !== row) throw new Error('Could not reserve the export row');
      }
    }

    writeScriptRow(sheet, cols, row, number, f);
    SpreadsheetApp.flush();
    if (exportId) {
      ledger.getRange(entry.ledgerRow, 5, 1, 2).setValues([['complete', new Date()]]);
      SpreadsheetApp.flush();
    }
    return { success: true, placed: sheet.getName() + ' row ' + row, number: number };
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
