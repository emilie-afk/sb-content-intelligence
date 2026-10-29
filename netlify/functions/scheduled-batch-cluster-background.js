/**
 * Netlify Background Scheduled Function: scheduled-batch-cluster-background
 *
 * Runs daily (configured in netlify.toml) to auto-cluster all New signals.
 * Calls batch-cluster in a loop until remaining=0 or MAX_CALLS reached.
 * Background function = 15-minute timeout (enough for large signal queues).
 */

const { requireService, internalHeaders, siteUrl } = require("../lib/auth");
const locks = require("../lib/locks");
const MAX_CALLS = 40; // batch-cluster now processes 6/call, some finish async — allow headroom

exports.handler = async (event) => {
  // Scheduler credential only — each run burns Claude API credits. One loop at a
  // time (durable lock), so overlapping triggers don't double the work.
  try {
    await requireService(event || {}, ["scheduler"]);
  } catch (e) {
    return { statusCode: e.status || 401, body: JSON.stringify({ error: e.isPublic ? e.message : "Unauthorized" }) };
  }
  let holder;
  try {
    holder = await locks.acquire("scheduled_batch_cluster", 16 * 60, "A clustering loop is already running");
  } catch (e) {
    return { statusCode: e.status || 409, body: JSON.stringify({ error: e.message }) };
  }
  const target = `${siteUrl()}/.netlify/functions/batch-cluster`;
  const callHeaders = internalHeaders();

  let remaining = 1;
  let totalProcessed = 0;
  let calls = 0;
  let consecutiveErrors = 0;
  let lastRemaining = -1;
  let stalls = 0; // consecutive calls where remaining didn't drop

  while (remaining > 0 && calls < MAX_CALLS && consecutiveErrors < 3 && stalls < 3) {
    try {
      const resp = await fetch(target, { method: "POST", headers: callHeaders, body: JSON.stringify({}) });

      if (!resp.ok) {
        console.error(`batch-cluster HTTP ${resp.status}`);
        consecutiveErrors++;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const data = await resp.json();
      remaining = data.remaining ?? 0;
      totalProcessed += data.processed ?? 0;
      calls++;
      consecutiveErrors = 0;

      console.log(
        `Call ${calls}: processed=${data.processed ?? 0}, remaining=${remaining}`
      );

      stalls = remaining === lastRemaining ? stalls + 1 : 0;
      lastRemaining = remaining;

      if (remaining > 0) {
        // 15s between dispatch batches — throttles concurrent background analyses
        await new Promise((r) => setTimeout(r, 15000));
      }
    } catch (err) {
      console.error("batch-cluster call failed:", err.message);
      consecutiveErrors++;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const summary = {
    success: true,
    totalProcessed,
    calls,
    remaining,
    stopped_reason:
      consecutiveErrors >= 3
        ? "too_many_errors"
        : stalls >= 3
        ? "stalled_signals_not_clustering"
        : calls >= MAX_CALLS
        ? "max_calls_reached"
        : "complete",
  };

  await locks.release("scheduled_batch_cluster", holder);
  console.log("scheduled-batch-cluster done:", JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
