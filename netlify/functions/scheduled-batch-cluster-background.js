/**
 * Netlify Background Scheduled Function: scheduled-batch-cluster-background
 *
 * Runs daily (configured in netlify.toml) to auto-cluster all New signals.
 * Calls batch-cluster in a loop until remaining=0 or MAX_CALLS reached.
 * Background function = 15-minute timeout (enough for large signal queues).
 */

const NETLIFY_URL =
  process.env.URL || "https://sb-content-intelligence.netlify.app";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const MAX_CALLS = 40; // batch-cluster now processes 6/call, some finish async — allow headroom

exports.handler = async (event) => {
  // Require the shared internal secret — this endpoint is otherwise open to
  // anyone on the internet, and each run burns Claude API credits.
  const provided =
    event?.headers?.["x-internal-secret"] || event?.headers?.["X-Internal-Secret"];
  if (!INTERNAL_SECRET || provided !== INTERNAL_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let remaining = 1;
  let totalProcessed = 0;
  let calls = 0;
  let consecutiveErrors = 0;

  while (remaining > 0 && calls < MAX_CALLS && consecutiveErrors < 3) {
    try {
      const resp = await fetch(
        `${NETLIFY_URL}/.netlify/functions/batch-cluster`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": INTERNAL_SECRET,
          },
          body: JSON.stringify({}),
        }
      );

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

      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, 3000));
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
        : calls >= MAX_CALLS
        ? "max_calls_reached"
        : "complete",
  };

  console.log("scheduled-batch-cluster done:", JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
