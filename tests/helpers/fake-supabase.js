/**
 * In-memory stand-in for the service-role Supabase client used by the Netlify
 * Functions. Implements auth.getUser, the ci_* RPCs (same semantics as the SQL
 * migration) and a chainable query builder. Records every call so tests can
 * prove that unauthorized requests never touch data. Synthetic data only.
 */
const crypto = require("crypto");

function createFake({ sessions = {}, profiles = {}, tables = {}, promptSet = null, maintenance = false } = {}) {
  const state = {
    sessions, profiles, maintenance,
    tables: JSON.parse(JSON.stringify(tables)),
    usage: new Map(), locks: new Map(), calls: [],
  };
  for (const t of ["signals", "script_outputs", "briefs", "published_videos", "performance_snapshots", "submission_tokens",
                   "ci_prompt_versions", "ci_integration_config", "activity_log", "plant_watchlist", "brand_content_rules",
                   "settings", "learning_memory", "discovery_clusters", "opportunities", "agent_run_log", "agent_action_log",
                   "cluster_review_suggestions"]) {
    state.tables[t] = state.tables[t] || [];
  }
  if (promptSet) state.tables.ci_prompt_versions.push({ id: 1, prompt_set: "content", version: 1, is_active: true, content: promptSet });

  const consume = (subject, bucket, limit, windowSeconds, cost = 1) => {
    const key = `${subject}|${bucket}`;
    const n = (state.usage.get(key) || 0) + cost;
    if (n > limit) return false;
    state.usage.set(key, n);
    return true;
  };

  const rpcs = {
    ci_authorize({ p_user, p_roles, p_bucket, p_limit, p_window_seconds }) {
      if (state.maintenance) return { ok: false, reason: "maintenance" };
      const p = state.profiles[p_user];
      if (!p || p.access_status !== "approved") return { ok: false, reason: "not_member" };
      if (!p_roles.includes(p.role)) return { ok: false, reason: "forbidden", role: p.role };
      if (!consume("user:" + p_user, p_bucket, p_limit, p_window_seconds)) return { ok: false, reason: "rate_limited" };
      return { ok: true, role: p.role, email: p.email || null };
    },
    ci_authorize_service({ p_scope, p_bucket, p_limit, p_window_seconds }) {
      if (state.maintenance) return { ok: false, reason: "maintenance" };
      if (!consume("service:" + p_scope, p_bucket, p_limit, p_window_seconds)) return { ok: false, reason: "rate_limited" };
      return { ok: true };
    },
    ci_consume_usage({ p_subject, p_bucket, p_limit, p_window_seconds, p_cost }) {
      return consume(p_subject, p_bucket, p_limit, p_window_seconds, p_cost || 1);
    },
    ci_try_lock({ p_key, p_holder, p_ttl_seconds }) {
      const cur = state.locks.get(p_key);
      if (cur && cur.expires > Date.now()) return false;
      state.locks.set(p_key, { holder: p_holder, expires: Date.now() + p_ttl_seconds * 1000 });
      return true;
    },
    ci_release_lock({ p_key, p_holder }) {
      const cur = state.locks.get(p_key);
      if (cur && cur.holder === p_holder) state.locks.delete(p_key);
      return null;
    },
    ci_consume_submission_token({ p_hash, p_action }) {
      const t = state.tables.submission_tokens.find(x => x.token_hash === p_hash);
      if (!t || !t.active) return { ok: false, reason: "invalid" };
      if (t.allowed_action !== p_action) return { ok: false, reason: "wrong_action" };
      t.requests_this_hour = (t.requests_this_hour || 0) + 1;
      if (t.requests_this_hour > (t.rate_limit_per_hour || 500)) return { ok: false, reason: "rate_limited" };
      return { ok: true, id: t.id, label: t.label };
    },
    ci_claim_signal({ p_id, p_claim, p_expected }) {
      const s = state.tables.signals.find(x => x.id === p_id);
      if (!s) return null;
      if (p_expected) {
        if (s.status === "Clustering" && s.clustering_claim === p_expected) { s.clustering_claim = p_claim; return "Clustering"; }
        return null;
      }
      if (s.status === "Clustering" && s.clustering_claimed_at && Date.now() - s.clustering_claimed_at < 15 * 60000) return null;
      const prev = s.status;
      Object.assign(s, { status: "Clustering", clustering_claim: p_claim, clustering_claimed_at: Date.now() });
      return prev;
    },
    ci_claim_signals_for_clustering({ p_limit, p_claim }) {
      const rows = state.tables.signals.filter(s => s.status === "New").slice(0, p_limit);
      rows.forEach(s => Object.assign(s, { status: "Clustering", clustering_claim: p_claim, clustering_claimed_at: Date.now() }));
      return rows.map(r => ({ ...r }));
    },
    ci_create_prompt_version({ p_content, p_activate }) {
      const id = state.tables.ci_prompt_versions.length + 1;
      if (p_activate) state.tables.ci_prompt_versions.forEach(v => (v.is_active = false));
      state.tables.ci_prompt_versions.push({ id, prompt_set: "content", version: id, content: p_content, is_active: !!p_activate });
      return id;
    },
    ci_activate_prompt_version({ p_id }) {
      state.tables.ci_prompt_versions.forEach(v => (v.is_active = v.id === p_id));
      return null;
    },
  };

  function builder(table) {
    state.tables[table] = state.tables[table] || [];
    const q = { table, op: "select", filters: [], payload: null, opts: {}, single: false, maybe: false, limit: null, returning: false, head: false, count: null };
    const api = {
      select(cols, o = {}) { if (q.op === "select") q.op = "select"; else q.returning = true; if (o.head) q.head = true; if (o.count) q.count = o.count; return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      upsert(p, o = {}) { q.op = "upsert"; q.payload = p; q.opts = o; return api; },
      update(p) { q.op = "update"; q.payload = p; return api; },
      delete(o = {}) { q.op = "delete"; q.count = o.count || null; return api; },
      eq(c, v) { q.filters.push(r => r[c] === v); return api; },
      neq(c, v) { q.filters.push(r => r[c] !== v); return api; },
      in(c, vs) { q.filters.push(r => vs.includes(r[c])); return api; },
      is(c, v) { q.filters.push(r => (r[c] ?? null) === v); return api; },
      not(c, op, v) { if (op === "is") q.filters.push(r => (r[c] ?? null) !== v); return api; },
      gte(c, v) { q.filters.push(r => r[c] == null || r[c] >= v); return api; },
      lte() { return api; }, lt() { return api; }, gt() { return api; },
      or() { return api; }, ilike() { return api; }, contains() { return api; }, filter() { return api; },
      order() { return api; }, range() { return api; },
      limit(n) { q.limit = n; return api; },
      single() { q.single = true; return api; },
      maybeSingle() { q.maybe = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function match() { return state.tables[table].filter(r => q.filters.every(f => f(r))); }
    function run() {
      state.calls.push({ kind: "from", table, op: q.op });
      const rows = state.tables[table];
      if (q.op === "select") {
        let out = match();
        if (q.limit != null) out = out.slice(0, q.limit);
        if (q.head) return { data: null, error: null, count: out.length };
        if (q.single || q.maybe) {
          if (out.length === 0) return q.single ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
          return { data: { ...out[0] }, error: null };
        }
        return { data: out.map(r => ({ ...r })), error: null, count: out.length };
      }
      if (q.op === "insert" || q.op === "upsert") {
        const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(r => ({ id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
        const added = [];
        for (const r of list) {
          const conflictCol = q.opts.onConflict;
          const existing = conflictCol ? rows.find(x => x[conflictCol] != null && x[conflictCol] === r[conflictCol]) : null;
          if (existing) {
            if (q.opts.ignoreDuplicates) continue;
            Object.assign(existing, r); added.push(existing); continue;
          }
          rows.push(r); added.push(r);
        }
        const data = q.single ? { ...added[0] } : added.map(r => ({ ...r }));
        return { data, error: null };
      }
      if (q.op === "update") {
        const m = match(); m.forEach(r => Object.assign(r, q.payload));
        return { data: q.single ? { ...m[0] } : m.map(r => ({ ...r })), error: null, count: m.length };
      }
      if (q.op === "delete") {
        const m = match(); state.tables[table] = rows.filter(r => !m.includes(r));
        return { data: null, error: null, count: m.length };
      }
      return { data: null, error: null };
    }
    return api;
  }

  const client = {
    auth: {
      async getUser(token) {
        state.calls.push({ kind: "auth.getUser" });
        const u = state.sessions[token];
        if (!u) return { data: { user: null }, error: { message: "invalid JWT" } };
        return { data: { user: u }, error: null };
      },
    },
    async rpc(name, args) {
      state.calls.push({ kind: "rpc", name });
      if (!rpcs[name]) return { data: null, error: { message: "unknown rpc " + name } };
      return { data: rpcs[name](args || {}), error: null };
    },
    from(table) { return builder(table); },
  };
  return { client, state };
}

module.exports = { createFake };
