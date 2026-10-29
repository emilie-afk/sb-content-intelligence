/**
 * batch-cluster.js
 * Called by the daily scheduled task to auto-cluster all New signals.
 * Processes up to BATCH_SIZE signals per call to stay within the 10s timeout.
 * Returns { total, processed, errors, remaining } so the caller can loop.
 */

const crypto = require("crypto");
const { preflightOrMethod, errorResponse, baseHeaders, parseBody } = require("../lib/http");
const { requireUserOrService, ROLES, internalHeaders, siteUrl } = require("../lib/auth");
const { lazyService } = require("../lib/supabase");
const prompts = require("../lib/prompts");

const supabase = lazyService;
const headers = baseHeaders();
const BATCH_SIZE = 6; // signals dispatched per call
// Analyses are dispatched to cluster-signal-background (15-min budget, returns
// 202 instantly), because a full clustering pass — especially for manual
// submissions — can exceed the ~26s synchronous function cap. This function
// just dispatches and returns; ai-analyze writes results to the DB directly.

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    // GitHub Actions schedule (scheduler), the agent's tool call (internal), or an
    // owner/admin pressing "Cluster all". Each dispatch costs model calls.
    const caller = await requireUserOrService(event, { roles: ROLES.ADMINS, scopes: ["scheduler", "internal"], bucket: "dispatch" });
    const body = parseBody(event, { maxBytes: 4096 });
    // Pin the prompt version for every background analysis started by this batch
    // (an agent run passes the version it started with).
    const pinned = caller.kind === "service" && Number.isInteger(body.prompt_version) ? body.prompt_version : undefined;
    const promptSet = await prompts.loadPromptSet(supabase, { versionId: pinned });

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

    // ── Step 2: Atomically claim up to BATCH_SIZE New signals ───────────────
    // FOR UPDATE SKIP LOCKED + a claim id: overlapping runs (schedule, agent,
    // button) can never dispatch the same signal twice.
    // Check dispatch configuration BEFORE claiming, so a missing setting can't strand signals.
    const analyzeUrl = `${siteUrl()}/.netlify/functions/cluster-signal-background`;
    const callHeaders = internalHeaders();
    const claim = crypto.randomUUID();
    const { data: allNew, error: fetchError } = await supabase.rpc("ci_claim_signals_for_clustering", { p_limit: BATCH_SIZE, p_claim: claim });

    if (fetchError) {
      console.error("Step 2 claim error:", fetchError.code || "db error");
    }

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
          message: fetchError ? "Could not claim signals (database error)" : "No new signals to cluster",
          processed: 0,
          remaining: remaining ?? 0,
        }),
      };
    }

    let done = 0;   // dispatched (202 accepted)
    const failedIds = [];

    await Promise.allSettled(
      allNew.map((sig) =>
        fetch(analyzeUrl, {
          method: "POST",
          headers: callHeaders,
          body: JSON.stringify({ type: "cluster", data: { id: sig.id }, claim, prompt_version: promptSet.id }),
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
        .eq("status", "Clustering")
        .eq("clustering_claim", claim);
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
    return errorResponse(err, "batch-cluster");
  }
};
