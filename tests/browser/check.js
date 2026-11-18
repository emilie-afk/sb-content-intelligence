/**
 * Browser checks of the main workflows against the local harness (server.js).
 *   node tests/browser/check.js [--shots <dir>]
 * Prints one line per check; exits non-zero if any check fails.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { start } = require("./server");
const { TOKENS, USERS } = require("../helpers/harness");

const ROOT = path.resolve(__dirname, "../..");
const shotsDir = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : null; })();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

async function openAs(browser, base, who) {
  const ctx = await browser.newContext();
  const supabaseJs = fs.readFileSync(path.join(ROOT, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"));
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, r => r.fulfill({ status: 200, contentType: "application/javascript", body: supabaseJs, headers: { "Access-Control-Allow-Origin": "*" } }));
  await ctx.route(/cdnjs\.cloudflare\.com/, r => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.XLSX={};", headers: { "Access-Control-Allow-Origin": "*" } }));
  await ctx.route(/\.supabase\.co\//, async r => {
    const u = new URL(r.request().url());
    const resp = await r.fetch({ url: `${base}${u.pathname}${u.search}` });
    await r.fulfill({ response: resp, headers: { ...resp.headers(), "access-control-allow-origin": "*", "access-control-expose-headers": "content-range" } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept(d.type() === "prompt" ? "20" : undefined));
  if (who) {
    const u = USERS[who];
    const session = { access_token: TOKENS[who], refresh_token: "r-" + who, token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: `${who}@example.test`, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };
    await page.addInitScript(s => { try { localStorage.setItem("sb-tzqjsweptsodmdtxwntt-auth-token", s); } catch (_) {} }, JSON.stringify(session));
  }
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}

const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const toastText = async (page) => (await page.locator("#toast").textContent().catch(() => "")) || "";
async function shot(page, name) { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, name + ".png"), fullPage: false }); }

(async () => {
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const h = await start(0);
  const base = `http://127.0.0.1:${h.port}`;
  const browser = await chromium.launch();
  try {
    // ── signed out ────────────────────────────────────────────────────────
    let s = await openAs(browser, base, null);
    check("signed out → sign-in screen", await visible(s.page, "#auth-screen") && !(await visible(s.page, "#app")));
    const html = await s.page.content();
    check("page has no sheet or Apps Script locations", !/spreadsheets\/d\/[A-Za-z0-9_-]{25,}|script\.google\.com\/macros/.test(html));
    await s.ctx.close();

    // ── pending account ───────────────────────────────────────────────────
    h.requests.length = 0;
    s = await openAs(browser, base, "pending");
    await s.page.waitForTimeout(500);
    check("pending account → waiting-for-approval screen", await visible(s.page, "#pending-screen") && !(await visible(s.page, "#app")));
    const contentReads = h.requests.filter(r => r.path.startsWith("/rest/v1/") && !r.path.endsWith("/users_profile"));
    check("pending account loads no app data", contentReads.length === 0, contentReads.map(r => r.path).join(","));
    await shot(s.page, "01-pending");
    await s.ctx.close();

    // ── assistant ─────────────────────────────────────────────────────────
    s = await openAs(browser, base, "assistant");
    const p = s.page;
    check("assistant → dashboard", await visible(p, "#app") && (await p.locator("#user-role").textContent()) === "assistant");
    await p.waitForTimeout(500);
    const sheetHref = await p.locator("#script-sheet-link").getAttribute("href");
    check("sheet link delivered by app-config after sign-in", /docs\.google\.com\/spreadsheets\/d\/SYNTHETIC_SHEET_ID_0000/.test(sheetHref || ""), sheetHref);
    await shot(p, "02-command-center");

    await p.evaluate(() => showView("inbox", null)); await p.waitForTimeout(600);
    const rows = await p.locator("#inbox-table tr").count();
    check("intake: Inbox lists signals", rows >= 2, `${rows} rows`);
    const hrefs = await p.locator("#inbox-table a").evaluateAll(as => as.map(a => a.getAttribute("href")));
    check("intake: javascript: source links are neutralised", hrefs.includes("#") && !hrefs.some(x => /^javascript:/i.test(x || "")), hrefs.join(" "));
    await shot(p, "03-inbox");
    h.requests.length = 0;
    await p.evaluate(() => quickDismissSignal("50000002-0000-0000-0000-000000000000")); await p.waitForTimeout(300);
    check("intake: assistant can dismiss a signal", h.requests.some(r => r.method === "PATCH" && r.path === "/rest/v1/signals"));
    h.requests.length = 0;
    await p.evaluate(() => deleteSignal("50000001-0000-0000-0000-000000000000")); await p.waitForTimeout(300);
    check("intake: assistant delete is refused in the UI (no request)", !h.requests.some(r => r.method === "DELETE") && /Only admins/.test(await toastText(p)));

    await p.evaluate(() => showView("discovery", null)); await p.waitForTimeout(600);
    check("clustering: Discovery board renders clusters", (await p.locator("text=Leggy succulents").count()) > 0);
    await shot(p, "04-discovery");
    await p.evaluate(() => showView("content-review", null)); await p.waitForTimeout(600);
    check("review: Content Review renders candidates", (await p.locator("text=Fix leggy succulents").count()) > 0);

    h.requests.length = 0;
    await p.evaluate(() => generateScriptFromBrief("50000005-0000-0000-0000-000000000000", 20)); await p.waitForTimeout(1200);
    const gen = h.requests.find(r => r.path === "/.netlify/functions/ai-analyze");
    check("generation: script generated from a brief (ai-analyze)", !!gen && h.fake.state.tables.script_outputs.some(x => x.script_title === "Generated script" && x.review_status === "Draft"));

    await p.evaluate(() => showView("scripts", null)); await p.waitForTimeout(600);
    const bar = await p.evaluate(() => renderScriptStatusBar("Needs review", "x"));
    check("approval: assistant sees no script Approve action", !/✅ Approve</.test(bar));
    h.requests.length = 0;
    await p.evaluate(() => updateScriptStatus("50000006-0000-0000-0000-000000000000", "Approved")); await p.waitForTimeout(500);
    check("approval: assistant approval is rejected by the database", /approve/i.test(await toastText(p)) && h.fake.state.tables.script_outputs.find(x => x.id.startsWith("50000006")).review_status !== "Approved");

    await p.evaluate(() => showView("brand-rules", null)); await p.waitForTimeout(500);
    h.requests.length = 0;
    await p.evaluate(() => toggleBrandRule("50000007-0000-0000-0000-000000000000", false)); await p.waitForTimeout(300);
    check("settings: assistant cannot change brand rules", !h.requests.some(r => r.method === "PATCH" && r.path.endsWith("brand_content_rules")));
    await p.evaluate(() => showView("learning", null)); await p.waitForTimeout(400);
    await p.evaluate(() => showView("activity-log", null)); await p.waitForTimeout(400);
    await p.evaluate(() => showView("help", null)); await p.waitForTimeout(400);
    check("history/help views open", await visible(p, "#view-help"));
    const assistantErrors = s.errors.filter(e => !/Failed to load resource/.test(e));
    check("assistant session: no page errors", assistantErrors.length === 0, assistantErrors.slice(0, 3).join(" | "));
    await s.ctx.close();

    // ── stored-XSS regressions (admin session, deployed CSP) ──────────────
    {
      const X = (n) => `</textarea></span><img src=x onerror="window.__xss=${n}"><svg onload="window.__xss=${n}">`;
      const evilId = "59999999-0000-0000-0000-000000000000";
      h.fake.state.tables.discovery_clusters.push({ id: evilId, title: `x');window.__xss=10;//&quot;);window.__xss=11;//` + X(12),
        status: "Pattern detected", signal_count: 3, audience_wording: [X(1), "normal wording"], problems_mentioned: [X(2)],
        tips_mentioned: [X(3)], platforms: [X(4)], summary: X(5), primary_question: X(6), plant_or_product: X(7),
        novelty_status: X(8), reviewer_note: X(9), created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
      h.fake.state.tables.cluster_audit_log.push({ id: "59999998-0000-0000-0000-000000000000", cluster_id: evilId, field_changed: X(13), new_value: X(14), reason: X(15), trigger: X(16), created_at: new Date().toISOString() });
      h.fake.state.tables.signals.push({ id: "59999997-0000-0000-0000-000000000000", topic: X(17), platform: X(18), creator_name: X(19), caption_summary: X(20), status: "New", priority: "High", is_manual_submission: false, created_at: new Date().toISOString(), source_url: "javascript:window.__xss=21" });
      h.fake.state.tables.help_docs[0].content = "# Manual\n\n## " + X(22) + "\n" + X(23);
      const x = await openAs(browser, base, "admin");
      const xp = x.page;
      await xp.evaluate(() => showView("discovery", null)); await xp.waitForTimeout(500);
      await xp.evaluate((id) => openDiscoveryPanel(id), evilId); await xp.waitForTimeout(600);
      const wordingValue = await xp.locator("#edit-wording").inputValue();
      const delBtn = xp.locator("button:has-text('Delete + block')").first();
      x.page.removeAllListeners("dialog");
      xp.on("dialog", d => d.dismiss());                // open the confirm, then cancel
      await delBtn.click(); await xp.waitForTimeout(200);
      // merge picker lists the malicious title as a candidate for another cluster
      await xp.evaluate(() => showView("discovery", null)); await xp.waitForTimeout(400);
      await xp.evaluate(() => openDiscoveryPanel("50000003-0000-0000-0000-000000000000")); await xp.waitForTimeout(500);
      await xp.evaluate(() => { openMergePicker("50000003-0000-0000-0000-000000000000"); filterMergeCandidates("50000003-0000-0000-0000-000000000000", "x"); });
      const cand = xp.locator("#merge-candidates-50000003-0000-0000-0000-000000000000 > div").first();
      if (await cand.count()) { await cand.click(); await xp.waitForTimeout(200); }
      await xp.evaluate(() => showView("inbox", null)); await xp.waitForTimeout(500);
      await xp.evaluate(() => openSignalDetail("59999997-0000-0000-0000-000000000000")); await xp.waitForTimeout(200);
      await xp.evaluate(() => showView("help", null)); await xp.waitForTimeout(500);
      const injected = await xp.evaluate(() => ({ flag: window.__xss, imgs: document.querySelectorAll('img[src="x"]').length, svgs: document.querySelectorAll('svg[onload]').length }));
      check("XSS: malicious cluster/signal/help data stays text (no script, no injected elements)", injected.flag === undefined && injected.imgs === 0 && injected.svgs === 0, JSON.stringify(injected));
      check("XSS: textarea shows the wording literally", wordingValue.includes("</textarea></span><img src=x"), wordingValue.slice(0, 60));
      await x.ctx.close();
    }

    // ── admin ─────────────────────────────────────────────────────────────
    s = await openAs(browser, base, "admin");
    const a = s.page;
    await a.evaluate(() => showView("scripts", null)); await a.waitForTimeout(500);
    h.requests.length = 0;
    await a.evaluate(() => updateScriptStatus("50000006-0000-0000-0000-000000000000", "Approved")); await a.waitForTimeout(1200);
    const exported = h.requests.some(r => r.path === "/.netlify/functions/write-to-sheet");
    check("approval + export: admin approves, script sent to the sheet", exported && h.fake.state.tables.script_outputs.find(x => x.id.startsWith("50000006")).sheet_export_ref === "October row 12");
    h.requests.length = 0;
    await a.evaluate(() => writeScriptToSheet("50000006-0000-0000-0000-000000000000")); await a.waitForTimeout(800);
    check("export: re-sending reports already exported (no new row)", h.fake.state.tables.script_outputs.find(x => x.id.startsWith("50000006")).sheet_export_ref === "October row 12");
    h.requests.length = 0;
    await a.evaluate(() => deleteSignal("50000001-0000-0000-0000-000000000000")); await a.waitForTimeout(400);
    check("admin can delete a signal", h.requests.some(r => r.method === "DELETE" && r.path === "/rest/v1/signals"));
    await a.evaluate(() => showView("watchlist", null)); await a.waitForTimeout(300);
    await shot(a, "05-scripts-admin");
    const adminErrors = s.errors.filter(e => !/Failed to load resource/.test(e));
    check("admin session: no page errors", adminErrors.length === 0, adminErrors.slice(0, 3).join(" | "));
    await s.ctx.close();
  } finally {
    await browser.close();
    h.close();
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
