/**
 * sources.js — server-side resolution of Google Sheets / Apps Script locations.
 *
 * Source locations live in the private table ci_integration_config (or legacy
 * server env vars), never in browser code. Callers name a predefined source;
 * there is no general URL-fetch proxy. Requests go only to Google Apps Script
 * hosts over HTTPS, redirects are followed manually and only to allowed hosts,
 * and the shared secret travels in the POST body (never in a query string).
 */
const { PublicError, redact } = require("./http");

const APPS_SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/;
const SHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(\/edit)?$/;
const ALLOWED_HOSTS = new Set(["script.google.com", "script.googleusercontent.com"]);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function getIntegration(sb, key) {
  const { data, error } = await sb.from("ci_integration_config").select("value").eq("key", key).maybeSingle();
  if (error) throw new PublicError(503, "Integration settings are unavailable");
  return data ? data.value : null;
}

async function appsScriptUrl(sb) {
  const cfg = await getIntegration(sb, "script_apps_script");
  const url = (cfg && cfg.url) || process.env.SCRIPT_SHEET_HOOK_URL || "";
  if (!url) throw new PublicError(503, "The script sheet integration is not configured");
  if (!APPS_SCRIPT_URL_RE.test(url)) throw new PublicError(503, "The script sheet integration is misconfigured");
  return url;
}

function appsScriptSecret() {
  const a = process.env.CALENDAR_SCRIPT_SECRET || "";
  const b = process.env.SCRIPT_SHEET_TOKEN || "";
  if (a && b && a !== b) throw new PublicError(503, "Script sheet credentials are misconfigured");
  const s = a || b;
  if (!s || s.length < 16) throw new PublicError(503, "The script sheet credential is not configured");
  return s;
}

async function readLimited(resp) {
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) return await resp.text();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) { try { reader.cancel(); } catch (_) {} throw new PublicError(502, "The script sheet response was too large"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST a predefined action to the Apps Script web app.
 * @param {"append"|"history"} action
 */
async function callAppsScript(sb, action, payload = {}, { timeoutMs = 20000 } = {}) {
  if (!["append", "history"].includes(action)) throw new PublicError(400, "Unknown sheet action");
  const secret = appsScriptSecret();
  let url = await appsScriptUrl(sb);
  const body = JSON.stringify({ ...payload, action, "x-script-secret": secret });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "manual", signal: controller.signal });
    for (let hops = 0; resp.status >= 300 && resp.status < 400; hops++) {
      const loc = resp.headers.get("location");
      if (!loc || hops >= 3) throw new PublicError(502, "The script sheet redirected unexpectedly");
      const next = new URL(loc, url);
      if (next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname)) throw new PublicError(502, "The script sheet redirected to an unexpected host");
      url = next.toString();
      // Apps Script answers POST with 302 → GET the echo URL (same as browsers/fetch "follow")
      resp = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    }
    if (!resp.ok) throw new PublicError(502, `The script sheet returned HTTP ${resp.status}`);
    const text = await readLimited(resp);
    let data;
    try { data = JSON.parse(text); } catch { throw new PublicError(502, "The script sheet returned an unreadable response"); }
    if (!data || data.success === false || data.error) {
      const msg = String((data && data.error) || "unknown error");
      if (/unauthori[sz]ed/i.test(msg)) throw new PublicError(502, "The script sheet rejected the server credential (check SCRIPT_SECRET)");
      throw new PublicError(502, `Script sheet error: ${redact(msg).slice(0, 160)}`);
    }
    return data;
  } catch (e) {
    if (e.isPublic) throw e;
    console.error("[sources] apps script call failed:", e && e.name === "AbortError" ? "timeout" : redact(e && e.message));
    throw new PublicError(502, "The script sheet could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

/** Repetition-check history (all month tabs). Returns [] if the integration fails. */
async function fetchScriptHistory(sb, { required = false } = {}) {
  try {
    const data = await callAppsScript(sb, "history");
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (e) {
    if (required) throw e;
    console.warn("[sources] script history unavailable:", e.message);
    return [];
  }
}

/** "Open sheet" link for the given date (authorized members only). */
async function scriptSheetLink(sb, date = new Date()) {
  const cfg = await getIntegration(sb, "script_sheet");
  if (!cfg || !cfg.base_url) return null;
  const year = date.getFullYear(), month = date.getMonth() + 1;
  const years = Object.keys(cfg.base_url).map(Number).filter(Number.isFinite);
  const base = cfg.base_url[year] || (years.length ? cfg.base_url[Math.max(...years)] : null);
  if (!base || !SHEET_URL_RE.test(base)) return null;
  const gid = cfg.gids && cfg.gids[year] && cfg.gids[year][month];
  return gid ? `${base}?gid=${Number(gid)}#gid=${Number(gid)}` : base;
}

async function videoTrackerLink(sb) {
  const cfg = await getIntegration(sb, "video_tracker");
  const id = (cfg && cfg.sheet_id) || process.env.GOOGLE_VIDEO_TRACKER_ID || "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) return null;
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function normaliseSheetUrl(input) {
  const s = String(input || "").trim().split("?")[0].split("#")[0].replace(/\/$/, "");
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(\/edit)?$/.exec(s);
  if (!m) throw new PublicError(400, "Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…)");
  return `https://docs.google.com/spreadsheets/d/${m[1]}/edit`;
}

module.exports = { getIntegration, callAppsScript, fetchScriptHistory, scriptSheetLink, videoTrackerLink, normaliseSheetUrl, APPS_SCRIPT_URL_RE };
