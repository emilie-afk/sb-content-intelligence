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
const BATCH_SIZE = 8; // signals per call — keep total wall-time under 10s
const CONCURRENCY = 2; // parallel ai-analyze calls per batch

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
    const { data: allNew } = await supabase
      .from("signals")
      .select(
        "id, topic, raw_input, platform, source_url, caption_summary, plant_or_product, is_manual_submission"
      )
      .eq("status", "New")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (!allNew || allNew.length === 0) {
      // Count remaining for reporting
      const { count: remaining } = await supabase
        .from("signals")
        .select("*", { count: "exact", head: true })
        .eq("status", "New");

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: "No new signals to cluster",
          processed: 0,
          remaining: remaining ?? 0,
        }),
      };
    }

    // ── Step 3: Cluster each signal by calling ai-analyze ──────────────────
    const analyzeUrl = `${NETLIFY_URL}/.netlify/functions/ai-analyze`;
    let done = 0;
    let errors = 0;

    for (let i = 0; i < allNew.length; i += CONCURRENCY) {
      const chunk = allNew.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((sig) =>
          fetch(analyzeUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": process.env.INTERNAL_SECRET || "",
            },
            body: JSON.stringify({ type: "cluster", data: sig }),
          })
            .then((r) => r.json())
            .then((r) => {
              if (r.success || r.cluster_id) done++;
              else errors++;
            })
            .catch(() => errors++)
        )
      );
      // Small pause between chunks to avoid hammering Claude API
      if (i + CONCURRENCY < allNew.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

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
        remaining: remaining ?? 0,
        message: `Clustered ${done}/${allNew.length} signals. ${remaining ?? 0} still queued.`,
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
