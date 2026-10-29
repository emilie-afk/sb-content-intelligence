/**
 * Runs calendar-apps-script/Code.gs against minimal Apps Script service mocks.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "../../calendar-apps-script/Code.gs"), "utf8");
const SECRET = "apps-script-test-secret-1234567890";

function makeSheet(name, rows) {
  const data = rows.map(r => r.slice());
  return {
    name, hidden: false, data,
    getName: () => name,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(1, ...data.map(r => r.length)),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((data[r - 1 + i] || [])[c - 1 + j] ?? ""))),
        setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
        setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => { while (data.length < r + i) data.push([]); data[r - 1 + i][c - 1 + j] = v; })),
        setWrap: () => {},
      };
    },
    appendRow: (row) => data.push(row.slice()),
    setRowHeight: () => {},
    hideSheet() { this.hidden = true; },
  };
}

function load({ secret = SECRET } = {}) {
  const month = ["January","February","March","April","May","June","July","August","September","October","November","December"][new Date().getMonth()];
  const sheets = { [month]: makeSheet(month, [["intro"], ["No.", "Title", "Thumbnail Title", "Script", "Link sample", "Note", "Status", "Uploaded", "Caption"], [1, "Existing", "", "old script", "", "", "", "", ""]]) };
  const ss = {
    getName: () => "Synthetic script sheet",
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n, [])),
  };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "SCRIPT_SECRET" ? secret : null) }) },
    Utilities: { DigestAlgorithm: { SHA_256: "sha256" }, computeDigest: (_, s) => Array.from(crypto.createHash("sha256").update(String(s)).digest()) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, sheets, month, post };
}

test("missing or wrong SCRIPT_SECRET denies reads and writes", () => {
  for (const secret of [null, "", "short"]) {
    const { post, sheets, month } = load({ secret });
    assert.strictEqual(post({ action: "history", "x-script-secret": secret || "" }).error, "Unauthorized");
    assert.strictEqual(post({ action: "append", title: "x", "x-script-secret": secret || "" }).error, "Unauthorized");
    assert.strictEqual(sheets[month].data.length, 3);
  }
  const { post, ctx } = load();
  assert.strictEqual(post({ action: "history", "x-script-secret": "wrong" }).error, "Unauthorized");
  assert.strictEqual(JSON.parse(ctx.doGet({ parameter: { secret: SECRET } }).text).error, "Unauthorized", "GET with a query secret is disabled");
});

test("append is idempotent per export_id and neutralises formulas", () => {
  const { post, sheets, month } = load();
  const body = { action: "append", "x-script-secret": SECRET, export_id: "id-1", title: "=IMPORTXML(\"x\")", script_text: "Hook. Body", caption: "+cap", platform: "TikTok" };
  const a = post(body);
  assert.strictEqual(a.success, true);
  const b = post(body);
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(b.placed, a.placed);
  const rows = sheets[month].data;
  assert.strictEqual(rows.length, 4, "exactly one row added");
  assert.strictEqual(rows[3][1], "'=IMPORTXML(\"x\")");
  assert.strictEqual(sheets._exports.hidden, true);
  assert.strictEqual(post({ action: "append", "x-script-secret": SECRET, title: "x".repeat(301) }).success, false);
  assert.strictEqual(post({ action: "drop", "x-script-secret": SECRET }).error, "Unknown action");
});

test("history returns entries (no URLs or secrets)", () => {
  const { post } = load();
  const h = post({ action: "history", "x-script-secret": SECRET });
  assert.strictEqual(h.success, true);
  assert.strictEqual(h.entries.length, 1);
  assert.strictEqual(h.entries[0].title, "Existing");
  assert.ok(!JSON.stringify(h).includes(SECRET));
});

test("older Netlify code (no action field) still appends after the secret check", () => {
  const { post } = load();
  assert.strictEqual(post({ "x-script-secret": SECRET, title: "Legacy" }).success, true);
});
