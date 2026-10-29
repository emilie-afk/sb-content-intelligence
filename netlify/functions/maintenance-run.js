/**
 * Netlify Function: maintenance-run
 *
 * Fast DB-only qualification pass — no Claude calls.
 * Promotes Collecting → Pattern detected for clusters that meet thresholds.
 * Writes audit log entries for each promotion.
 *
 * POST /.netlify/functions/maintenance-run
 * Body: { limit: 200 }  (optional)
 */

const { preflightOrMethod, errorResponse, baseHeaders, parseBody } = require("../lib/http");
const { requireUserOrService, ROLES } = require("../lib/auth");
const { lazyService } = require("../lib/supabase");
const locks = require("../lib/locks");

const supabase = lazyService;
const headers = baseHeaders();

const PROMPT_VERSION = "extract-v2";

exports.handler = async (event) => {
  let lockHolder = null;
  try {
  const early = preflightOrMethod(event, ["POST"]);
  if (early) return early;

  // Agent tool call (internal credential) or an approved owner/admin/assistant.
  const caller = await requireUserOrService(event, { roles: ROLES.WRITERS, scopes: ["internal", "scheduler"], bucket: "admin" });
  const performedBy = caller.kind === "user" ? caller.userId : null;

  const body = parseBody(event, { maxBytes: 4096 });
  const batchLimit = Math.max(1, Math.min(Number(body.limit) || 100, 200));
  lockHolder = await locks.acquire("maintenance_run", 120, "A maintenance pass is already running.");

    // ── 1. FETCH ALL COLLECTING CLUSTERS ─────────────────────────────────────
    const { data: clusters, error: fetchErr } = await supabase
      .from("discovery_clusters")
      .select("*")
      .in("status", ["Collecting", "Pattern detected"])
      .not("status", "in", '("Closed","Blocked irrelevant","Content review ready")')
      .order("signal_count", { ascending: false })
      .limit(batchLimit);

    if (fetchErr) throw new Error("Fetch error: " + fetchErr.message);
    if (!clusters?.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "No clusters to process", promoted: 0, candidates_created: 0 }) };
    }

    // ── 2. QUALIFY AND PROMOTE (no Claude calls — fast DB-only pass) ─────────
    let promoted = 0;
    const qualifyingIds = [];
    const now = new Date().toISOString();

    // Build batched updates — all DB writes in parallel per cluster
    const updatePromises = clusters.map(async (cluster) => {
      const qualifies = checkQualification(cluster);

      if (qualifies && cluster.status === "Collecting") {
        await Promise.all([
          supabase.from("discovery_clusters").update({
            status:                   "Pattern detected",
            maintenance_status:       "Pattern detected",
            last_ai_updated_at:       now,
            ai_update_summary:        "Promoted: " + qualifies.reason,
            prompt_version:           PROMPT_VERSION,
            audience_recurring_boolean: true,
            // Keep existing repetition_source_type if already set; default to current_audience
            repetition_source_type:   cluster.repetition_source_type || "current_audience",
          }).eq("id", cluster.id),
          supabase.from("cluster_audit_log").insert({
            cluster_id:      cluster.id,
            field_changed:   "status",
            previous_value:  "Collecting",
            new_value:       "Pattern detected",
            reason:          qualifies.reason,
            trigger:         "daily_maintenance",
            ai_model:        "none",
            prompt_version:  PROMPT_VERSION,
            is_automatic:    true,
            performed_by:    performedBy,
            source_function: "maintenance-run",
          }),
        ]);
        promoted++;
      }

      if (qualifies) qualifyingIds.push(cluster.id);

      return {
        id:       cluster.id,
        title:    cluster.title,
        signals:  cluster.signal_count,
        sources:  cluster.distinct_source_count,
        qualifies: !!qualifies,
        reason:   qualifies?.reason || "Does not yet meet threshold",
      };
    });

    const results = await Promise.all(updatePromises);
    const candidatesCreated = 0; // candidate creation now happens via AI Briefing

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:           true,
        clusters_checked:  clusters.length,
        promoted,
        candidates_created: candidatesCreated,
        results,
      }),
    };

  } catch (err) {
    return errorResponse(err, "maintenance-run");
  } finally {
    if (lockHolder) await locks.release("maintenance_run", lockHolder);
  }
};


// ── PATTERN QUALIFICATION (mirrors ai-analyze.js) ─────────────────────────────
// Uses audience_signal_count (current external audience only) — not signal_count.
// signal_count counts everything; audience_signal_count excludes owned archive matches.
// v14: manual_signal_count and owned_comment_signal_count are weighted higher.
function checkQualification(cluster) {
  const asc    = cluster.audience_signal_count     ?? cluster.signal_count ?? 0;
  const manual = cluster.manual_signal_count        ?? 0;
  const owned  = cluster.owned_comment_signal_count ?? 0;
  const qc     = cluster.question_count             ?? 0;
  const dc     = cluster.distinct_source_count      ?? 0;
  const rc     = cluster.recent_mention_count       ?? 0;
  const pc     = cluster.previous_mention_count     ?? 0;

  // 1 manual + 1 question = immediately worth reviewing (human saw something real)
  if (manual >= 1 && qc >= 1)
    return { qualifies: true, reason: `Manual signal with ${qc} audience question(s)` };

  // Strong owned-comment demand = audience asking follow-ups on SB's own content
  if (owned >= 2)
    return { qualifies: true, reason: `${owned} owned comment signals — audience follow-up demand` };

  if (qc >= 3)
    return { qualifies: true, reason: `${qc} independent audience questions` };
  if (asc >= 3 && dc >= 2)
    return { qualifies: true, reason: `${asc} audience signals across ${dc} sources` };
  if (dc >= 2 && rc >= 3 && pc > 0 && rc >= pc * 2)
    return { qualifies: true, reason: `Growth: ${pc} → ${rc} mentions across ${dc} sources` };
  if (dc >= 2 && cluster.novelty_status === "New tip or claim")
    return { qualifies: true, reason: `New tip or claim across ${dc} sources — needs verification` };
  if (dc >= 2 && cluster.contradiction_status === "Detected")
    return { qualifies: true, reason: `Conflicting advice detected across ${dc} sources` };
  if (cluster.reviewer_status === "Pinned")
    return { qualifies: true, reason: "Manually pinned by reviewer" };

  return false;
}
