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
      { data: sbProducts },
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
      supabase.from("sb_products")
        .select("handle, title, common_name, scientific_name, genus")
        .eq("is_active", true),
    ]);

    const activeClusters   = clusters          || [];
    const newSignals        = recentSignals     || [];
    const clustersChanged   = changedClusters   || [];
    const previousBriefing  = prevBriefings?.[0] || null;
    const recentCompetitors = competitorActivity || [];
    const marketWatchPlants = marketWatch        || [];
    const published         = ownedContent       || [];
    const catalogPlantNames = (watchlist || []).map(p => p.plant_name.toLowerCase());
    const catalogPlants     = (watchlist || []).map(p => {
      const products = p.top_products ? p.top_products.split(" || ").slice(0, 5).join(", ") : null;
      return products ? `${p.plant_name} (${products})` : p.plant_name;
    });

    // ── CATALOG MATCHING ──────────────────────────────────────────────────────
    // Built from live sb_products table (full Shopify catalog).
    // Matching priority:
    //   1. plant_watchlist  — top revenue plants (get score boost too)
    //   2. sb_products      — exact title / common_name / scientific_name match
    //   3. genus            — genus-level match from sb_products (general topic OK)
    // General terms ("cactus", "succulent") always in-catalog.

    const GENERAL_TERMS = ["cactus","succulent","air plant","tillandsia","houseplant","plant"];

    // Build lookup sets from live sb_products data
    const catalog = sbProducts || [];
    const catalogTitles    = catalog.map(p => p.title.toLowerCase());
    const catalogCommon    = catalog.map(p => (p.common_name || "").toLowerCase()).filter(Boolean);
    const catalogSci       = catalog.map(p => (p.scientific_name || "").toLowerCase()).filter(Boolean);
    const catalogGenera    = new Set(catalog.map(p => (p.genus || "").toLowerCase()).filter(Boolean));

    // Normalise: strip scientific name in parens, lowercase
    const norm = (s) => (s || "").toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();

    // Specific varieties confirmed NOT in SB catalog.
    // Genus-level match alone isn't enough for highly specific varieties.
    // Add a term here whenever a cluster surfaces a plant you've confirmed you don't carry.
    const NOT_IN_CATALOG = [
      "black widow",   // Gymnocalycium mihanovichii var. black widow — not in SB catalog
    ];

    const isInCatalog = (plantName) => {
      if (!plantName) return true; // No specific plant = general topic, always relevant

      const lc = norm(plantName);

      // 0. Explicit exclusions beat everything (genus match alone isn't sufficient)
      if (NOT_IN_CATALOG.some(excl => lc.includes(excl))) return false;

      // General terms always match
      if (GENERAL_TERMS.some(t => lc.includes(t))) return true;

      // 1. plant_watchlist
      if (catalogPlantNames.some(cp => lc.includes(cp) || cp.includes(lc))) return true;

      // 2. Full product title match
      if (catalogTitles.some(t => t && (lc.includes(t) || t.includes(lc)))) return true;

      // 3. Common name match (title with scientific name stripped)
      if (catalogCommon.some(c => c && (lc.includes(c) || c.includes(lc)))) return true;

      // 4. Scientific name match
      if (catalogSci.some(s => s && (lc.includes(s) || s.includes(lc)))) return true;

      // 5. Genus-level fallback — only if no specific variety name is present
      //    (i.e. the cluster title is just the genus, not "Genus Species Cultivar")
      const words = lc.split(/\s+/);
      if (words.length <= 2 && catalogGenera.has(words[0])) return true;

      return false;
    };

    // Helper: check if plant is in the priority watchlist
    const isWatchlistPlant = (plantName) => {
      if (!plantName) return false;
      const lc = norm(plantName);
      return catalogPlantNames.some(cp => lc.includes(cp) || cp.includes(lc));
    };

    // ── 3. GENERATE STRUCTURED DATA FROM CODE (no Claude JSON parsing) ────────

    // Score each cluster — watchlist plants get +5 priority boost
    const scoredClusters = activeClusters.map(c => {
      const inCatalog   = isInCatalog(c.plant_or_product);
      const isWatchlist = inCatalog && isWatchlistPlant(c.plant_or_product);
      return {
        ...c,
        _inCatalog:   inCatalog,
        _isWatchlist: isWatchlist,
        _score: c.signal_count + c.question_count * 2 +
                (c.new_signals_since_review > 0 ? 3 : 0) +
                (isWatchlist ? 5 : 0),
      };
    });

    // Prominent Topics: in-catalog plants only, ranked by score
    // Non-catalog plants go to Market Watch regardless of signal count
    const prominentTopics = scoredClusters
      .filter(c => c._inCatalog && (c.signal_count >= 3 || c.question_count >= 2))
      .sort((a, b) => b._score - a._score)
      .slice(0, 5)
      .map(c => {
        const catalogLabel = c._isWatchlist ? "⭐ Watchlist plant" :
                             c._inCatalog  ? "In SB catalog"      : "⚠️ Not in catalog";
        return {
          theme:         c.title,
          cluster_ids:   [c.id],
          signal_count:  c.signal_count,
          source_count:  c.distinct_source_count,
          question_count: c.question_count,
          catalog_plants: c.plant_or_product ? [c.plant_or_product] : [],
          platforms:     c.platforms || [],
          change_from_prior: (c.new_signals_since_review || 0) > 0 ? "growing" : "stable",
          related_owned_content: null,
          why_prominent: `${c.signal_count} signals across ${c.distinct_source_count} sources` +
            (c.question_count > 0 ? `, ${c.question_count} audience questions` : "") +
            (c.novelty_status && c.novelty_status !== "None" ? ` · ${c.novelty_status}` : "") +
            ` · ${catalogLabel}`,
        };
      });

    // Non-catalog clusters with enough signals → show in Market Watch section
    const nonCatalogClusters = scoredClusters
      .filter(c => (c.signal_count >= 3 || c.question_count >= 2) && !c._inCatalog)
      .sort((a, b) => b._score - a._score)
      .slice(0, 3);

    // Attention Items: clusters needing reviewer action
    const attentionItems = activeClusters
      .filter(c => c.review_required || (c.new_signals_since_review || 0) >= 3 ||
        c.contradiction_status === "Detected" || c.novelty_status === "New tip or claim")
      .slice(0, 5)
      .map(c => {
        const reason = c.contradiction_status === "Detected" ? "Contradictory advice detected"
          : c.novelty_status === "New tip or claim" ? "New unverified claim"
          : (c.new_signals_since_review || 0) >= 3 ? `+${c.new_signals_since_review} signals since last review`
          : "Review required";
        const action = c.contradiction_status === "Detected" ? "Needs research"
          : c.novelty_status === "New tip or claim" ? "Needs research"
          : c.status === "Pattern detected" ? "Move to Content Review"
          : "Keep watching";
        return {
          reason,
          cluster_id: c.id,
          title: c.title,
          evidence_strength: c.signal_count >= 5 ? "Strong" : c.signal_count >= 3 ? "Moderate" : "Weak",
          ai_confidence: c.ai_confidence || "Medium",
          recommended_action: action,
          detail: c.primary_question || c.summary || "",
        };
      });

    // Cleanup Suggestions: stagnant or low-signal clusters
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cleanupSuggestions = activeClusters
      .filter(c =>
        (c.signal_count <= 1 && new Date(c.first_seen_at) < sevenDaysAgo) ||
        (c.status === "Collecting" && new Date(c.first_seen_at) < thirtyDaysAgo && c.signal_count < 3)
      )
      .slice(0, 5)
      .map(c => ({
        cluster_id:     c.id,
        cluster_title:  c.title,
        suggestion_type: c.signal_count <= 1 ? "Dismiss" : "Keep watching",
        suggested_destination: null,
        suggested_match_cluster_id: null,
        reason: c.signal_count <= 1
          ? `Only ${c.signal_count} signal(s), no growth in 7+ days`
          : `Collecting for 30+ days with only ${c.signal_count} signals`,
        confidence: "Medium",
        evidence_preview: c.summary ? c.summary.slice(0, 100) : null,
      }));

    // ── 4. CALL CLAUDE — PLAIN TEXT SUMMARY ONLY (no JSON parsing) ───────────
    const summaryPrompt = buildSummaryPrompt({
      totalClusters: activeClusters.length,
      newSignalCount: newSignals.length,
      changedCount: clustersChanged.length,
      topTopics: prominentTopics.slice(0, 3).map(t => t.theme),
      competitorCount: recentCompetitors.length,
      marketWatchCount: marketWatchPlants.length,
      briefingType, periodStart, periodEnd,
    });

    let summaryText = "";
    try {
      summaryText = await callClaudeText(summaryPrompt, 150);
    } catch (e) {
      // Summary is non-critical — use a fallback if Claude fails
      summaryText = `${activeClusters.length} active clusters with ${newSignals.length} new signals in this period. ` +
        (prominentTopics.length > 0 ? `Top topics: ${prominentTopics.slice(0,3).map(t=>t.theme).join(", ")}.` : "");
    }

    const briefingResult = {
      summary:             summaryText,
      signal_count:        newSignals.length,
      cluster_count:       activeClusters.length,
      clusters_changed:    clustersChanged.length,
      prominent_topics:    prominentTopics,
      attention_items:     attentionItems,
      cleanup_suggestions: cleanupSuggestions,
    };

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
    // cleanupSuggestions already computed in section 3
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

    // Market Watch Alerts — from market_watch_plants table
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

    // Market Watch Alerts — non-catalog clusters with audience signal (not in SB catalog)
    for (const c of nonCatalogClusters) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: c.id,
        section: "Market Watch Alerts", rank: rank++,
        title: `${c.plant_or_product || c.title} — not in SB catalog`,
        summary: c.summary || c.title,
        why_today: `${c.signal_count} signals but plant not in SB catalog — consider adding or monitoring`,
        evidence_summary: `${c.signal_count} signals · ${c.distinct_source_count} sources · ${(c.platforms || []).join(", ")}`,
        ai_confidence: "Medium", recommended_action: "Send to Market Watch",
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


// ── SUMMARY PROMPT (plain text only — no JSON) ────────────────────────────────
function buildSummaryPrompt(ctx) {
  const { totalClusters, newSignalCount, changedCount, topTopics,
    competitorCount, marketWatchCount, briefingType, periodStart, periodEnd } = ctx;
  return `Write 2 sentences summarizing this social listening briefing for Succulents Box (succulent plant subscriptions).

Data: ${totalClusters} active discovery clusters, ${newSignalCount} new signals (${periodStart?.slice(0,10)} to ${periodEnd?.slice(0,10)}), ${changedCount} clusters updated.
Top topics: ${topTopics.join(", ") || "none yet"}.
Competitor activity: ${competitorCount} items. Market watch: ${marketWatchCount} plants.

Write only the 2-sentence summary. No intro, no lists, no JSON.`;
}


// ── CALL CLAUDE: PLAIN TEXT (no JSON parsing) ─────────────────────────────────
async function callClaudeText(prompt, maxTokens = 150) {
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
  return (data.content?.[0]?.text || "").trim();
}


// ── LEGACY SHARED CONTEXT BUILDER (kept for reference) ────────────────────────
function buildSharedContext(ctx) {
  const {
    briefingType, periodStart, periodEnd,
    activeClusters, newSignals, clustersChanged,
    previousBriefing, recentCompetitors, marketWatchPlants,
    published, catalogPlants, filterState,
  } = ctx;

  const clusterSummaries = activeClusters.slice(0, 40).map(c => {
    const platforms = (c.platforms || []).join("/");
    return [
      `ID:${c.id}`,
      `"${c.title}"`,
      `plant:${c.plant_or_product || "?"}`,
      `sig:${c.signal_count}`,
      `q:${c.question_count}`,
      `src:${c.distinct_source_count}`,
      `plat:${platforms || "?"}`,
      `status:${c.status}`,
      c.novelty_status && c.novelty_status !== "None" ? `novelty:${c.novelty_status}` : null,
      c.primary_question ? `q:"${c.primary_question.slice(0, 60)}"` : null,
    ].filter(Boolean).join(" | ");
  }).join("\n");

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
        `"${p.video_title || p.topic}" | Plant: ${p.plant_or_product || "?"} | ${p.publish_date || "?"} | Perf: ${p.performance_summary || "not recorded"}`
      ).join("\n")
    : "No owned published content yet";

  const prevSummary = previousBriefing
    ? `Previous ${previousBriefing.briefing_type} briefing (${previousBriefing.generated_at?.slice(0, 10)}): ${previousBriefing.summary}`
    : "No previous briefing available.";

  const catalogText = catalogPlants.join(", ") || "Catalog not loaded";

  return {
    briefingType, periodStart, periodEnd, filterState,
    clusterSummaries: clusterSummaries || "No active clusters",
    totalClusters: activeClusters.length,
    newSignalCount: newSignals.length,
    changedCount: clustersChanged.length,
    competitorText, marketWatchText, publishedText, prevSummary, catalogText,
  };
}


// ── CALL 1: TOPICS PROMPT (~600 token output) ──────────────────────────────────
function buildTopicsPrompt(ctx) {
  const { briefingType, periodStart, periodEnd, filterState,
    clusterSummaries, totalClusters, newSignalCount, changedCount,
    competitorText, marketWatchText, publishedText, prevSummary, catalogText } = ctx;

  return `You are generating Part 1 of an AI Discovery Briefing for Succulents Box (succulent plant subscriptions).
Internal use only. Identify the strongest patterns from this data.

BRIEFING TYPE: ${briefingType} | PERIOD: ${periodStart?.slice(0,10)} to ${periodEnd?.slice(0,10)}

ACTIVE CLUSTERS (${totalClusters} total, top 40 shown):
${clusterSummaries}

RECENT ACTIVITY: ${newSignalCount} new signals | ${changedCount} clusters changed

COMPETITOR ACTIVITY: ${competitorText}

MARKET WATCH (non-catalog plants): ${marketWatchText}

OWNED CONTENT (recent): ${publishedText}

CATALOG PLANTS: ${catalogText}

PREVIOUS BRIEFING: ${prevSummary}

Rules: Only cite evidence from the data above. Link conclusions to cluster IDs. Do not invent demand.

Pick the 3–5 strongest patterns by signal volume, question volume, source diversity, and growth.

Return ONLY valid JSON — no markdown:
{
  "summary": "2-3 sentence plain-English briefing summary",
  "signal_count": ${newSignalCount},
  "cluster_count": ${totalClusters},
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
      "related_owned_content": "title or null",
      "why_prominent": "1-2 sentences"
    }
  ]
}`;
}


// ── CALL 2: ACTIONS PROMPT (~800 token output) ─────────────────────────────────
function buildActionsPrompt(ctx, prominentTopics) {
  const { clusterSummaries, totalClusters } = ctx;

  const topicsText = prominentTopics.length
    ? prominentTopics.map(t =>
        `- "${t.theme}" (cluster_ids: ${(t.cluster_ids || []).join(", ")}): ${t.why_prominent}`
      ).join("\n")
    : "None identified yet";

  // Compact cluster list for actions context (ID + title + status only)
  const compactClusters = clusterSummaries;

  return `You are generating Part 2 of an AI Discovery Briefing for Succulents Box (succulent plant subscriptions).
Part 1 already identified the prominent topics. Now flag what needs a reviewer decision and what should be cleaned up.

PROMINENT TOPICS FROM PART 1:
${topicsText}

CLUSTERS (for reference — ID, title, signals, status):
${compactClusters}

Rules:
- AI must NOT merge, dismiss, or approve anything automatically — only suggest.
- Link every item to a specific cluster ID.
- Preserve minority and contradictory signals.

ATTENTION ITEMS: Up to 5 clusters needing a reviewer decision (prioritize high signal + no action taken).
recommended_action values: "Move to Content Review" | "Needs research" | "Keep watching" | "Review owned-content match" | "Review catalog match" | "Send to Market Watch" | "Send to Competitor Activity" | "No action yet"

CLEANUP SUGGESTIONS: Up to 5 clusters to dismiss, merge, reroute, or flag.
suggestion_type values: "Dismiss" | "Reroute" | "Merge" | "Split" | "Keep watching" | "Needs research" | "Needs catalog review" | "Needs source review" | "Move to Content Review"

Return ONLY valid JSON — no markdown:
{
  "attention_items": [
    {
      "reason": "short reason label",
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
      "suggested_destination": "target section or null",
      "suggested_match_cluster_id": "uuid to merge into or null",
      "reason": "why this action is suggested",
      "confidence": "High | Medium | Low",
      "evidence_preview": "short excerpt supporting this suggestion"
    }
  ]
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
  const stopReason = data.stop_reason || "unknown";

  // Log to Netlify function logs for debugging
  console.log("[callClaude] stop_reason:", stopReason, "| text_length:", text.length);
  console.log("[callClaude] text_preview:", text.slice(0, 400));

  if (stopReason === "max_tokens") {
    throw new Error(`Claude output truncated (hit max_tokens=${maxTokens}). Text so far: ${text.slice(0, 300)}`);
  }

  // Extract JSON — try markdown block first, then bare object
  const mdMatch  = text.match(/```json\n?([\s\S]*?)\n?```/);
  const rawMatch = text.match(/\{[\s\S]*\}/);
  const raw = mdMatch?.[1] || rawMatch?.[0];
  if (!raw) throw new Error("No JSON found in Claude response. Raw: " + text.slice(0, 300));

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Invalid JSON from Claude: " + e.message + " | Raw snippet: " + raw.slice(0, 300));
  }
}
