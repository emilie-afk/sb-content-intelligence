/**
 * R4: an export interrupted at ANY stage leaves exactly one complete row after retry.
 */
const test = require("node:test");
const assert = require("node:assert");
const { loadCodeGs } = require("../helpers/apps-script-mock");

const BODY = { action: "append", export_id: "script-1", title: "Stop the stretch", thumbnail_title: "Stretch", script_text: "Hook. Body.", caption: "cap", platform: "TikTok" };

function scriptRows(sheet) {
  return sheet.data.slice(2).filter(r => (r || []).some(v => v !== "" && v != null));
}
function assertOneCompleteRow(env, monthName) {
  const rows = scriptRows(env.sheets[monthName]);
  const mine = rows.filter(r => r[1] === BODY.title);
  assert.strictEqual(mine.length, 1, `rows for this export in ${monthName}: ${mine.length}`);
  const r = mine[0];
  assert.deepStrictEqual([r[1], r[2], r[3], r[5], r[8]], [BODY.title, BODY.thumbnail_title, BODY.script_text, "Platform: TikTok", BODY.caption]);
  const ledger = env.sheets._exports.data.slice(1).filter(x => x[0] === BODY.export_id);
  assert.strictEqual(ledger.length, 1, "one ledger entry");
  assert.strictEqual(ledger[0][4], "complete");
}

// every failure point inside one export: ledger append, flush #1 (reservation),
// each content cell, flush #2, ledger completion
const POINTS = [
  ["_exports.appendRow", 1],
  ["flush", 1],
  ...Array.from({ length: 9 }, (_, i) => ["October.setValue", i + 1]),
  ["flush", 2],
  ["_exports.setValues", 1],
  ["flush", 3],
];

for (const [label, nth] of POINTS) {
  test(`export interrupted at ${label} #${nth} → retry leaves exactly one complete row`, () => {
    const env = loadCodeGs({ month: 9 });
    env.post({ action: "append", export_id: "warmup", title: "Warm-up" }); // creates the ledger tab
    env.faults.clear();
    env.faults.failAt(label, nth);
    const first = env.post(BODY);
    env.faults.clear();
    const second = env.post(BODY);
    assert.strictEqual(second.success, true, JSON.stringify(second));
    if (first.success) assert.strictEqual(second.duplicate, true);
    const third = env.post(BODY);
    assert.strictEqual(third.duplicate, true);
    assertOneCompleteRow(env, "October");
    // the next export still gets its own new row
    const next = env.post({ ...BODY, export_id: "script-2", title: "Next one" });
    assert.notStrictEqual(next.placed, second.placed);
  });
}

test("retry after a month change repairs the reserved row in the original month", () => {
  const env = loadCodeGs({ month: 9 });
  env.faults.failAt("October.setValue", 3);
  assert.strictEqual(env.post(BODY).success, false);
  env.faults.clear();
  env.setMonth(10);
  const r = env.post(BODY);
  assert.strictEqual(r.success, true);
  assert.match(r.placed, /^October row /);
  assertOneCompleteRow(env, "October");
  assert.strictEqual(scriptRows(env.sheets.November).filter(x => x[1] === BODY.title).length, 0);
});

test("overlapping / repeated calls for different exports never share a row", () => {
  const env = loadCodeGs({ month: 9 });
  env.faults.failAt("October.setValue", 1); // first export reserves a row, writes nothing
  assert.strictEqual(env.post(BODY).success, false);
  env.faults.clear();
  const other = env.post({ ...BODY, export_id: "script-9", title: "Other" });
  const retry = env.post(BODY);
  assert.notStrictEqual(other.placed, retry.placed, "a reserved but empty row is not reused by another export");
  assertOneCompleteRow(env, "October");
});
