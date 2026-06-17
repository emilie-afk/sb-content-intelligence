// ============================================================
// SB Script Export — Google Apps Script
// Appends approved scripts as new rows to the current month tab.
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
//   6. In the dashboard → Scripts → ⚙ Calendar URL → paste → Save
//
// For a new year: deploy same script on the new year's sheet,
// paste the new URL in the dashboard settings.
// ============================================================

var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];


function doPost(e) {
  try {
    var data        = JSON.parse(e.postData ? e.postData.contents : '{}');
    var title       = data.title       || '';
    var style       = data.style       || '';
    var script_text = data.script_text || '';
    var platform    = data.platform    || '';

    if (!title) throw new Error('title is required');

    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var monthName = MONTHS[new Date().getMonth()];
    var sheet     = ss.getSheetByName(monthName);

    if (!sheet) throw new Error('Sheet not found: ' + monthName);

    // Find the header row (the row that contains "No." in its cells)
    var header = findHeaderRow(sheet);
    if (!header) throw new Error('Could not find header row in ' + monthName);

    // Find column positions by header name
    var cols = getColumnMap(sheet, header.row, header.startCol);

    // Count existing data rows to auto-number
    var lastDataRow = findLastDataRow(sheet, header.row);
    var nextNum     = lastDataRow > header.row ? lastDataRow - header.row : 1;
    var newRow      = lastDataRow + 1;

    // Write the row
    if (cols['no.'])         sheet.getRange(newRow, cols['no.']).setValue(nextNum);
    if (cols['style'])       sheet.getRange(newRow, cols['style']).setValue(style);
    if (cols['title'])       sheet.getRange(newRow, cols['title']).setValue(title);
    if (cols['script'])      sheet.getRange(newRow, cols['script']).setValue(script_text);
    if (cols['note'])        sheet.getRange(newRow, cols['note']).setValue(platform ? 'Platform: ' + platform : '');
    if (cols['status'])      sheet.getRange(newRow, cols['status']).setValue('');
    if (cols['link sample']) sheet.getRange(newRow, cols['link sample']).setValue('');

    // Match row height to content (auto-resize the Script column row)
    sheet.setRowHeight(newRow, 21); // let it expand naturally with wrapping

    return jsonResponse({
      success: true,
      placed:  monthName + ' row ' + newRow,
      number:  nextNum,
    });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
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

// ── GET: return all 2026 content entries for repetition checking ──────
// Called by the dashboard's repetition check (no auth required — URL is secret)
function doGet(e) {
  try {
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
        // Skip completely empty rows
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

    return jsonResponse({ success: true, entries: entries, sheet: ss.getName() });

  } catch(err) {
    return jsonResponse({ success: false, error: err.message });
  }
}
