/**
 * http.js — response helpers, body parsing with limits, and safe error handling
 * shared by every Netlify Function.
 *
 * Errors: throw `new PublicError(status, message)` for messages that may be shown to
 * the caller. Anything else becomes a generic 500 with a request id; details stay in
 * the function log (never prompts, credentials, source URLs or provider payloads).
 */
const crypto = require("crypto");

class PublicError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
    this.isPublic = true;
  }
}

function baseHeaders() {
  const h = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  // Same-origin by default. Only an explicitly configured origin gets CORS access.
  const origin = (process.env.ALLOWED_ORIGIN || "").trim();
  if (origin && origin !== "*") {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Vary"] = "Origin";
  }
  return h;
}

function json(statusCode, body) {
  return { statusCode, headers: baseHeaders(), body: JSON.stringify(body) };
}

function header(event, name) {
  const h = event && event.headers ? event.headers : {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

/** Parse a JSON body with a byte limit. Returns {} for an empty body when allowEmpty. */
function parseBody(event, { maxBytes = 64 * 1024, allowEmpty = true } = {}) {
  let raw = event.body || "";
  if (event.isBase64Encoded && raw) raw = Buffer.from(raw, "base64").toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new PublicError(413, `Request body too large (max ${Math.round(maxBytes / 1024)} KB)`);
  }
  if (!raw.trim()) {
    if (allowEmpty) return {};
    throw new PublicError(400, "Request body required");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new PublicError(400, "Invalid JSON body");
  }
}

function preflightOrMethod(event, methods = ["POST"]) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: baseHeaders(), body: "" };
  if (!methods.includes(event.httpMethod)) return json(405, { error: "Method not allowed" });
  return null;
}

/** Convert any thrown error into a safe response. */
function errorResponse(err, context = "") {
  if (err && err.isPublic) {
    return json(err.status, { error: err.message, ...(err.extra || {}) });
  }
  const id = crypto.randomBytes(6).toString("hex");
  // Log the message only (not request bodies, prompts or provider payloads).
  console.error(`[${context || "function"}] internal error ref=${id}:`, redact(err && err.message));
  return json(500, { error: `Internal error (ref ${id})` });
}

/** Wrap a handler so unexpected errors never leak details. */
function wrap(name, fn) {
  return async (event, ctx) => {
    try {
      return await fn(event, ctx);
    } catch (err) {
      return errorResponse(err, name);
    }
  };
}

// Strip URLs and long tokens from log text so source locations / secrets don't land in logs.
function redact(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s"')]+/g, "<url>")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
    .slice(0, 500);
}

module.exports = { PublicError, json, header, parseBody, preflightOrMethod, errorResponse, wrap, redact, baseHeaders };
