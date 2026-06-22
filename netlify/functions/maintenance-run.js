/**
 * Netlify Function: maintenance-run
 *
 * Runs qualification checks on all existing Collecting clusters,
 * promotes those that meet pattern thresholds, and creates
 * Content Review candidates for qualifying ones.
 *
 * POST /.netlify/functions/maintenance-run
 * Body: { limit: 100 }  (optional — how many clusters to process)
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "extract-v2";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body = {};
  try { if (event.body) body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const batchLimit = Math.min(body.limit || 100, 200);

  try {
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

    // ── 2. FETCH SHARED CONTEXT ONCE ─────────────────────────────────────────

    // Plant watchlist (for candidate prompts)
    const { data: watchlist } = await supabase
      .from("plant_watchlist")
      .select("plant_name, top_products")
      .limit(50);
    const watchlistText = (watchlist || []).map(p => {
      const products = p.top_products ? p.top_products.split(" || ").slice(0, 5).join(", ") : null;
      return products ? `${p.plant_name} (${products})` : p.plant_name;
    }).join("\n");

    // Owned published content
    const { data: dbPublished } = await supabase
      .from("published_videos")
      .select("video_title, topic, plant_or_product, hook_used, angle_used, platform, publish_date, performance_summary, audience_followup_questions")
      .order("publish_date", { ascending: false })
      .limit(30);

    // Calendar sheet (optional)
    let sheetEntries = [];
    try {
      const { data: setting } = await supabase
        .from("settings").select("value").eq("key", "calendar_script_url").single();
      const scriptUrl = setting?.value?.url;
      if (scriptUrl) {
        const resp = await fetch(scriptUrl, { method: "GET", redirect: "follow" });
        const json = await resp.json();
        sheetEntries = json?.entries || [];
      }
    } catch (e) { console.warn("Sheet fetch skipped:", e.message); }

    // ── 3. PROCESS EACH CLUSTER ───────────────────────────────────────────────
    let promoted = 0;
    let candidatesCreated = 0;
    const results = [];

    for (const cluster of clusters) {
      const qualifies = checkQualification(cluster);

      // Promote Collecting → Pattern detected
      if (qualifies && cluster.status === "Collecting") {
        await supabase.from("discovery_clusters")
          .update({
            status:             "Pattern detected",
            maintenance_status: "Pattern detected",
            last_ai_updated_at: new Date().toISOString(),
            ai_update_summary:  "Promoted by maintenance run: " + qualifies.reason,
            prompt_version:     PROMPT_VERSION,
          })
          .eq("id", cluster.id);

        await supabase.from("cluster_audit_log").insert({
          cluster_id:     cluster.id,
          field_changed:  "status",
          previous_value: "Collecting",
          new_value:      "Pattern detected",
          reason:         qualifies.reason,
          trigger:        "daily_maintenance",
          ai_model:       CLAUDE_MODEL,
          prompt_version: PROMPT_VERSION,
          is_automatic:   true,
        });

        promoted++;
        cluster.status = "Pattern detected"; // update local copy for next step
      }

      // Create Content Review candidate if qualifies and none exists
      if (qualifies) {
        const { data: existing } = await supabase
          .from("content_review_candidates")
          .select("id")
          .eq("cluster_id", cluster.id)
          .not("status", "in", '("Dismissed","Already covered")')
          .maybeSingle();

        if (!existing && CLAUDE_API_KEY) {
          try {
            const candidatePrompt = buildCandidatePrompt(cluster, sheetEntries, dbPublished || [], watchlistText);
            const candidateResult = await callClaude(candidatePrompt);

            await supabase.from("content_review_candidates").insert({
              cluster_id:               cluster.id,
              title:                    candidateResult.title || cluster.title,
              what_people_are_saying:   candidateResult.what_people_are_saying,
              representative_wording:   candidateResult.representative_wording || [],
              signal_count:             cluster.signal_count,
              question_count:           cluster.question_count,
              distinct_source_count:    cluster.distinct_source_count,
              platforms:                cluster.platforms,
              first_seen_at:            cluster.first_seen_at,
              last_seen_at:             cluster.last_seen_at,
              pattern_growth:           candidateResult.pattern_growth,
              evidence_urls:            candidateResult.evidence_urls || [],
              what_appears_new:         candidateResult.what_appears_new,
              claims_needing_verification: candidateResult.claims_needing_verification,
              contradictory_advice:     candidateResult.contradictory_advice,
              closest_published_title:  candidateResult.closest_published_title,
              closest_published_urls:   candidateResult.closest_published_urls || [],
              closest_published_date:   candidateResult.closest_published_date || null,
              days_since_similar:       candidateResult.days_since_similar || null,
              previous_performance:     candidateResult.previous_performance,
              audience_followup_demand: candidateResult.audience_followup_demand,
              repetition_risk:          candidateResult.repetition_risk || "Needs reviewer check",
              freshness_reason:         candidateResult.freshness_reason,
              same_topic:               candidateResult.same_topic ?? null,
              same_plant:               candidateResult.same_plant ?? null,
              same_question:            candidateResult.same_question ?? null,
              same_advice:              candidateResult.same_advice ?? null,
              same_hook_or_angle:       candidateResult.same_hook_or_angle ?? null,
              possible_directions:      candidateResult.possible_directions || [],
              ai_confidence:            candidateResult.ai_confidence || "Medium",
              surfaced_reason:          qualifies.reason,
              status: (qualifies.reason && qualifies.reason.includes("needs verification"))
                ? "Needs research"
                : (candidateResult.candidate_status || "Ready for review"),
            });

            await supabase.from("discovery_clusters")
              .update({
                status:             "Content review ready",
                maintenance_status: "Pattern detected",
                last_ai_updated_at: new Date().toISOString(),
                ai_update_summary:  "Content Review candidate created by maintenance run",
              })
              .eq("id", cluster.id);

            candidatesCreated++;
          } catch (candidateErr) {
            console.warn("Candidate creation failed for", cluster.id, candidateErr.message);
          }
        }
      }

      results.push({
        id:       cluster.id,
        title:    cluster.title,
        signals:  cluster.signal_count,
        sources:  cluster.distinct_source_count,
        qualifies: !!qualifies,
        reason:   qualifies?.reason || "Does not yet meet threshold",
      });
    }

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
    console.error("maintenance-run error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── PATTERN QUALIFICATION (mirrors ai-analyze.js) ─────────────────────────────
function checkQualification(cluster) {
  const sc = cluster.signal_count           || 0;
  const qc = cluster.question_count         || 0;
  const dc = cluster.distinct_source_count  || 0;
  const rc = cluster.recent_mention_count   || 0;
  const pc = cluster.previous_mention_count || 0;

  if (qc >= 3)
    return { qualifies: true, reason: `${qc} independent question signals` };
  if (sc >= 3 && dc >= 2)
    return { qualifies: true, reason: `${sc} independent signals across ${dc} sources` };
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


// ── CANDIDATE PROMPT ──────────────────────────────────────────────────────────
function buildCandidatePrompt(cluster, sheetEntries, dbPublished, watchlistText) {
  const historyLines = [];
  sheetEntries.forEach(e => {
    historyLines.push(`[${e.month} 2026] "${e.title}"${e.style ? " | " + e.style : ""}${e.note ? " | " + e.note : ""}`);
  });
  dbPublished.forEach(p => {
    historyLines.push(`[Published ${p.publish_date || "?"}] "${p.video_title || p.topic}" | Plant: ${p.plant_or_product || "?"} | Hook: ${p.hook_used || "—"} | Performance: ${p.performance_summary || "not recorded"} | Follow-up: ${p.audience_followup_questions || "none"}`);
  });
  const historyText = historyLines.length ? historyLines.join("\n") : "No content history available.";

  return `You are preparing a Content Review candidate card for Succulents Box, a succulent plant subscription company.

DISCOVERY CLUSTER:
Title: ${cluster.title}
Plant: ${cluster.plant_or_product || "unknown"}
Primary question: ${cluster.primary_question || "none"}
Problems: ${(cluster.problems_mentioned || []).join(", ") || "none"}
Tips: ${(cluster.tips_mentioned || []).join(", ") || "none"}
Audience wording: ${(cluster.audience_wording || []).slice(0, 8).join(", ") || "none"}
Novelty: ${cluster.novelty_status || "Unclear"}
Signal count: ${cluster.signal_count}
Question count: ${cluster.question_count}
Distinct sources: ${cluster.distinct_source_count}
Platforms: ${(cluster.platforms || []).join(", ") || "unknown"}
First seen: ${cluster.first_seen_at || "unknown"}
Last seen: ${cluster.last_seen_at || "unknown"}

HIGH-REVENUE PLANT WATCHLIST:
${watchlistText}

2026 PRODUCTION CONTENT HISTORY:
${historyText}

Analyze whether this cluster should become a content candidate and prepare the full review card.

Return ONLY valid JSON:
{
  "title": "candidate title using audience language",
  "what_people_are_saying": "2-3 sentence summary",
  "representative_wording": ["exact audience phrases, up to 5"],
  "pattern_growth": "how this pattern has grown",
  "evidence_urls": [],
  "what_appears_new": "what is genuinely new, or null",
  "claims_needing_verification": "claims needing fact-checking, or null",
  "contradictory_advice": "if sources disagree, or null",
  "closest_published_title": "most similar owned content title, or null",
  "closest_published_urls": [],
  "closest_published_date": null,
  "days_since_similar": null,
  "previous_performance": null,
  "audience_followup_demand": "follow-up question opportunity, or null",
  "repetition_risk": "Low | Medium | High | Block | Needs reviewer check",
  "freshness_reason": "why this is or isn't fresh — 1-2 sentences",
  "same_topic": null,
  "same_plant": null,
  "same_question": null,
  "same_advice": null,
  "same_hook_or_angle": null,
  "possible_directions": ["Answer the repeated question", "Verify the claim"],
  "ai_confidence": "High | Medium | Low",
  "candidate_status": "Ready for review | Recommended follow-up | Needs research | Needs reviewer check | Hold for repetition | Already covered"
}`;
}


// ── CALL CLAUDE ────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1024) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "x-api-key":         CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error("Could not parse Claude response");
  return JSON.parse(jsonMatch[1] || jsonMatch[0]);
}
