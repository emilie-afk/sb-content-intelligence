/**
 * submit-signal: optional client_submission_id (Social Submission companion) on the
 * hardened endpoint. Synthetic data only. The fake enforces the migration's UNIQUE
 * constraint and can simulate the column being absent (migration not applied yet).
 */
const test = require("node:test");
const assert = require("node:assert");
const { SUBMIT_TOKEN, setup, stubFetch, event, call } = require("../helpers/harness");

const ID1 = "3f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ID2 = "4a2d3c0f-2b3c-4d4e-9f00-1b2c3d4e5f60";
const WITH_ID = { constraints: { signals: { unique: ["client_submission_id"] } } };
const send = (body) => call("submit-signal", event({ submit: SUBMIT_TOKEN, body }));
const note = (topic, id, extra = {}) => ({ topic, is_manual: true, ...(id ? { client_submission_id: id } : {}), ...extra });

test("repeated id: stored once, retries acknowledged as already received", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  let r = await send([note("Synthetic text-only note", ID1)]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 1);
  r = await send([note("Synthetic text-only note", ID1)]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(r.body.already_received, 1);
  // Same id even if a retry's content were re-mapped differently: still one row.
  r = await send([note("Synthetic text-only note (edited)", ID1.toUpperCase())]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(fake.state.tables.signals.length, 1);
  assert.strictEqual(fake.state.tables.signals[0].client_submission_id, ID1);
  f.restore();
});

test("submission_key dedup still applies, and both keys interact safely", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  // Existing row without an id (e.g. from the intake sheet) with identical content.
  let r = await send([note("Same content", null)]);
  assert.strictEqual(r.body.inserted, 1);
  // A new id with the same content is deduplicated by submission_key and verified → 200.
  r = await send([note("Same content", ID1)]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(fake.state.tables.signals.length, 1);
  // Distinct content + distinct id → inserted.
  r = await send([note("Other content", ID2)]);
  assert.strictEqual(r.body.inserted, 1);
  assert.strictEqual(fake.state.tables.signals.length, 2);
  f.restore();
});

test("concurrent same id: the competing insert wins, this request re-checks and acknowledges", async () => {
  let injected = false;
  const fake = setup({
    ...WITH_ID,
    hooks: {
      beforeWrite(table, rows, state) {
        if (table !== "signals" || injected) return;
        injected = true; // another request stores the same id (different content) first
        state.tables.signals.push({ id: "other", topic: "racing copy", submission_key: "k-other", client_submission_id: ID1, status: "New" });
      },
    },
  });
  const f = stubFetch();
  const r = await send([note("Racing note", ID1), note("Unrelated new row", ID2)]);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.already_received, 1);
  assert.strictEqual(r.body.inserted, 1, "the other new row in the batch is not lost");
  assert.strictEqual(fake.state.tables.signals.filter(s => s.client_submission_id === ID1).length, 1);
  assert.ok(fake.state.tables.signals.some(s => s.client_submission_id === ID2));
  f.restore();
});

test("an unrelated uniqueness violation is never acknowledged", async () => {
  const fake = setup({ constraints: { signals: { unique: ["client_submission_id", "search_tag"] } },
    tables: { signals: [{ id: "x", topic: "old", submission_key: "k-old", search_tag: "dup-tag", status: "New" }] } });
  const f = stubFetch();
  const r = await send([note("New note with clashing tag", ID1, { search_tag: "dup-tag" })]);
  assert.strictEqual(r.status, 500);
  assert.notStrictEqual(r.body.success, true);
  assert.strictEqual(fake.state.tables.signals.length, 1);
  f.restore();
});

test("migration not applied: rows with an id fail safely (503), callers without ids still work", async () => {
  const fake = setup({ constraints: { signals: { missing: ["client_submission_id"] } } });
  const f = stubFetch();
  let r = await send([note("Needs the new column", ID1)]);
  assert.strictEqual(r.status, 503);
  assert.notStrictEqual(r.body.success, true);
  assert.strictEqual(fake.state.tables.signals.length, 0, "nothing saved");
  r = await send([note("Old caller without id", null), { source_url: "https://www.instagram.com/p/SYNTH9/", plant_shown: "Haworthia" }]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 2);
  assert.ok(fake.state.tables.signals.every(s => !("client_submission_id" in s)), "old callers never touch the column");
  f.restore();
});

test("overlapping batches: known ids skipped, new rows kept, exact duplicates within a batch collapsed", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  await send([note("Batch A1", ID1)]);
  const r = await send([note("Batch A1", ID1), note("Batch B1", ID2), note("Batch B1", ID2), note("No id row", null)]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 2, "B1 and the no-id row");
  assert.strictEqual(r.body.already_received, 1);
  assert.strictEqual(r.body.skipped, 2, "A1 (already stored) and the exact B1 duplicate");
  assert.strictEqual(fake.state.tables.signals.filter(s => s.client_submission_id === ID2).length, 1);
  assert.strictEqual(fake.state.tables.signals.length, 3);
  f.restore();
});

test("skipped rows are verified before acknowledgement", async () => {
  // ON CONFLICT skips the row because its submission_key exists at insert time; that row is
  // gone before verification (e.g. deleted concurrently) → never acknowledged as saved.
  setup({
    ...WITH_ID,
    hooks: {
      beforeWrite(table, rows, state) {
        if (table !== "signals") return;
        const first = (Array.isArray(rows) ? rows : [rows])[0];
        state.tables.signals.push({ id: "ghost", submission_key: first.submission_key, status: "New" });
      },
      afterWrite(table, rows, state) {
        if (table === "signals") state.tables.signals = state.tables.signals.filter(s => s.id !== "ghost");
      },
    },
  });
  const f = stubFetch();
  const r = await send([note("Ghost-conflicted note", ID1)]);
  assert.strictEqual(r.status, 500, JSON.stringify(r.body));
  assert.notStrictEqual(r.body.success, true);
  f.restore();
});

test("invalid ids are ignored (row still stored by content key), never stored", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  const r = await send([note("Bad id note", "not-a-uuid"), note("Injected", "'; drop table signals; --")]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 2);
  assert.ok(fake.state.tables.signals.every(s => !s.client_submission_id));
  f.restore();
});

test("ambiguous batches are refused, never partly acknowledged", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  let r = await send([note("first", ID1), note("second, different", ID1)]);
  assert.strictEqual(r.status, 400, "same id, different content");
  r = await send([note("same content", ID1), note("same content", ID2)]);
  assert.strictEqual(r.status, 400, "same content, different ids");
  assert.strictEqual(fake.state.tables.signals.length, 0, "nothing saved");
  f.restore();
});

test("large re-sends are checked in chunks (no oversized .in() query)", async () => {
  const fake = setup(WITH_ID); const f = stubFetch();
  const crypto = require("crypto");
  const batch = Array.from({ length: 180 }, (_, i) => note("bulk note " + i, crypto.randomUUID()));
  let r = await send(batch);
  assert.strictEqual(r.body.inserted, 180);
  const before = fake.state.calls.length;
  r = await send(batch);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(r.body.already_received, 180);
  const idQueries = fake.state.calls.slice(before).filter(c => c.kind === "from" && c.table === "signals" && c.op === "select").length;
  assert.ok(idQueries >= 4, "180 ids looked up in chunks of 50");
  f.restore();
});
