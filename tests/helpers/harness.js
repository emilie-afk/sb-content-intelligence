/** Shared setup for Netlify Function tests (synthetic data only). */
const path = require("path");
const crypto = require("crypto");
const { createFake } = require("./fake-supabase");

const ROOT = path.resolve(__dirname, "../..");
const FN = (name) => path.join(ROOT, "netlify/functions", name + ".js");

const SECRETS = {
  INTERNAL_SECRET:          "test-scheduler-secret-0123456789abcdef",
  INTERNAL_FUNCTION_SECRET: "test-internal-secret-0123456789abcdef",
  METRICS_INGEST_SECRET:    "test-metrics-secret-0123456789abcdef",
  CALENDAR_SCRIPT_SECRET:   "test-apps-script-secret-0123456789ab",
};

const USERS = {
  owner:     { id: "00000000-0000-0000-0000-0000000000a1", role: "owner",     access_status: "approved" },
  admin:     { id: "00000000-0000-0000-0000-0000000000a2", role: "admin",     access_status: "approved" },
  assistant: { id: "00000000-0000-0000-0000-0000000000a3", role: "assistant", access_status: "approved" },
  viewer:    { id: "00000000-0000-0000-0000-0000000000a4", role: "viewer",    access_status: "approved" },
  pending:   { id: "00000000-0000-0000-0000-0000000000a5", role: "viewer",    access_status: "pending" },
  revoked:   { id: "00000000-0000-0000-0000-0000000000a6", role: "assistant", access_status: "revoked" },
};
// tokens are opaque test strings shaped like JWTs (3 dot-separated parts)
const TOKENS = Object.fromEntries(Object.keys(USERS).map(k => [k, `h.${k}-session.sig`]));
const SUBMIT_TOKEN = "sbci_test_submit_signal_token_1234567890";
const PERF_TOKEN = "sbci_test_performance_token_1234567890";

function allTemplates() {
  const keys = require(path.join(ROOT, "netlify/lib/prompt-keys.json"));
  const placeholders = Array.from({ length: 40 }, (_, i) => `{{${i}}}`).join("|");
  return { format: 1, templates: Object.fromEntries(keys.map(k => [k, `TEMPLATE ${k} ${placeholders}`])) };
}

function setEnv(extra = {}) {
  delete process.env.SCRIPT_SHEET_TOKEN;
  delete process.env.SCRIPT_SHEET_HOOK_URL;
  delete process.env.ALLOWED_ORIGIN;
  delete process.env.AGENT_RUNTIME_MS;
  Object.assign(process.env, {
    SUPABASE_URL: "https://test-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    CLAUDE_API_KEY: "test-claude-key",
    URL: "https://example-site.netlify.app",
    GOOGLE_VIDEO_TRACKER_ID: "",
    GOOGLE_SERVICE_ACCOUNT_JSON: "",
    ...SECRETS,
    ...extra,
  });
}

/** Fresh fake DB + fresh module instances for one test. */
function setup({ env = {}, withPrompts = true, tables = {}, maintenance = false, constraints, hooks } = {}) {
  setEnv(env);
  for (const k of Object.keys(require.cache)) if (k.includes("/netlify/")) delete require.cache[k];
  const sessions = {}, profiles = {};
  for (const [k, u] of Object.entries(USERS)) {
    sessions[TOKENS[k]] = { id: u.id, email: `${k}@example.test`, user_metadata: { role: "owner" } };
    profiles[u.id] = { ...u, email: `${k}@example.test` };
  }
  const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
  const fake = createFake({
    sessions, profiles, maintenance, constraints, hooks,
    promptSet: withPrompts ? allTemplates() : null,
    tables: {
      submission_tokens: [
        { id: "t1", label: "intake", token_hash: hash(SUBMIT_TOKEN), allowed_action: "submit_signal", active: true, rate_limit_per_hour: 500 },
        { id: "t2", label: "perf", token_hash: hash(PERF_TOKEN), allowed_action: "submit_performance_snapshot", active: true, rate_limit_per_hour: 100 },
      ],
      ci_integration_config: [{ key: "script_apps_script", value: { url: "https://script.google.com/macros/s/TEST_DEPLOYMENT_ID_000000000000/exec" } }],
      ...tables,
    },
  });
  require(path.join(ROOT, "netlify/lib/supabase.js")).__setFactory((url, key, opts) => (opts && opts.signal ? fake.clientFor(opts.signal) : fake.client));
  require(path.join(ROOT, "netlify/lib/prompts.js")).__cache.clear();
  return fake;
}

/** fetch stub: records calls, answers Claude and Apps Script with programmable bodies. */
function stubFetch({ claude = () => ({ content: [{ text: '{"ok":true}' }], stop_reason: "end_turn" }), appsScript = () => ({ success: true, entries: [] }), other } = {}) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.startsWith("https://api.anthropic.com/")) {
      const out = await claude(body, opts);
      return { ok: true, status: 200, json: async () => out };
    }
    if (u.startsWith("https://script.google.com/")) {
      const out = appsScript(body);
      return { ok: true, status: 200, headers: new Map(), body: null, text: async () => JSON.stringify(out) };
    }
    if (other) return other(u, opts);
    return { ok: true, status: 202, json: async () => ({}) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

/** Real-timer latency that honours an AbortSignal (rejects with its reason, like fetch). */
function slow(ms, signal, value) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => resolve(typeof value === "function" ? value() : value), ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

function event({ method = "POST", token, secret, submit, body, query } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (secret) headers["x-internal-secret"] = secret;
  if (submit) headers["x-submission-token"] = submit;
  return { httpMethod: method, headers, body: body === undefined ? "" : (typeof body === "string" ? body : JSON.stringify(body)), queryStringParameters: query || null };
}

async function call(name, ev) {
  const mod = require(FN(name));
  const res = await mod.handler(ev, {});
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, raw: res.body || "" };
}

module.exports = { ROOT, SECRETS, USERS, TOKENS, SUBMIT_TOKEN, PERF_TOKEN, setup, stubFetch, slow, event, call, allTemplates };
