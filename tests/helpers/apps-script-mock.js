/** Minimal Apps Script service mocks for running calendar-apps-script/Code.gs in Node. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "../../calendar-apps-script/Code.gs"), "utf8");
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function makeSheet(name, rows, faults) {
  const data = rows.map(r => r.slice());
  const sheet = {
    name, hidden: false, data,
    getName: () => name,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getLastRow: () => { let n = data.length; while (n > 0 && !(data[n - 1] || []).some(v => v !== "" && v != null)) n--; return n; },
    getLastColumn: () => Math.max(1, ...data.map(r => r.length)),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((data[r - 1 + i] || [])[c - 1 + j] ?? ""))),
        setValue: (v) => { faults.tick(`${name}.setValue`); while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
        setValues: (vals) => { faults.tick(`${name}.setValues`); vals.forEach((row, i) => row.forEach((v, j) => { while (data.length < r + i) data.push([]); data[r - 1 + i][c - 1 + j] = v; })); },
        setWrap: () => {},
      };
    },
    appendRow: (row) => { faults.tick(`${name}.appendRow`); data.push(row.slice()); },
    setRowHeight: () => {},
    hideSheet() { this.hidden = true; },
  };
  return sheet;
}

/**
 * @param {object} opts { secret, month (0-11) }
 * faults.failAt(label, nth): throw on the nth call of that operation (counting from 1)
 */
function loadCodeGs({ secret = "apps-script-test-secret-1234567890", month = 9 } = {}) {
  const counters = {}; const plans = [];
  const faults = {
    tick(label) {
      counters[label] = (counters[label] || 0) + 1;
      for (const p of plans) if (!p.used && (p.label === label || p.label === "*") && (p.label === "*" ? ++p.seen === p.nth : counters[label] === p.nth)) {
        p.used = true; throw new Error("injected failure at " + label);
      }
    },
    failAt(label, nth = 1) { plans.push({ label, nth, used: false, seen: 0 }); },
    clear() { plans.length = 0; for (const k of Object.keys(counters)) delete counters[k]; },
    counters,
  };
  const sheets = {};
  for (const m of [MONTHS[month], MONTHS[(month + 1) % 12]]) {
    sheets[m] = makeSheet(m, [["intro"], ["No.", "Title", "Thumbnail Title", "Script", "Link sample", "Note", "Status", "Uploaded", "Caption"], [1, "Existing", "", "old", "", "", "", "", ""]], faults);
  }
  const ss = {
    getName: () => "Synthetic script sheet",
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n, [], faults)),
  };
  let currentMonth = month;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else { super(); this.setMonth(currentMonth, 1); } }
  }
  const ctx = {
    Date: FakeDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "SCRIPT_SECRET" ? secret : null) }) },
    Utilities: { DigestAlgorithm: { SHA_256: "sha256" }, computeDigest: (_, s) => Array.from(crypto.createHash("sha256").update(String(s)).digest()) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() { faults.tick("flush"); } },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ "x-script-secret": secret, ...body }) } }).text);
  return { ctx, sheets, faults, post, monthName: (m) => MONTHS[m], setMonth: (m) => { currentMonth = m; } };
}

module.exports = { loadCodeGs, MONTHS };
