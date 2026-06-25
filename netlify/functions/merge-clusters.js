/**
 * Netlify Function: merge-clusters
 *
 * Manually merge two discovery clusters into one.
 * The "winner" absorbs the "loser's" signals, wording, problems, and tips.
 * The loser is then closed. Claude re-analyzes the merged cluster.
 *
 * POST /.netlify/functions/merge-clusters
 * Body: { winner_id: "uuid", loser_id: "uuid" }
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "merge-v1";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body = {};
  try { if (event.body) body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { winner_id, loser_id } = body;
  if (!winner_id || !loser_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "winner_id and loser_id required" }) };
  if (winner_id === loser_id)  return { statusCode: 400, headers, body: JSON.stringify({ error: "Cannot merge a cluster with itself" }) };

  try {
    // ── 1. FETCH BOTH CLUSTERS ─────────────────────────────────────────────────
    const [{ data: winner, error: we }, { data: loser, error: le }] = await Promise.all([
      supabase.from("discovery_clusters").select("*").eq("id", winner_id).single(),
      supabase.from("discovery_clusters").select("*").eq("id", loser_id).single(),
    ]);
    if (we || !winner) throw new Error("Winner cluster not found: " + (we?.message || ""));
    if (le || !loser)  throw new Error("Loser cluster not found: "  + (le?.message || ""));

    // ── 2. MOVE SIGNAL LINKS FROM LOSER → WINNER ──────────────────────────────
    // Get all loser signal IDs
    const { data: loserLinks } = await supabase
      .from("signal_cluster_links")
      .select("signal_id, match_reason, is_duplicate")
      .eq("cluster_id", loser_id);

    // Get existing winner signal IDs (to detect duplicates)
    const { data: winnerLinks } = await supabase
      .from("signal_cluster_links")
      .select("signal_id")
      .eq("cluster_id", winner_id);

    const winnerSignalIds = new Set((winnerLinks || []).map(l => l.signal_id));

    // Insert only signals not already in winner
    const toMove = (loserLinks || []).filter(l => !winnerSignalIds.has(l.signal_id));
    if (toMove.length > 0) {
      await supabase.from("signal_cluster_links").insert(
        toMove.map(l => ({
          signal_id:    l.signal_id,
          cluster_id:   winner_id,
          match_reason: l.match_reason || "Moved via manual merge",
          is_duplicate: l.is_duplicate || false,
        }))
      );
    }

    // Delete all loser signal links (including the ones we just copied and any dupe that was already in winner)
    await supabase.from("signal_cluster_links").delete().eq("cluster_id", loser_id);

    // ── 3. RECOUNT FROM ACTUAL LINKS + MERGE ARRAYS ───────────────────────────
    // Recount signal_count from the live signal_cluster_links so the number is
    // always accurate regardless of whether the stored fields had drifted.
    const { count: liveSignalCount } = await supabase
      .from("signal_cluster_links")
      .select("*", { count: "exact", head: true })
      .eq("cluster_id", winner_id);

    const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];

    const mergedWording   = merge(winner.audience_wording,  loser.audience_wording).slice(0, 20);
    const mergedProblems  = merge(winner.problems_mentioned, loser.problems_mentioned).slice(0, 15);
    const mergedTips      = merge(winner.tips_mentioned,     loser.tips_mentioned).slice(0, 15);
    const mergedPlatforms = merge(winner.platforms,          loser.platforms);
    const mergedEvidence  = merge(winner.evidence_types,     loser.evidence_types);

    // Use live recount for signal_count; sum declared fields for the rest
    const newSignalCount   = liveSignalCount ?? ((winner.signal_count || 0) + (loser.signal_count || 0));
    const newAudienceCount = (winner.audience_signal_count  ?? winner.signal_count ?? 0)
                           + (loser.audience_signal_count   ?? loser.signal_count  ?? 0);
    const newManualCount   = (winner.manual_signal_count  || 0) + (loser.manual_signal_count  || 0);
    const newOwnedCount    = (winner.owned_comment_signal_count || 0) + (loser.owned_comment_signal_count || 0);
    const newQuestionCount = (winner.question_count || 0) + (loser.question_count || 0);
    const newSourceCount   = (winner.distinct_source_count || 0) + (loser.distinct_source_count || 0);
    const newRecentCount   = (winner.recent_mention_count || 0) + (loser.recent_mention_count || 0);

    // Keep earliest first_seen, latest last_seen
    const firstSeen = [winner.first_seen_at, loser.first_seen_at]
      .filter(Boolean).sort()[0];
    const lastSeen  = [winner.last_seen_at,  loser.last_seen_at]
      .filter(Boolean).sort().at(-1);

    // ── 4. AI RE-ANALYSIS OF MERGED CLUSTER ───────────────────────────────────
    const mergePrompt = `You are updating a Discovery cluster for Succulents Box after two clusters were merged together.

WINNER CLUSTER (kept):
Title: ${winner.title}
Plant: ${winner.plant_or_product || "unspecified"}
Summary: ${winner.summary || "none"}
Primary question: ${winner.primary_question || "none"}

LOSER CLUSTER (merged in):
Title: ${loser.title}
Plant: ${loser.plant_or_product || "unspecified"}
Summary: ${loser.summary || "none"}
Primary question: ${loser.primary_question || "none"}

MERGED DATA:
Total signals: ${newSignalCount}
Total questions: ${newQuestionCount}
Audience wording: ${mergedWording.slice(0, 8).join(", ") || "none"}
Problems: ${mergedProblems.slice(0, 5).join("; ") || "none"}
Tips: ${mergedTips.slice(0, 5).join("; ") || "none"}

Produce an updated cluster card for the merged result. The title should use audience language and cover the full scope of both clusters. Keep reasons brief.

Return ONLY valid JSON:
{
  "title": "updated cluster title covering scope of both",
  "summary": "1-2 sentence summary of the combined audience issue",
  "primary_question": "the single most representative audience question, or null",
  "plant_or_product": "broader plant scope if both clusters had different plants, or specific if they matched",
  "novelty_status": "Known recurring topic | New audience wording | New question about a known topic | New tip or claim | New contradiction | New plant connected to a known problem | Unclear",
  "ai_confidence": "High | Medium | Low",
  "merge_note": "one sentence on why these clusters belong together"
}`;

    let aiUpdate = {};
    try {
      aiUpdate = await callClaude(mergePrompt);
    } catch (aiErr) {
      console.warn("AI re-analysis failed, proceeding with original winner fields:", aiErr.message);
    }

    const now = new Date().toISOString();

    // ── 5. UPDATE WINNER CLUSTER ───────────────────────────────────────────────
    const { data: updatedWinner } = await supabase
      .from("discovery_clusters")
      .update({
        title:                      aiUpdate.title             || winner.title,
        summary:                    aiUpdate.summary           || winner.summary,
        primary_question:           aiUpdate.primary_question  ?? winner.primary_question,
        plant_or_product:           aiUpdate.plant_or_product  || winner.plant_or_product,
        novelty_status:             aiUpdate.novelty_status    || winner.novelty_status,
        ai_confidence:              aiUpdate.ai_confidence     || winner.ai_confidence,
        signal_count:               newSignalCount,
        audience_signal_count:      newAudienceCount,
        manual_signal_count:        newManualCount,
        owned_comment_signal_count: newOwnedCount,
        question_count:             newQuestionCount,
        distinct_source_count:      newSourceCount,
        recent_mention_count:       newRecentCount,
        audience_wording:           mergedWording,
        problems_mentioned:         mergedProblems,
        tips_mentioned:             mergedTips,
        platforms:                  mergedPlatforms,
        evidence_types:             mergedEvidence,
        first_seen_at:              firstSeen || winner.first_seen_at,
        last_seen_at:               lastSeen  || winner.last_seen_at,
        last_ai_updated_at:         now,
        ai_update_summary:          `Merged with "${loser.title}"${aiUpdate.merge_note ? " — " + aiUpdate.merge_note : ""}`,
        new_signals_since_review:   (winner.new_signals_since_review || 0) + (loser.new_signals_since_review || loser.signal_count || 0),
        prompt_version:             PROMPT_VERSION,
      })
      .eq("id", winner_id)
      .select()
      .single();

    // ── 6. CLOSE LOSER ─────────────────────────────────────────────────────────
    await supabase.from("discovery_clusters").update({
      status:             "Closed",
      maintenance_status: "Closed",
      last_ai_updated_at: now,
      ai_update_summary:  `Merged into "${aiUpdate.title || winner.title}"`,
      prompt_version:     PROMPT_VERSION,
    }).eq("id", loser_id);

    // ── 7. AUDIT LOG ───────────────────────────────────────────────────────────
    await supabase.from("cluster_audit_log").insert([
      {
        cluster_id:     winner_id,
        field_changed:  "signal_count",
        previous_value: String(winner.signal_count || 0),
        new_value:      String(newSignalCount),
        reason:         `Manual merge: absorbed "${loser.title}" (${loser.signal_count || 0} signals)`,
        trigger:        "manual_merge",
        ai_model:       CLAUDE_MODEL,
        prompt_version: PROMPT_VERSION,
        is_automatic:   false,
      },
      {
        cluster_id:     loser_id,
        field_changed:  "status",
        previous_value: loser.status || "Collecting",
        new_value:      "Closed",
        reason:         `Merged into "${aiUpdate.title || winner.title}"`,
        trigger:        "manual_merge",
        ai_model:       CLAUDE_MODEL,
        prompt_version: PROMPT_VERSION,
        is_automatic:   false,
      },
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:       true,
        winner:        updatedWinner || { id: winner_id },
        loser_closed:  loser_id,
        signals_moved: toMove.length,
        ai_update:     aiUpdate,
      }),
    };

  } catch (err) {
    console.error("merge-clusters error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── CALL CLAUDE ───────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "x-api-key":         CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 600,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = (data.content?.[0]?.text || "").trim();
  const jsonStr = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(jsonStr);
}
