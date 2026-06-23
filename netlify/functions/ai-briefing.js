/**
 * Netlify Function: ai-briefing
 *
 * Generates an AI Discovery Briefing for the Discovery Board.
 * Reads all active clusters, recent signals, competitor activity,
 * market watch, and owned content — then returns a structured briefing
 * saved to discovery_briefings, cluster_review_suggestions, and today_board_items.
 *
 * POST /.netlify/functions/ai-briefing
 * Body: {
 *   briefing_type: "daily" | "weekly" | "on-demand",  // default: on-demand
 *   filter_state:  { platform, status, date_from, date_to }  // optional
 * }
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";  // Haiku: fast enough for 10s Netlify timeout
const PROMPT_VERSION = "briefing-v1";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!CLAUDE_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "CLAUDE_API_KEY not set" }) };
  }

  let body = {};
  try { if (event.body) body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const briefingType  = body.briefing_type || "on-demand";
  const filterState   = body.filter_state  || {};
  const generatedBy   = body.generated_by  || "auto";

  try {
    // ── 1. DETERMINE TIME WINDOW ──────────────────────────────────────────────
    const now      = new Date();
    const periodEnd = now.toISOString();
    let   periodStart;

    if (briefingType === "daily") {
      const d = new Date(now); d.setDate(d.getDate() - 1);
      periodStart = d.toISOString();
    } else if (briefingType === "weekly") {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      periodStart = d.toISOString();
    } else {
      // on-demand: use filter dates or default to last 7 days
      if (filterState.date_from) {
        periodStart = new Date(filterState.date_from).toISOString();
      } else {
        const d = new Date(now); d.setDate(d.getDate() - 7);
        periodStart = d.toISOString();
      }
    }

    // ── 2. FETCH DATA FROM SUPABASE (all in parallel) ────────────────────────

    let clusterQuery = supabase
      .from("discovery_clusters")
      .select(`id, title, summary, plant_or_product, primary_question,
        signal_count, question_count, distinct_source_count,
        platforms, audience_wording, problems_mentioned, tips_mentioned,
        first_seen_at, last_seen_at, recent_mention_count, previous_mention_count,
        novelty_status, contradiction_status, ai_confidence, status,
        maintenance_status, review_required, last_ai_updated_at, new_signals_since_review,
        ai_update_summary, revenue_priority_match`)
      .not("status", "in", '("Closed","Blocked irrelevant")')
      .order("signal_count", { ascending: false })
      .limit(60);
    if (filterState.platform) clusterQuery = clusterQuery.contains("platforms", [filterState.platform]);
    if (filterState.status)   clusterQuery = clusterQuery.eq("status", filterState.status);

    const [
      { data: clusters },
      { data: recentSignals },
      { data: changedClusters },
      { data: prevBriefings },
      { data: competitorActivity },
      { data: marketWatch },
      { data: ownedContent },
      { data: watchlist },
    ] = await Promise.all([
      clusterQuery,
      supabase.from("signals")
        .select("id, raw_input, platform, source_url, status, created_at, signal_purpose, section_route")
        .gte("created_at", periodStart).order("created_at", { ascending: false }).limit(100),
      supabase.from("discovery_clusters")
        .select("id, title, last_seen_at, new_signals_since_review, ai_update_summary")
        .gte("last_seen_at", periodStart).not("status", "in", '("Closed","Blocked irrelevant")').limit(50),
      supabase.from("discovery_briefings")
        .select("id, briefing_type, summary, prominent_topics, generated_at")
        .eq("briefing_type", briefingType).order("generated_at", { ascending: false }).limit(1),
      supabase.from("competitor_activity")
        .select("id, plant_name, activity_type, ai_summary, source_account_name, observed_at, status")
        .gte("observed_at", periodStart).order("observed_at", { ascending: false }).limit(10),
      supabase.from("market_watch_plants")
        .select("id, plant_name, signal_count, question_count, purchase_intent_count, distinct_source_count, platforms, last_seen_at, reviewer_status")
        .gte("last_seen_at", periodStart).order("signal_count", { ascending: false }).limit(10),
      supabase.from("published_videos")
        .select("video_title, topic, plant_or_product, platform, publish_date, performance_summary, audience_followup_questions")
        .order("publish_date", { ascending: false }).limit(15),
      supabase.from("plant_watchlist")
        .select("plant_name, top_products").order("priority_level", { ascending: true }).limit(30),
    ]);

    const activeClusters   = clusters          || [];
    const newSignals        = recentSignals     || [];
    const clustersChanged   = changedClusters   || [];
    const previousBriefing  = prevBriefings?.[0] || null;
    const recentCompetitors = competitorActivity || [];
    const marketWatchPlants = marketWatch        || [];
    const published         = ownedContent       || [];
    const catalogPlants     = (watchlist || []).map(p => {
      const products = p.top_products ? p.top_products.split(" || ").slice(0, 5).join(", ") : null;
      return products ? `${p.plant_name} (${products})` : p.plant_name;
    });

    // ── 3. BUILD CLAUDE PROMPT ────────────────────────────────────────────────
    const prompt = buildBriefingPrompt({
      briefingType, periodStart, periodEnd,
      activeClusters, newSignals, clustersChanged,
      previousBriefing, recentCompetitors, marketWatchPlants,
      published, catalogPlants, filterState,
    });

    // ── 4. CALL CLAUDE ────────────────────────────────────────────────────────
    const briefingResult = await callClaude(prompt, 2048);

    // ── 5. SAVE BRIEFING RECORD ───────────────────────────────────────────────
    const { data: savedBriefing, error: briefingErr } = await supabase
      .from("discovery_briefings")
      .insert({
        briefing_type:    briefingType,
        period_start:     periodStart,
        period_end:       periodEnd,
        filter_state:     filterState,
        summary:          briefingResult.summary || null,
        prominent_topics: briefingResult.prominent_topics || [],
        attention_items:  briefingResult.attention_items  || [],
        cleanup_counts:   briefingResult.cleanup_counts   || {},
        ai_model:         CLAUDE_MODEL,
        prompt_version:   PROMPT_VERSION,
        generated_at:     now.toISOString(),
        generated_by:     generatedBy,
      })
      .select("id")
      .single();

    if (briefingErr) throw new Error("Failed to save briefing: " + briefingErr.message);
    const briefingId = savedBriefing.id;

    // ── 6. SAVE CLEANUP SUGGESTIONS ───────────────────────────────────────────
    const cleanupSuggestions = briefingResult.cleanup_suggestions || [];
    if (cleanupSuggestions.length > 0) {
      const suggestionRows = cleanupSuggestions
        .filter(s => s.cluster_id)
        .map(s => ({
          cluster_id:               s.cluster_id,
          briefing_id:              briefingId,
          suggestion_type:          s.suggestion_type,
          suggested_destination:    s.suggested_destination     || null,
          suggested_match_cluster_id: s.suggested_match_cluster_id || null,
          reason:                   s.reason                   || null,
          confidence:               s.confidence               || "Medium",
          evidence_preview:         s.evidence_preview         || null,
          review_status:            "Pending",
          created_at:               now.toISOString(),
        }));

      if (suggestionRows.length > 0) {
        await supabase.from("cluster_review_suggestions").insert(suggestionRows);
      }
    }

    // ── 7. POPULATE TODAY BOARD (generated from code, not Claude) ────────────
    const boardDate = now.toISOString().slice(0, 10);

    // Clear existing unresolved items for today
    await supabase.from("today_board_items").delete()
      .eq("board_date", boardDate)
      .in("status", ["New today", "Needs decision"]);

    const todayRows = [];
    let rank = 0;

    // Prominent Topics — from Claude's prominent_topics
    for (const topic of (briefingResult.prominent_topics || []).slice(0, 5)) {
      todayRows.push({
        briefing_id: briefingId,
        cluster_id:  topic.cluster_ids?.[0] || null,
        section:     "Prominent Topics",
        rank:        rank++,
        title:       topic.theme,
        summary:     topic.why_prominent || null,
        why_today:   topic.change_from_prior ? `Change: ${topic.change_from_prior}` : null,
        evidence_summary: `${topic.signal_count || 0} signals, ${topic.source_count || 0} sources, ${topic.question_count || 0} questions`,
        ai_confidence: "Medium",
        recommended_action: "Review cluster",
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Content Candidates — clusters with status "Pattern detected" or "Content review ready"
    const candidates = activeClusters
      .filter(c => c.status === "Pattern detected" || c.status === "Content review ready")
      .slice(0, 5);
    for (const c of candidates) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: c.id,
        section: "Content Candidates", rank: rank++,
        title: c.title,
        summary: c.summary || null,
        why_today: `${c.signal_count} signals across ${c.distinct_source_count} sources`,
        evidence_summary: `${c.question_count || 0} questions · ${(c.platforms || []).join(", ")}`,
        ai_confidence: c.ai_confidence || "Medium",
        recommended_action: c.status === "Content review ready" ? "View in Content Review" : "Move to Content Review",
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Attention Items — from Claude's attention_items
    for (const item of (briefingResult.attention_items || []).slice(0, 5)) {
      const section = item.recommended_action === "Move to Content Review" ? "Content Candidates"
        : item.recommended_action === "Flag for research" ? "Needs Research"
        : "Prominent Topics";
      todayRows.push({
        briefing_id: briefingId, cluster_id: item.cluster_id || null,
        section, rank: rank++,
        title: item.title,
        summary: item.detail || null,
        why_today: item.reason || null,
        evidence_summary: `Evidence: ${item.evidence_strength}`,
        ai_confidence: item.ai_confidence || "Medium",
        recommended_action: item.recommended_action || null,
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Cleanup Review — one item per saved suggestion
    for (const s of cleanupSuggestions.slice(0, 5)) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: s.cluster_id || null,
        section: "Cleanup Review", rank: rank++,
        title: `${s.suggestion_type}: ${s.cluster_title || "cluster"}`,
        summary: s.reason || null,
        why_today: "AI flagged for cleanup",
        evidence_summary: s.evidence_preview || null,
        ai_confidence: s.confidence || "Medium",
        recommended_action: s.suggestion_type,
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Market Watch Alerts
    for (const mw of marketWatchPlants.slice(0, 3)) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: null,
        section: "Market Watch Alerts", rank: rank++,
        title: `${mw.plant_name} — market activity`,
        summary: `${mw.signal_count} signals, ${mw.question_count} questions`,
        why_today: "Active in market watch this period",
        evidence_summary: `${mw.distinct_source_count} sources · ${(mw.platforms || []).join(", ")}`,
        ai_confidence: "Medium", recommended_action: "Review market watch",
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Competitor Alerts
    for (const ca of recentCompetitors.slice(0, 3)) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: null,
        section: "Competitor Alerts", rank: rank++,
        title: `${ca.source_account_name || "Competitor"} — ${ca.plant_name}`,
        summary: ca.ai_summary || null,
        why_today: "Competitor activity detected this period",
        evidence_summary: ca.activity_type || null,
        ai_confidence: "Medium", recommended_action: "Review competitor activity",
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    if (todayRows.length > 0) {
      await supabase.from("today_board_items").insert(todayRows);
    }
    const todayItemsCount = todayRows.length;

    // ── 8. BUILD CLEANUP COUNTS SUMMARY ──────────────────────────────────────
    const cleanupCounts = {
      dismiss:          cleanupSuggestions.filter(s => s.suggestion_type === "Dismiss").length,
      reroute:          cleanupSuggestions.filter(s => s.suggestion_type === "Reroute").length,
      merge:            cleanupSuggestions.filter(s => s.suggestion_type === "Merge").length,
      split:            cleanupSuggestions.filter(s => s.suggestion_type === "Split").length,
      needs_research:   cleanupSuggestions.filter(s => s.suggestion_type === "Needs research").length,
    };

    // Update cleanup_counts on the briefing record
    await supabase
      .from("discovery_briefings")
      .update({ cleanup_counts: cleanupCounts })
      .eq("id", briefingId);

    // ── 9. RETURN RESULT ──────────────────────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:          true,
        briefing_id:      briefingId,
        briefing_type:    briefingType,
        period_start:     periodStart,
        period_end:       periodEnd,
        summary:          briefingResult.summary,
        signal_count:     briefingResult.signal_count     || newSignals.length,
        cluster_count:    briefingResult.cluster_count    || activeClusters.length,
        clusters_changed: briefingResult.clusters_changed || clustersChanged.length,
        prominent_topics: briefingResult.prominent_topics || [],
        attention_items:  briefingResult.attention_items  || [],
        cleanup_counts:   cleanupCounts,
        today_items_count: todayItemsCount || 0,
        suggestions_count: cleanupSuggestions.length,
      }),
    };

  } catch (err) {
    console.error("ai-briefing error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── BRIEFING PROMPT ────────────────────────────────────────────────────────────
function buildBriefingPrompt(ctx) {
  const {
    briefingType, periodStart, periodEnd,
    activeClusters, newSignals, clustersChanged,
    previousBriefing, recentCompetitors, marketWatchPlants,
    published, catalogPlants, filterState,
  } = ctx;

  // Summarise clusters for the prompt (avoid sending full 100-row dump)
  const clusterSummaries = activeClusters.slice(0, 60).map(c => {
    const wording = (c.audience_wording || []).slice(0, 3).join(" / ");
    const platforms = (c.platforms || []).join(", ");
    return [
      `ID:${c.id}`,
      `"${c.title}"`,
      `plant:${c.plant_or_product || "?"}`,
      `signals:${c.signal_count}`,
      `questions:${c.question_count}`,
      `sources:${c.distinct_source_count}`,
      `platforms:${platforms || "?"}`,
      `status:${c.status}`,
      `novelty:${c.novelty_status || "?"}`,
      wording ? `audience:"${wording}"` : null,
      c.primary_question ? `question:"${c.primary_question}"` : null,
    ].filter(Boolean).join(" | ");
  }).join("\n");

  const newSignalCount = newSignals.length;
  const changedCount   = clustersChanged.length;

  const competitorText = recentCompetitors.length
    ? recentCompetitors.map(a =>
        `${a.source_account_name || "?"} — ${a.activity_type || "?"}: ${a.ai_summary || ""}`.trim()
      ).join("\n")
    : "No competitor activity in this period";

  const marketWatchText = marketWatchPlants.length
    ? marketWatchPlants.map(p =>
        `${p.plant_name} — ${p.signal_count} signals, ${p.distinct_source_count} sources (${(p.platforms || []).join(", ")})`
      ).join("\n")
    : "No market watch activity in this period";

  const publishedText = published.length
    ? published.map(p =>
        `"${p.video_title || p.topic}" | Plant: ${p.plant_or_product || "?"} | ${p.publish_date || "?"} | Perf: ${p.performance_summary || "not recorded"} | Follow-up: ${p.audience_followup_questions || "none"}`
      ).join("\n")
    : "No owned published content yet";

  const prevSummary = previousBriefing
    ? `Previous ${previousBriefing.briefing_type} briefing (${previousBriefing.generated_at?.slice(0, 10)}): ${previousBriefing.summary}`
    : "No previous briefing available.";

  const catalogText = catalogPlants.join(", ") || "Catalog not loaded";

  return `You are generating an AI Discovery Briefing for Succulents Box, a succulent plant subscription company.
This briefing is for the internal content team. It summarises cluster patterns, flags items needing attention, and prepares a cleanup queue.
The reviewer will use this to make decisions — they should not need to scan all ${activeClusters.length} clusters.

BRIEFING TYPE: ${briefingType}
PERIOD: ${periodStart?.slice(0,10)} to ${periodEnd?.slice(0,10)}
FILTERS ACTIVE: ${JSON.stringify(filterState) || "none"}

═══════════════════════════════════════════════════
ACTIVE CLUSTERS (${activeClusters.length} total, top 60 shown):
═══════════════════════════════════════════════════
${clusterSummaries || "No active clusters"}

═══════════════════════════════════════════════════
RECENT ACTIVITY:
New signals in period: ${newSignalCount}
Clusters that changed: ${changedCount}
═══════════════════════════════════════════════════

═══════════════════════════════════════════════════
COMPETITOR ACTIVITY (this period):
${competitorText}
═══════════════════════════════════════════════════

═══════════════════════════════════════════════════
MARKET WATCH — non-catalog plants gaining attention:
${marketWatchText}
═══════════════════════════════════════════════════

═══════════════════════════════════════════════════
OWNED PUBLISHED CONTENT (most recent 20):
${publishedText}
═══════════════════════════════════════════════════

═══════════════════════════════════════════════════
CATALOG PLANTS (Succulents Box products):
${catalogText}
═══════════════════════════════════════════════════

PREVIOUS BRIEFING:
${prevSummary}

═══════════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════════

Generate the briefing. Rules:
1. Summarize only evidence present in the data above. Do not invent demand.
2. Link every conclusion to specific cluster IDs (use the ID:xxx values).
3. Separate audience discovery from competitor activity.
4. Separate catalog Discovery from Market Watch.
5. Identify changes since the previous briefing.
6. State confidence and evidence strength for every item.
7. Preserve minority and contradictory signals — do not hide them.
8. AI must NOT merge, dismiss, or approve anything automatically — only suggest.
9. Revenue context is business context only — do not use it as proof of audience demand.

PROMINENT TOPICS: Pick the 3–5 strongest patterns by evidence volume, question volume, source diversity, and growth.
ATTENTION ITEMS: Pick up to 5 items needing a reviewer decision.
CLEANUP SUGGESTIONS: Flag up to 5 clusters for Dismiss, Reroute, Merge, Split, Needs research, etc.

attention_items recommended_action values:
  "Move to Content Review" | "Needs research" | "Keep watching" | "Review owned-content match" |
  "Review catalog match" | "Send to Market Watch" | "Send to Competitor Activity" | "No action yet"

cleanup suggestion_type values:
  "Dismiss" | "Reroute" | "Merge" | "Split" | "Keep watching" |
  "Needs research" | "Needs catalog review" | "Needs source review" | "Move to Content Review"

Return ONLY valid JSON — no markdown, no explanation:
{
  "summary": "2-4 sentence plain-English briefing summary",
  "signal_count": ${newSignalCount},
  "cluster_count": ${activeClusters.length},
  "clusters_changed": ${changedCount},
  "prominent_topics": [
    {
      "theme": "plain-language topic name",
      "cluster_ids": ["uuid"],
      "signal_count": 0,
      "source_count": 0,
      "question_count": 0,
      "catalog_plants": ["plant name"],
      "platforms": ["Instagram"],
      "change_from_prior": "new | growing | stable | declining | not in prior briefing",
      "related_owned_content": "title of related published content, or null",
      "why_prominent": "1-2 sentences explaining the evidence"
    }
  ],
  "attention_items": [
    {
      "reason": "short reason label e.g. Repeated audience question",
      "cluster_id": "uuid or null",
      "title": "plain-language title",
      "evidence_strength": "Strong | Moderate | Weak",
      "ai_confidence": "High | Medium | Low",
      "recommended_action": "one value from the list above",
      "detail": "1-2 sentences of evidence"
    }
  ],
  "cleanup_suggestions": [
    {
      "cluster_id": "uuid",
      "cluster_title": "cluster title",
      "suggestion_type": "one value from the list above",
      "suggested_destination": "target section name, or null",
      "suggested_match_cluster_id": "uuid to merge into, or null",
      "reason": "why this action is suggested",
      "confidence": "High | Medium | Low",
      "evidence_preview": "short excerpt from the cluster that supports this suggestion"
    }
  ]
}`;
}


// ── CALL CLAUDE ────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 2048) {
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
  if (!jsonMatch) throw new Error("Could not parse Claude response: " + text.slice(0, 200));

  try {
    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (e) {
    throw new Error("Invalid JSON from Claude: " + e.message);
  }
}
