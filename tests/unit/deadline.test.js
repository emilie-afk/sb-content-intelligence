/**
 * R6 follow-up: the agent's run deadline with REAL timers and AbortSignals (no fake clock).
 * Covers a slow first model call, a slow later model call, slow internal batch and
 * maintenance HTTP calls, slow database tools, a genuine provider failure, bounded
 * finalisation, lock clean-up and recovery of a run the platform killed.
 */
const test = require("node:test");
const assert = require("node:assert");
const { TOKENS, setup, stubFetch, slow, event, call } = require("../helpers/harness");

const CID = "30000000-0000-0000-0000-000000000001";
const FINALIZE_MS = 1200;
const SLACK_MS = 400;          // scheduling slack on a loaded CI machine
const toolBlock = (i, name = "check_signal_queue", input = {}) => ({ type: "tool_use", id: `tu_${i}`, name, input });
const text = (t) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

async function runTimed(ev = event({ token: TOKENS.admin })) {
  const t0 = Date.now();
  const r = await call("run-agent", ev);
  return { r, elapsed: Date.now() - t0 };
}

function assertTimeout(fake, r, budget, elapsed) {
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.status, "timeout", r.raw);
  assert.strictEqual(r.body.limit, "time");
  assert.match(r.body.summary, /^Stopped at the run time limit after \d+ tool call\(s\) and \d+ batch call\(s\)\./);
  assert.ok(!r.body.error, "a deadline is not a failure");
  assert.ok(elapsed >= budget - 50, `returned early: ${elapsed} ms`);
  assert.ok(elapsed < budget + FINALIZE_MS + SLACK_MS, `took ${elapsed} ms for a ${budget} ms budget`);
  const log = fake.state.tables.agent_run_log.at(-1);
  assert.strictEqual(log.status, "timeout");
  assert.strictEqual(log.error, "stopped at time limit");
  assert.strictEqual(log.summary.text, r.body.summary);
  assert.ok(!fake.state.locks.has("agent_run"), "lock released");
}

test("slow FIRST model call is cancelled at the real 8.5 s deadline → timeout, not failed", async () => {
  const fake = setup();
  let seen = null, modelCalls = 0;
  const f = stubFetch({ claude: (_b, opts) => { modelCalls++; seen = opts.signal; return slow(60_000, opts.signal, text("late")); } });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 8500, elapsed);
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
    assert.ok(seen && seen.aborted, "the provider request itself was aborted");
    assert.strictEqual(modelCalls, 1);
    assert.strictEqual(r.body.tool_calls, 0);
    assert.strictEqual(fake.state.tables.agent_action_log.length, 0);
  } finally { f.restore(); }
});

test("slow LATER model call is cancelled; no further dispatch", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "3000" } });
  let modelCalls = 0;
  const f = stubFetch({ claude: (_b, opts) => (++modelCalls === 1
    ? { content: [toolBlock(1)], stop_reason: "tool_use" }
    : slow(60_000, opts.signal, { content: [toolBlock(2)], stop_reason: "tool_use" })) });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 3000, elapsed);
    assert.strictEqual(modelCalls, 2);
    assert.strictEqual(r.body.tool_calls, 1);
    assert.strictEqual(fake.state.tables.agent_action_log.length, 1);
  } finally { f.restore(); }
});

test("reviewer repro: 11 s process_signal_batch response is cancelled at 8.5 s; nothing dispatched after", async () => {
  const fake = setup();
  let modelCalls = 0, batchSignal = null, internalCalls = 0;
  const f = stubFetch({
    claude: () => (++modelCalls === 1
      ? { content: [toolBlock(1, "process_signal_batch"), toolBlock(2, "check_signal_queue"), toolBlock(3, "process_signal_batch")], stop_reason: "tool_use" }
      : text("should not be reached")),
    other: (url, opts) => {
      internalCalls++;
      batchSignal = opts.signal;
      return slow(11_000, opts.signal, { ok: true, status: 200, json: async () => ({ processed: 5, remaining: 0 }), text: async () => "" });
    },
  });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 8500, elapsed);
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
    assert.ok(batchSignal && batchSignal.aborted, "the internal HTTP request was aborted");
    assert.strictEqual(internalCalls, 1);
    assert.strictEqual(modelCalls, 1, "no model call after the deadline");
    assert.strictEqual(r.body.tool_calls, 1);
    assert.strictEqual(r.body.batches, 1);
    const acts = fake.state.tables.agent_action_log;
    assert.strictEqual(acts.length, 1, "the cancelled tool is logged (after the deadline, in finalisation)");
    assert.deepStrictEqual([acts[0].tool_name, acts[0].status], ["process_signal_batch", "error"]);
    assert.match(JSON.stringify(acts[0].output), /Cancelled at the run deadline/);
  } finally { f.restore(); }
});

test("slow run_maintenance_pass HTTP call is cancelled at the deadline", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "3000" } });
  let sig = null;
  const f = stubFetch({
    claude: () => ({ content: [toolBlock(1, "run_maintenance_pass")], stop_reason: "tool_use" }),
    other: (url, opts) => { sig = opts.signal; return slow(15_000, opts.signal, { ok: true, status: 200, json: async () => ({}) }); },
  });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 3000, elapsed);
    assert.ok(sig.aborted);
    assert.strictEqual(r.body.tool_calls, 1);
  } finally { f.restore(); }
});

test("slow database read tool is cancelled at the deadline", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "3000" } });
  fake.state.delays.signals = 20_000;
  let modelCalls = 0;
  const f = stubFetch({ claude: () => (++modelCalls === 1 ? { content: [toolBlock(1), toolBlock(2)], stop_reason: "tool_use" } : text("no")) });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 3000, elapsed);
    assert.ok(fake.state.aborted.some(a => a.table === "signals"), "query cancelled");
    assert.strictEqual(r.body.tool_calls, 1, "second tool never dispatched");
    assert.strictEqual(modelCalls, 1);
  } finally { f.restore(); }
});

test("slow database WRITE tool is cancelled, and the write never lands later", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "3000" } });
  fake.state.delays.cluster_review_suggestions = 5_000;
  const f = stubFetch({ claude: () => ({ content: [toolBlock(1, "suggest_review_move", { cluster_id: CID, reason: "r", confidence: "High" })], stop_reason: "tool_use" }) });
  try {
    const { r, elapsed } = await runTimed();
    assertTimeout(fake, r, 3000, elapsed);
    await new Promise(res => setTimeout(res, 2_500));  // past the injected latency
    assert.strictEqual(fake.state.tables.cluster_review_suggestions.length, 0, "no background write after cancellation");
    assert.ok(fake.state.aborted.some(a => a.table === "cluster_review_suggestions" && a.op === "insert"));
  } finally { f.restore(); }
});

test("a genuine provider failure before the deadline stays 'failed'", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "3000" } });
  const f = stubFetch({ claude: () => { throw new TypeError("fetch failed"); } });
  try {
    const { r, elapsed } = await runTimed();
    assert.strictEqual(r.body.status, "failed");
    assert.strictEqual(r.body.limit, undefined);
    assert.ok(elapsed < 1000, `${elapsed} ms`);
    assert.strictEqual(fake.state.tables.agent_run_log.at(-1).status, "failed");
    assert.ok(!fake.state.locks.has("agent_run"));
  } finally { f.restore(); }
});

test("finalisation is bounded; a run the platform killed is recovered by the next run", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "2000" } });
  fake.state.delays["agent_run_log:update"] = 30_000;
  fake.state.delays["rpc:ci_release_lock"] = 30_000;
  const f = stubFetch({ claude: (_b, opts) => slow(60_000, opts.signal, text("late")) });
  try {
    const { r, elapsed } = await runTimed();
    assert.strictEqual(r.body.status, "timeout");
    assert.ok(elapsed < 2000 + FINALIZE_MS + SLACK_MS, `finalisation not bounded: ${elapsed} ms`);
    // outcome write and lock release were cancelled → row still "running", lock held until its TTL
    assert.strictEqual(fake.state.tables.agent_run_log[0].status, "running");
    const lock = fake.state.locks.get("agent_run");
    assert.ok(lock && lock.expires - Date.now() <= 120_000, "lock TTL is at most 2 minutes");
    assert.strictEqual((await call("run-agent", event({ token: TOKENS.admin }))).status, 409);

    // later: the lock has expired and the abandoned row is older than 2 minutes
    delete fake.state.delays["agent_run_log:update"];
    delete fake.state.delays["rpc:ci_release_lock"];
    lock.expires = Date.now() - 1;
    fake.state.tables.agent_run_log[0].started_at = new Date(Date.now() - 3 * 60_000).toISOString();
    f.restore();
    const g = stubFetch({ claude: () => text("ok") });
    const r2 = await call("run-agent", event({ token: TOKENS.admin }));
    g.restore();
    assert.strictEqual(r2.body.status, "completed");
    const [old, fresh] = fake.state.tables.agent_run_log;
    assert.strictEqual(old.status, "timeout");
    assert.match(old.error, /stopped by the platform/);
    assert.strictEqual(fresh.status, "completed");
  } finally { f.restore(); }
});

test("no model call starts without enough time left (no 1 s floor)", async () => {
  const fake = setup({ env: { AGENT_RUNTIME_MS: "2000" } });
  const budgets = [];
  const f = stubFetch({ claude: async () => {
    budgets.push(Date.now());
    await new Promise(res => setTimeout(res, 700));   // 2nd call would start with < 1.5 s left
    return { content: [toolBlock(budgets.length)], stop_reason: "tool_use" };
  } });
  try {
    const { r } = await runTimed();
    assert.strictEqual(budgets.length, 1, "second model call must not start");
    assert.strictEqual(r.body.status, "timeout");
    assert.strictEqual(r.body.tool_calls, 1);
    assert.ok(!fake.state.locks.has("agent_run"));
  } finally { f.restore(); }
});

test("boundClient: the real supabase-js client aborts its HTTP request when the signal fires", async () => {
  setup();
  for (const k of Object.keys(require.cache)) if (k.includes("/netlify/")) delete require.cache[k];
  const { boundClient } = require("../../netlify/lib/supabase.js");   // real factory (createClient)
  const real = global.fetch;
  let seen = null;
  global.fetch = (url, init = {}) => { seen = init.signal; return slow(30_000, init.signal, null); };
  try {
    const t0 = Date.now();
    const res = await boundClient(AbortSignal.timeout(300)).from("agent_action_log").insert({ tool_name: "x" });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `${elapsed} ms`);
    assert.ok(seen && seen.aborted, "fetch received the aborted signal");
    assert.ok(res.error, "supabase-js reports the cancelled request as an error");
  } finally { global.fetch = real; }
});

test("deadline expiry is always 'timeout': one timer only, and any abort error after the deadline is classified as such", async () => {
  for (let i = 0; i < 5; i++) {
    // (a) the request signal is aborted by the run deadline itself (no competing per-call timer)
    let fake = setup({ env: { AGENT_RUNTIME_MS: "1600" } });
    let reason = null;
    let f = stubFetch({ claude: (_b, opts) => slow(60_000, opts.signal, null).catch(e => { reason = opts.signal.reason; throw e; }) });
    try {
      const { r } = await runTimed();
      assert.strictEqual(r.body.status, "timeout", `iteration ${i}: ${r.raw}`);
      assert.strictEqual(r.body.limit, "time");
      assert.ok(reason && reason.isDeadline, "aborted by the run deadline, not by another timer");
      assert.strictEqual(fake.state.tables.agent_run_log.at(-1).status, "timeout");
    } finally { f.restore(); }

    // (b) worst case: the provider layer fails with a generic AbortError at the deadline
    fake = setup({ env: { AGENT_RUNTIME_MS: "1600" } });
    f = stubFetch({ claude: (_b, opts) => slow(60_000, opts.signal, null).catch(() => { throw new DOMException("aborted", "AbortError"); }) });
    try {
      const { r } = await runTimed();
      assert.strictEqual(r.body.status, "timeout", `iteration ${i}: ${r.raw}`);
      assert.ok(!r.body.error);
    } finally { f.restore(); }
  }
});
