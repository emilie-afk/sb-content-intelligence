/**
 * batch-cluster.js
 * Called by the daily scheduled task to auto-cluster all New signals.
 * Processes up to BATCH_SIZE signals per call to stay within the 10s timeout.
 * Returns { total, processed, errors, remaining } so the caller can loop.
 */

const { createClient } = require("@supabase/supabase-js");
const { requireUserRole, CORS_HEADERS: headers } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const NETLIFY_URL =
  process.env.URL || "https://sb-content-intelligence.netlify.app";
const BATCH_SIZE = 6;        // signals per call — all fired in ONE parallel round
const ANALYZE_TIMEOUT = 7000; // ms — abort waiting before Netlify's 10s kill.
// NOTE: an aborted request only stops US waiting — ai-analyze keeps running
// server-side and still updates the DB. Step 1 of the next call fixes any
// signal that got linked but is still marked New.

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // Allow scheduled task (no user JWT) via shared internal secret
  const internalSecret = event.headers["x-internal-secret"] || event.headers["X-Internal-Secret"];
  const isInternalCall = internalSecret && internalSecret === process.env.INTERNAL_SECRET;
  if (!isInternalCall) {
    const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
    if (authError) return authError;
  }

  try {
    // ── Step 1: Fix signals already linked but still stuck as New ──────────
    const { data: linkedRows } = await supabase
      .from("signal_cluster_links")
      .select("signal_id");

    if (linkedRows && linkedRows.length > 0) {
      const linkedIds = linkedRows.map((r) => r.signal_id);
      await supabase
        .from("signals")
        .update({ status: "Clustered" })
        .eq("status", "New")
        .in("id", linkedIds);
    }

    // ── Step 2: Fetch up to BATCH_SIZE truly-unclustered New signals ────────
    const { data: allNew, error: fetchError } = await supabase
      .from("signals")
      .select(
        "id, topic, platform, source_url, caption_summary, plant_or_product, is_manual_submission"
      )
      .eq("status", "New")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("Step 2 fetch error:", fetchError.message, fetchError.details);
    }

    if (!allNew || allNew.length === 0) {
      // Count remaining for reporting
      const { count: remaining } = await supabase
        .from("signals")
        .select("*", { count: "exact", head: true })
        .eq("status", "New");

      console.log(`Step 2: no signals fetched (fetchError=${fetchError?.message ?? "none"}, remaining=${remaining})`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: fetchError ? `Fetch error: ${fetchError.message}` : "No new signals to cluster",
          fetchError: fetchError?.message ?? null,
          processed: 0,
          remaining: remaining ?? 0,
        }),
      };
    }

    // ── Step 3: Cluster each signal by calling ai-analyze ──────────────────
    const analyzeUrl = `${NETLIFY_URL}/.netlify/functions/ai-analyze`;
    let done = 0;
    let errors = 0;
    let timedOut = 0;

    // Fire ALL signals in one parallel round so wall-time ≈ one ai-analyze
    // call, not BATCH_SIZE/CONCURRENCY sequential rounds. Each request stops
    // being awaited after ANALYZE_TIMEOUT ms (the work still completes
    // server-side — see note at top).
    await Promise.allSettled(
      allNew.map((sig) =>
        fetch(analyzeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.INTERNAL_SECRET || "",
          },
          body: JSON.stringify({ type: "cluster", data: sig }),
          signal: AbortSignal.timeout(ANALYZE_TIMEOUT),
        })
          .then(async (r) => {
            const text = await r.text();
            console.log(`ai-analyze [sig:${sig.id}] status=${r.status} body=${text.slice(0, 200)}`);
            let parsed;
            try { parsed = JSON.parse(text); } catch { errors++; return; }
            if (parsed.success || parsed.cluster_id) done++;
            else errors++;
          })
          .catch((e) => {
            if (e.name === "TimeoutError" || e.name === "AbortError") {
              timedOut++;
              console.log(`ai-analyze [sig:${sig.id}] still running server-side (stopped waiting after ${ANALYZE_TIMEOUT}ms)`);
            } else {
              console.error(`ai-analyze fetch error [sig:${sig.id}]:`, e.message);
              errors++;
            }
          })
      )
    );

    // ── Step 4: Count how many New signals remain ──────────────────────────
    const { count: remaining } = await supabase
      .from("signals")
      .select("*", { count: "exact", head: true })
      .eq("status", "New");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        processed: done,
        errors,
        still_running: timedOut,
        remaining: remaining ?? 0,
        message: `Clustered ${done}/${allNew.length} signals (${timedOut} still finishing server-side). ${remaining ?? 0} still queued.`,
      }),
    };
  } catch (err) {
    console.error("batch-cluster error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
