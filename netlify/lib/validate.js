/** validate.js — small input validators used before any database or model work. */
const { PublicError } = require("./http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }

function uuid(v, name = "id") {
  if (!isUuid(v)) throw new PublicError(400, `${name} must be a valid id`);
  return v.toLowerCase();
}

function optionalUuid(v, name = "id") {
  if (v === undefined || v === null || v === "") return null;
  return uuid(v, name);
}

function str(v, name, { max = 2000, required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PublicError(400, `${name} is required`);
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new PublicError(400, `${name} must be text`);
  const s = String(v);
  if (s.length > max) throw new PublicError(400, `${name} is too long (max ${max} characters)`);
  return s;
}

function int(v, name, { min = 0, max = 1000, dflt = null } = {}) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new PublicError(400, `${name} must be a whole number`);
  if (n < min || n > max) throw new PublicError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

function oneOf(v, name, allowed, { required = true } = {}) {
  if ((v === undefined || v === null) && !required) return null;
  if (!allowed.includes(v)) throw new PublicError(400, `${name} must be one of: ${allowed.join(", ")}`);
  return v;
}

/** Bound every string inside an object (depth-limited) so huge inputs can't reach the model. */
function clampDeep(value, { maxString = 20000, maxArray = 200, depth = 0 } = {}) {
  if (depth > 6) return null;
  if (typeof value === "string") return value.length > maxString ? value.slice(0, maxString) : value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map(v => clampDeep(v, { maxString, maxArray, depth: depth + 1 }));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = clampDeep(v, { maxString, maxArray, depth: depth + 1 });
    return out;
  }
  return value;
}

/** Neutralise spreadsheet formulas in values written with USER_ENTERED. */
function sheetSafe(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

module.exports = { isUuid, uuid, optionalUuid, str, int, oneOf, clampDeep, sheetSafe };
