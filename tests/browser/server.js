/**
 * Local stand-in for the deployed site, for browser checks only:
 *   /                       → public/index.html (with the netlify.toml security headers)
 *   /.netlify/functions/*   → the REAL function handlers (fake Supabase, stubbed Claude/Apps Script)
 *   /rest/v1/*, /auth/v1/*  → a small PostgREST/GoTrue imitation over the same fake data,
 *                             applying the migration's access rules (approved members,
 *                             writers write, admins delete) so the UI's error paths run.
 * Synthetic data only.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { setup, stubFetch, USERS, TOKENS } = require("../helpers/harness");

const ROOT = path.resolve(__dirname, "../..");

function seed() {
  const now = new Date().toISOString();
  const id = (n) => `5${String(n).padStart(7, "0")}-0000-0000-0000-000000000000`;
  return {
    signals: [
      { id: id(1), topic: "Echeveria stretching in winter", platform: "Instagram", status: "New", priority: "High", is_manual_submission: true, date_found: now.slice(0, 10), created_at: now, source_url: "https://www.instagram.com/p/SYNTH1/" },
      { id: id(2), topic: "javascript link test", platform: "TikTok", status: "New", priority: "Low", is_manual_submission: false, date_found: now.slice(0, 10), created_at: now, source_url: "javascript:alert(1)" },
    ],
    discovery_clusters: [{ id: id(3), title: "Leggy succulents", status: "Pattern detected", signal_count: 4, distinct_source_count: 2, question_count: 3, audience_wording: ["why is it tall"], platforms: ["Instagram"], created_at: now, last_seen_at: now }],
    content_review_candidates: [{ id: id(4), cluster_id: id(3), title: "Fix leggy succulents", status: "Ready for review", possible_directions: ["light fix"], created_at: now }],
    briefs: [{ id: id(5), title: "Leggy succulent fix", status: "Needs review", featured_product: "Echeveria", created_at: now, deadline: now.slice(0, 10) }],
    script_outputs: [
      { id: id(6), brief_id: id(5), script_title: "Stop the stretch", review_status: "Needs review", platform: "TikTok", script_type: "TikTok / Reel short script", full_voiceover_script: "Hook. Body.", opening_hook: "Hook.", created_at: now, updated_at: now },
    ],
    brand_content_rules: [{ id: id(7), category: "Voice", rule_name: "Synthetic rule", rule_text: "Be calm", severity: "Required", active: true }],
    learning_memory: [{ id: id(8), applies_to: "Topic", topic: "Watering", what_happened: "x", recommendation_next_time: "y", status: "Needs review next time", date_added: now.slice(0, 10) }],
    published_videos: [], opportunities: [], activity_log: [], today_board_items: [], discovery_briefings: [], competitor_activity: [],
    market_watch_plants: [], cluster_review_suggestions: [], plant_watchlist: [], help_docs: [{ id: "user-manual", title: "Manual", content: "# Manual\n\n## Section\nText" }],
    sources: [], settings: [], cluster_audit_log: [], signal_cluster_links: [],
    ci_integration_config: [
      { key: "script_apps_script", value: { url: "https://script.google.com/macros/s/TEST_DEPLOYMENT_ID_000000000000/exec" } },
      { key: "script_sheet", value: { base_url: { [new Date().getFullYear()]: "https://docs.google.com/spreadsheets/d/SYNTHETIC_SHEET_ID_0000/edit" }, gids: {} } },
    ],
  };
}

function start(port = 0) {
  const fake = setup({ tables: seed() });
  const fetchStub = stubFetch({
    claude: (b) => {
      const p = b.messages && b.messages[0] && b.messages[0].content || "";
      if (String(p).includes("generateBrief") || String(p).includes("buildGenerateBriefPrompt")) {
        return { content: [{ text: JSON.stringify({ title: "Generated brief", opening_hook: "Hook", video_flow: "1. a" }) }], stop_reason: "end_turn" };
      }
      return { content: [{ text: JSON.stringify({ script_title: "Generated script", opening_hook: "New hook", full_voiceover_script: "New hook then body", caption: "c", hashtags: ["#a"], overall: "Strong", score: 8, topic: "t", relevant: true, ideas: [] }) }], stop_reason: "end_turn" };
    },
    appsScript: (b) => (b.action === "history" ? { success: true, entries: [{ month: "October", title: "Old video" }] } : { success: true, placed: "October row 12", number: 9 }),
    other: async (u, opts) => {
      // internal function-to-function calls land back on our handlers
      const m = /\/\.netlify\/functions\/([a-z0-9-]+)/.exec(u);
      if (m) { const r = await invoke(m[1], { httpMethod: "POST", headers: opts.headers, body: opts.body }); return { ok: r.statusCode < 300, status: r.statusCode === 200 && m[1].endsWith("background") ? 202 : r.statusCode, json: async () => JSON.parse(r.body || "{}"), text: async () => r.body }; }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const requests = [];

  async function invoke(name, ev) {
    const file = path.join(ROOT, "netlify/functions", name + ".js");
    if (!fs.existsSync(file)) return { statusCode: 404, body: "{}" };
    return require(file).handler(ev, {});
  }

  const userByToken = Object.fromEntries(Object.entries(TOKENS).map(([k, t]) => [t, USERS[k]]));
  const roleOf = (req) => {
    const t = (req.headers.authorization || "").replace(/^Bearer /, "");
    const u = userByToken[t];
    return u && u.access_status === "approved" ? { ...u } : u ? { ...u, pending: true } : null;
  };

  function parseFilters(params) {
    const f = [];
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "on_conflict", "or", "columns"].includes(k)) continue;
      let m;
      if ((m = /^eq\.(.*)$/.exec(v))) f.push(r => String(r[k]) === m[1]);
      else if ((m = /^neq\.(.*)$/.exec(v))) f.push(r => String(r[k]) !== m[1]);
      else if ((m = /^in\.\((.*)\)$/.exec(v))) { const vals = m[1].split(",").map(x => x.replace(/^"|"$/g, "")); f.push(r => vals.includes(String(r[k]))); }
      else if ((m = /^not\.in\.\((.*)\)$/.exec(v))) { const vals = m[1].split(",").map(x => x.replace(/^"|"$/g, "")); f.push(r => !vals.includes(String(r[k]))); }
      else if (v === "is.null") f.push(r => r[k] == null);
      else if (v === "not.is.null") f.push(r => r[k] != null);
    }
    return f;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    let body = "";
    for await (const c of req) body += c;
    requests.push({ method: req.method, path: url.pathname, search: url.search });
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(obj === undefined ? "" : typeof obj === "string" ? obj : JSON.stringify(obj));
    };
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
        const csp = (/Content-Security-Policy = "([^"]+)"/.exec(toml) || [])[1];
        res.writeHead(200, { "Content-Type": "text/html", ...(csp ? { "Content-Security-Policy": csp.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:*") } : {}) });
        return res.end(fs.readFileSync(process.env.PAGE_FILE || path.join(ROOT, "public/index.html")));
      }
      if (url.pathname.startsWith("/supabase-js.js")) {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        return res.end(fs.readFileSync(path.join(ROOT, "node_modules/@supabase/supabase-js/dist/umd/supabase.js")));
      }
      const fn = /^\/\.netlify\/functions\/([a-z0-9-]+)$/.exec(url.pathname);
      if (fn) {
        const r = await invoke(fn[1], { httpMethod: req.method, headers: req.headers, body, queryStringParameters: Object.fromEntries(url.searchParams) });
        res.writeHead(r.statusCode, r.headers || {});
        return res.end(r.body || "");
      }
      if (url.pathname.startsWith("/auth/v1/")) {
        const u = roleOf(req);
        if (url.pathname === "/auth/v1/user" && u) return send(200, { id: u.id, email: "x@example.test", aud: "authenticated", role: "authenticated" });
        if (url.pathname === "/auth/v1/logout") return send(204);
        return send(401, { message: "invalid" });
      }
      const rest = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
      if (rest) {
        const table = rest[1];
        const u = roleOf(req);
        const rows = fake.state.tables[table] = fake.state.tables[table] || [];
        const serverOnly = ["ci_integration_config", "ci_prompt_versions", "submission_tokens", "app_settings", "sb_products"];
        if (!u || serverOnly.includes(table)) return send(401, { message: "permission denied for table " + table, code: "42501" });
        const filters = parseFilters(url.searchParams);
        const visible = table === "users_profile"
          ? Object.values(fake.state.profiles).filter(p => p.id === u.id).map(p => ({ ...p, display_name: p.role + " (test)" }))
          : (u.pending ? [] : rows);
        const matched = visible.filter(r => filters.every(f => f(r)));
        const writers = ["owner", "admin", "assistant"], admins = ["owner", "admin"];
        const adminTables = ["brand_content_rules", "plant_watchlist"];
        const deny = (msg) => send(403, { message: msg, code: "42501" });
        if (req.method === "GET" || req.method === "HEAD") {
          const limit = Number(url.searchParams.get("limit") || 1000);
          const out = matched.slice(0, limit);
          const headers = { "Content-Range": `0-${Math.max(0, out.length - 1)}/${matched.length}` };
          if ((req.headers.accept || "").includes("vnd.pgrst.object")) {
            if (!out.length) return send(406, { message: "no rows" }, headers);
            return send(200, out[0], headers);
          }
          return send(200, req.method === "HEAD" ? undefined : out, headers);
        }
        if (u.pending) return send(401, { message: "new row violates row-level security policy", code: "42501" });
        if (req.method === "DELETE") {
          if (!admins.includes(u.role)) return deny(`Only an owner or admin can delete ${table}`);
          fake.state.tables[table] = rows.filter(r => !matched.includes(r));
          return send(204);
        }
        const roles = adminTables.includes(table) ? admins : writers;
        if (!roles.includes(u.role)) return deny("new row violates row-level security policy for table " + table);
        const payload = body ? JSON.parse(body) : {};
        if (table === "script_outputs" && payload.review_status === "Approved" && !admins.includes(u.role)) return deny("Only an owner or admin can approve scripts");
        if (req.method === "PATCH") { matched.forEach(r => Object.assign(r, payload)); return send(200, matched); }
        if (req.method === "POST") {
          const list = (Array.isArray(payload) ? payload : [payload]).map(r => ({ id: r.id || require("crypto").randomUUID(), created_at: new Date().toISOString(), ...r }));
          for (const r of list) {
            const conflict = url.searchParams.get("on_conflict");
            const ex = conflict ? rows.find(x => x[conflict] === r[conflict]) : null;
            if (ex) Object.assign(ex, r); else rows.push(r);
          }
          return send(201, list);
        }
      }
      send(404, { message: "not found" });
    } catch (e) {
      send(500, { message: "harness error: " + e.message });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, fake, requests, port: server.address().port, close: () => { fetchStub.restore(); server.close(); } })));
}

module.exports = { start };
