/**
 * locks.js — durable, expiring locks (table ci_locks) so retries and repeated
 * clicks don't start the same expensive job twice. Not process memory: works
 * across function instances and background invocations.
 */
const crypto = require("crypto");
const { PublicError } = require("./http");
const { serviceClient } = require("./supabase");

async function acquire(key, ttlSeconds = 600, message = "This task is already running. Try again in a minute.") {
  const holder = crypto.randomUUID();
  const { data, error } = await serviceClient().rpc("ci_try_lock", { p_key: key.slice(0, 200), p_holder: holder, p_ttl_seconds: ttlSeconds });
  if (error) throw new PublicError(503, "Job coordination is unavailable");
  if (data !== true) throw new PublicError(409, message, { code: "in_progress" });
  return holder;
}

async function release(key, holder) {
  if (!holder) return;
  try {
    await serviceClient().rpc("ci_release_lock", { p_key: key.slice(0, 200), p_holder: holder });
  } catch (_) { /* expires on its own */ }
}

/** Run fn while holding the lock. */
async function withLock(key, ttlSeconds, fn, message) {
  const holder = await acquire(key, ttlSeconds, message);
  try { return await fn(); } finally { await release(key, holder); }
}

module.exports = { acquire, release, withLock };
