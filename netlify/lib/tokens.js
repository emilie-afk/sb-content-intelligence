/**
 * tokens.js — submission-token checks for integrations (intake sheet, Social
 * Submission site, Instagram scraper, video tracker). Tokens are stored only as
 * SHA-256 hashes; validation, scope, expiry and the hourly limit are checked
 * atomically in the database. A token can only call the action it was issued for.
 */
const crypto = require("crypto");
const { PublicError, header } = require("./http");
const { serviceClient } = require("./supabase");

async function requireSubmissionToken(event, action) {
  const raw = header(event, "x-submission-token");
  if (!raw || typeof raw !== "string" || raw.length < 12 || raw.length > 200) {
    throw new PublicError(401, "Missing or invalid submission token");
  }
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const { data, error } = await serviceClient().rpc("ci_consume_submission_token", { p_hash: hash, p_action: action });
  if (error || !data) throw new PublicError(503, "Token check is unavailable");
  if (data.ok) return { kind: "token", tokenId: data.id, label: data.label };
  if (data.reason === "wrong_action") throw new PublicError(403, "Token not allowed for this action");
  if (data.reason === "rate_limited") throw new PublicError(429, "Rate limit exceeded — try again next hour");
  throw new PublicError(401, "Invalid or inactive token");
}

module.exports = { requireSubmissionToken };
