/**
 * auth.js — authorization for every Netlify Function.
 *
 *  requireUser(event, { roles, bucket })     interactive callers (Supabase session)
 *  requireService(event, scopes, { bucket }) scheduled / internal / integration callers
 *  requireUserOrService(event, {...})        endpoints that accept either
 *
 * Interactive access requires, on EVERY request:
 *   1. a session token verified by Supabase Auth (auth.getUser), and
 *   2. an APPROVED membership row with one of the permitted roles, read from the
 *      database (users_profile.access_status / role) — never from the token's
 *      editable metadata, the request body, or browser state.
 * Both checks plus the durable usage counter run before any other database work,
 * external fetch or model call. Membership is not cached, so revocation takes effect
 * on the next request even while the old access token is still unexpired.
 *
 * Service credentials are scoped: each environment variable unlocks only the
 * endpoints that list its scope. Missing or duplicated secrets deny access.
 */
const crypto = require("crypto");
const { PublicError, header } = require("./http");
const { serviceClient } = require("./supabase");

const ROLES = Object.freeze({
  ALL:     ["owner", "admin", "assistant", "viewer"],
  WRITERS: ["owner", "admin", "assistant"],
  ADMINS:  ["owner", "admin"],
});

// Durable per-user (or per-service) daily limits. Counters live in ci_usage_counters.
const LIMITS = Object.freeze({
  ai:         { limit: 300,  windowSeconds: 86400 }, // one Claude-backed action
  ai_batch:   { limit: 40,   windowSeconds: 86400 }, // briefing / cleanup / learning / agent / merge
  dispatch:   { limit: 300,  windowSeconds: 86400 }, // batch-cluster calls (6 analyses each)
  sheet:      { limit: 300,  windowSeconds: 86400 }, // Apps Script / Sheets calls
  import:     { limit: 50,   windowSeconds: 86400 },
  admin:      { limit: 500,  windowSeconds: 86400 },
  read:       { limit: 5000, windowSeconds: 86400 },
  scheduler:  { limit: 400,  windowSeconds: 86400 },
  internal:   { limit: 5000, windowSeconds: 86400 },
  metrics:    { limit: 200,  windowSeconds: 86400 },
});

// scope → environment variable holding that scope's shared secret
const SERVICE_SCOPES = Object.freeze({
  scheduler: "INTERNAL_SECRET",          // GitHub Actions schedules (existing secret name)
  internal:  "INTERNAL_FUNCTION_SECRET", // function → function calls inside Netlify only
  metrics:   "METRICS_INGEST_SECRET",    // external metrics ingest (update-sheet-metrics)
});

function bearer(event) {
  const raw = header(event, "authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  if (token.length > 8192 || token.split(".").length !== 3) return "__malformed__";
  return token;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function reasonToError(reason, roles) {
  switch (reason) {
    case "not_member":   return new PublicError(403, "Your account is not approved for this app yet", { code: "not_approved" });
    case "forbidden":    return new PublicError(403, `This action requires one of: ${roles.join(", ")}`, { code: "forbidden" });
    case "rate_limited": return new PublicError(429, "Daily usage limit reached for this action. Try again tomorrow or ask an admin.", { code: "rate_limited" });
    case "maintenance":  return new PublicError(503, "The app is in maintenance mode", { code: "maintenance" });
    default:             return new PublicError(503, "Authorization is unavailable");
  }
}

/**
 * @returns {Promise<{kind:'user', userId:string, role:string, email:string|null}>}
 */
async function requireUser(event, { roles = ROLES.ALL, bucket = "read" } = {}) {
  const token = bearer(event);
  if (!token) throw new PublicError(401, "Sign-in required");
  if (token === "__malformed__") throw new PublicError(401, "Invalid or expired session");

  const sb = serviceClient();
  let user;
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data || !data.user) throw new PublicError(401, "Invalid or expired session");
    user = data.user;
  } catch (e) {
    if (e.isPublic) throw e;
    throw new PublicError(401, "Invalid or expired session");
  }

  const lim = LIMITS[bucket] || LIMITS.read;
  const { data: res, error } = await sb.rpc("ci_authorize", {
    p_user: user.id,
    p_roles: roles,
    p_bucket: bucket,
    p_limit: lim.limit,
    p_window_seconds: lim.windowSeconds,
  });
  if (error || !res) throw new PublicError(503, "Authorization is unavailable");
  if (!res.ok) throw reasonToError(res.reason, roles);
  return { kind: "user", userId: user.id, role: res.role, email: res.email || null };
}

function configuredSecrets() {
  const out = {};
  for (const [scope, env] of Object.entries(SERVICE_SCOPES)) {
    const v = process.env[env];
    if (v && v.length >= 16) out[scope] = v;
  }
  return out;
}

/** Match the presented secret to exactly one configured scope (or null). */
function matchScope(presented) {
  if (!presented || typeof presented !== "string" || presented.length > 512) return null;
  const secrets = configuredSecrets();
  const values = Object.values(secrets);
  if (new Set(values).size !== values.length) {
    // Two scopes share a value: scoping would be meaningless. Refuse all service calls.
    throw new PublicError(503, "Service credentials are misconfigured");
  }
  for (const [scope, value] of Object.entries(secrets)) if (safeEqual(presented, value)) return scope;
  return null;
}

/**
 * @param {string[]} scopes allowed scopes for this endpoint
 * @returns {Promise<{kind:'service', scope:string}>}
 */
async function requireService(event, scopes, { bucket } = {}) {
  const presented = header(event, "x-internal-secret");
  const scope = matchScope(presented);
  if (!scope || !scopes.includes(scope)) throw new PublicError(401, "Unauthorized");
  const lim = LIMITS[bucket || scope] || LIMITS.internal;
  const { data: res, error } = await serviceClient().rpc("ci_authorize_service", {
    p_scope: scope,
    p_bucket: bucket || scope,
    p_limit: lim.limit,
    p_window_seconds: lim.windowSeconds,
  });
  if (error || !res) throw new PublicError(503, "Authorization is unavailable");
  if (!res.ok) throw reasonToError(res.reason, []);
  return { kind: "service", scope };
}

/** A request carrying x-internal-secret is treated ONLY as a service call. */
async function requireUserOrService(event, { roles = ROLES.WRITERS, scopes = [], bucket = "read", serviceBucket } = {}) {
  if (header(event, "x-internal-secret") !== undefined) {
    return requireService(event, scopes, { bucket: serviceBucket });
  }
  return requireUser(event, { roles, bucket });
}

/** Headers for a function-to-function call (internal scope only). */
function internalHeaders(extra = {}) {
  const secret = process.env[SERVICE_SCOPES.internal];
  if (!secret || secret.length < 16) throw new PublicError(503, "Internal service credential is not configured");
  return { "Content-Type": "application/json", "x-internal-secret": secret, ...extra };
}

function siteUrl() {
  const u = process.env.URL;
  if (!u || !/^https?:\/\//.test(u)) throw new PublicError(503, "Site URL is not configured");
  return u.replace(/\/$/, "");
}

module.exports = { ROLES, LIMITS, SERVICE_SCOPES, requireUser, requireService, requireUserOrService, internalHeaders, siteUrl, __matchScope: matchScope };
