/**
 * Endpoint × caller authorization matrix. For every Netlify Function and every
 * kind of caller, an unauthorized request must be refused (401/403) BEFORE any
 * table access, external fetch, Apps Script call or model call.
 */
const test = require("node:test");
const assert = require("node:assert");
const { SECRETS, TOKENS, SUBMIT_TOKEN, PERF_TOKEN, setup, stubFetch, event, call } = require("../helpers/harness");

const SIG = "10000000-0000-0000-0000-000000000001";
const SCRIPT = "20000000-0000-0000-0000-000000000001";

// endpoint → { body, method, allow: [identities that may call it] }
const W = ["owner", "admin", "assistant"];
const A = ["owner", "admin"];
const ALL = ["owner", "admin", "assistant", "viewer"];
const ENDPOINTS = {
  "ai-analyze":                          { body: { type: "signal", data: { topic: "synthetic" } }, allow: W, serviceAware: true },
  "ai-analyze#delete":                   { fn: "ai-analyze", body: { type: "delete_scraper_cleanup", data: {} }, allow: A, serviceAware: true },
  "ai-analyze#cluster":                  { fn: "ai-analyze", body: { type: "cluster", data: { id: SIG }, claim: "30000000-0000-0000-0000-000000000001" }, allow: [...W, "internal"] },
  "cluster-signal-background":           { body: { type: "cluster", data: { id: SIG }, claim: "30000000-0000-0000-0000-000000000001" }, allow: [...W, "internal"] },
  "ai-briefing":                         { body: {}, allow: W },
  "ai-cleanup-batch":                    { body: { dry_run: true }, allow: W },
  "batch-cluster":                       { body: {}, allow: [...A, "scheduler", "internal"] },
  "generate-learning":                   { body: {}, allow: [...A, "scheduler"] },
  "get-sheet-history":                   { body: {}, allow: W },
  "import-watchlist":                    { body: { csv: "Genus,Revenue\nEcheveria,100" }, allow: W },
  "log-published":                       { body: { postUrl: "https://example.test/p/1" }, allow: W },
  "maintenance-run":                     { body: {}, allow: [...W, "internal", "scheduler"] },
  "merge-clusters":                      { body: { winner_id: SIG, loser_id: SCRIPT }, allow: W },
  "run-agent":                           { body: {}, allow: [...W, "scheduler", "internal"] },
  "sync-video-metrics":                  { body: {}, allow: [...A, "scheduler"] },
  "write-to-sheet":                      { body: { script_id: SCRIPT }, allow: W },
  "app-config":                          { method: "GET", allow: ALL },
  "app-config#post":                     { fn: "app-config", body: { script_sheet_url: "https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit" }, allow: A },
  "prompt-versions":                     { method: "GET", allow: A },
  "update-sheet-metrics":                { body: { videos: [] }, allow: ["metrics"] },
  "submit-signal":                       { body: [{ topic: "synthetic" }], allow: ["submit"] },
  "submit-performance":                  { body: { video_url: "https://x.test/v", platform: "TikTok", snapshot_type: "24h", views: 1 }, allow: ["perf"] },
  "scheduled-agent":                     { body: {}, allow: ["scheduler"] },
  "scheduled-batch-cluster-background":  { body: {}, allow: ["scheduler"] },
};

const IDENTITIES = {
  anonymous: {},
  malformed: { token: "not-a-jwt" },
  forged:    { token: "h.forged-or-expired.sig" },
  pending:   { token: TOKENS.pending },
  revoked:   { token: TOKENS.revoked },
  viewer:    { token: TOKENS.viewer },
  assistant: { token: TOKENS.assistant },
  admin:     { token: TOKENS.admin },
  owner:     { token: TOKENS.owner },
  scheduler: { secret: SECRETS.INTERNAL_SECRET },
  internal:  { secret: SECRETS.INTERNAL_FUNCTION_SECRET },
  metrics:   { secret: SECRETS.METRICS_INGEST_SECRET },
  wrongSecret: { secret: "x".repeat(40) },
  submit:    { submit: SUBMIT_TOKEN },
  perf:      { submit: PERF_TOKEN },
  badToken:  { submit: "sbci_not_a_real_token_000000" },
  // a session token AND a service header: must be treated as a service call only
  userPlusWrongSecret: { token: TOKENS.owner, secret: "y".repeat(40) },
};

for (const [name, spec] of Object.entries(ENDPOINTS)) {
  test(`authorization matrix: ${name}`, async () => {
    for (const [who, creds] of Object.entries(IDENTITIES)) {
      const fake = setup({ tables: { signals: [{ id: SIG, topic: "s", status: "Clustering", clustering_claim: "30000000-0000-0000-0000-000000000001" }] } });
      const f = stubFetch();
      try {
        const res = await call(spec.fn || name.split("#")[0], event({ method: spec.method || "POST", body: spec.body, ...creds }));
        // A session plus a stray service header: endpoints that accept service callers
        // must treat it as a (failed) service call; user-only endpoints ignore the header.
        const acceptsService = spec.serviceAware || spec.allow.some(a => ["scheduler", "internal", "metrics"].includes(a));
        const allowed = who === "userPlusWrongSecret" ? (!acceptsService && spec.allow.includes("owner")) : spec.allow.includes(who);
        if (allowed) {
          assert.ok(![401, 403].includes(res.status), `${name} should allow ${who}, got ${res.status} ${res.raw.slice(0, 300)}`);
          assert.notStrictEqual(res.status, 500, `${name}/${who}: internal error ${res.raw.slice(0, 300)}`);
        } else {
          assert.ok([401, 403].includes(res.status), `${name} should refuse ${who}, got ${res.status} ${res.raw.slice(0, 300)}`);
          const dataCalls = fake.state.calls.filter(c => c.kind === "from");
          assert.deepStrictEqual(dataCalls, [], `${name}/${who}: table access before refusal`);
          assert.deepStrictEqual(f.calls.map(c => c.url), [], `${name}/${who}: external call before refusal`);
          assert.ok(!/supabase\.co|script\.google|docs\.google|TEMPLATE /.test(res.raw), `${name}/${who}: leaky error ${res.raw}`);
        }
      } finally {
        f.restore();
      }
    }
  });
}

test("push-to-calendar is gone for everyone and touches nothing", async () => {
  const fake = setup();
  const res = await call("push-to-calendar", event({ token: TOKENS.owner }));
  assert.strictEqual(res.status, 410);
  assert.deepStrictEqual(fake.state.calls, []);
});
