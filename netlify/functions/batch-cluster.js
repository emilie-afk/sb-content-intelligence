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
const BATCH_SIZE = 6; // signals dispatched per call
// Analyses are dispatched to cluster-signal-background (15-min budget, returns
// 202 instantly), because a full clustering pass — especially for manual
// submissions — can exceed the ~26s synchronous function cap. This function
// just dispatches and returns; ai-analyze writes results to the DB directly.

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
        .in("status", ["New", "Clustering"])
        .in("id", linkedIds);
    }

    // Recover signals stuck in "Clustering" for >15 min (background analysis
    // died without writing a final status) — put them back in the New queue.
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase
      .from("signals")
      .update({ status: "New" })
      .eq("status", "Clustering")
      .lt("updated_at", staleCutoff);

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

    // ── Step 3: Dispatch each signal to the background cluster function ─────
    // Mark them "Clustering" first so they leave the New queue immediately and
    // the next batch-cluster call doesn't re-dispatch the same signals.
    const dispatchIds = allNew.map((s) => s.id);
    const { error: markError } = await supabase
      .from("signals")
      .update({ status: "Clustering" })
      .in("id", dispatchIds);
    if (markError) {
      // Most likely the signals_status_check constraint is missing 'Clustering'
      // — run supabase/migration_add_clustering_status.sql. Without the interim
      // status, the same signals get re-dispatched on every call.
      console.error("Failed to mark signals as Clustering:", markError.message);
    }

    const analyzeUrl = `${NETLIFY_URL}/.netlify/functions/cluster-signal-background`;
    let done = 0;   // dispatched (202 accepted)
    const failedIds = [];

    await Promise.allSettled(
      allNew.map((sig) =>
        fetch(analyzeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.INTERNAL_SECRET || "",
          },
          body: JSON.stringify({ type: "cluster", data: sig }),
          signal: AbortSignal.timeout(8000), // 202 arrives near-instantly
        })
          .then((r) => {
            console.log(`dispatch [sig:${sig.id}] status=${r.status}`);
            if (r.status === 202 || r.ok) done++;
            else failedIds.push(sig.id);
          })
          .catch((e) => {
            console.error(`dispatch error [sig:${sig.id}]:`, e.message);
            failedIds.push(sig.id);
          })
      )
    );
    const errors = failedIds.length;

    // Signals whose dispatch failed go back to New so they're retried later.
    if (failedIds.length > 0) {
      await supabase
        .from("signals")
        .update({ status: "New" })
        .in("id", failedIds)
        .eq("status", "Clustering");
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
        processed: done, // dispatched to background — results land in DB shortly
        errors,
        remaining: remaining ?? 0,
        message: `Dispatched ${done}/${allNew.length} signals for background clustering. ${remaining ?? 0} still queued.`,
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
