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
const { requireUserRole, CORS_HEADERS: headers } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";  // Haiku: fast enough for 10s Netlify timeout
const PROMPT_VERSION = "briefing-v1";

exports.handler = async (event) => {

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const authError = await requireUserRole(event, supabase, ["admin", "owner", "assistant"]);
  if (authError) return authError;

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
        signal_count, audience_signal_count, manual_signal_count, owned_comment_signal_count,
        question_count, distinct_source_count,
        platforms, audience_wording, problems_mentioned, tips_mentioned,
        first_seen_at, last_seen_at, recent_mention_count, previous_mention_count,
        novelty_status, contradiction_status, ai_confidence, status,
        maintenance_status, review_required, last_ai_updated_at, new_signals_since_review,
        ai_update_summary, revenue_priority_match,
        audience_recurring_boolean, repetition_source_type, covered_before_boolean`)
      .not("status", "in", '("Closed","Blocked irrelevant","Brief created","Published")')
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
      { data: learningMemoryRows },
    ] = await Promise.all([
      clusterQuery,
      supabase.from("signals")
        .select("id, raw_input, platform, source_url, status, created_at, signal_purpose, section_route")
        .gte("created_at", periodStart).order("created_at", { ascending: false }).limit(100),
      supabase.from("discovery_clusters")
        .select("id, title, last_seen_at, new_signals_since_review, ai_update_summary")
        .gte("last_seen_at", periodStart).not("status", "in", '("Closed","Blocked irrelevant","Brief created","Published")').limit(50),
      supabase.from("discovery_briefings")
        .select("id, briefing_type, summary, prominent_topics, generated_at")
        .eq("briefing_type", briefingType).order("generated_at", { ascending: false }).limit(1),
      supabase.from("competitor_activity")
        .select("id, plant_name, activity_type, ai_summary, source_account_name, source_account_handle, observed_at, status")
        .gte("observed_at", periodStart)
        .not("status", "in", '("Dismissed","Reviewed")')
        .order("observed_at", { ascending: false }).limit(10),
      supabase.from("market_watch_plants")
        .select("id, plant_name, signal_count, question_count, purchase_intent_count, distinct_source_count, platforms, last_seen_at, reviewer_status")
        .gte("last_seen_at", periodStart)
        // Skip plants the reviewer already handled — Done on the Today board sets
        // reviewer_status='Reviewed' so the alert doesn't reappear every day
        .or('reviewer_status.is.null,reviewer_status.not.in.("Reviewed","Dismissed")')
        .order("signal_count", { ascending: false }).limit(10),
      supabase.from("published_videos")
        .select("video_title, topic, plant_or_product, platform, publish_date, performance_summary, audience_followup_questions")
        .order("publish_date", { ascending: false }).limit(15),
      supabase.from("plant_watchlist")
        .select("plant_name, top_products").order("priority_level", { ascending: true }).limit(30),
      supabase.from("sb_products")
        .select("handle, title, common_name, scientific_name, genus")
        .eq("is_active", true),
      // Learning memory: all non-archived lessons from past content reviews
      // Includes 'Needs review next time' so team can see learning before formal approval
      supabase.from("learning_memory")
        .select("applies_to, topic, what_happened, recommendation_next_time, confidence, status")
        .neq("status", "Archived")
        .order("date_added", { ascending: false })
        .limit(30),
    ]);

    const activeClusters   = clusters          || [];
    const newSignals        = recentSignals     || [];
    const clustersChanged   = changedClusters   || [];
    const previousBriefing  = prevBriefings?.[0] || null;
    const learningMemory    = learningMemoryRows || [];

    // ── LEARNING MEMORY BLOCK ─────────────────────────────────────────────────
    // Compact text injected into Claude prompt: what's worked, what to avoid.
    const learningBlock = learningMemory.length
      ? learningMemory.map(m =>
          `[${m.applies_to || "general"}${m.topic ? ` · ${m.topic}` : ""}] ${m.what_happened} → ${m.recommendation_next_time}`
        ).join("\n")
      : null;

    // ── PUBLISHED PERFORMANCE LOOKUP ──────────────────────────────────────────
    // Maps normalised plant/topic → { performance_summary, followup_questions }
    // Used both in scoring (boost clusters with proven audience demand) and in
    // the Claude summary prompt (so it can mention what has already worked).
    const normStr = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const perfMap = new Map();
    for (const v of (ownedContent || [])) {
      const key = normStr(v.plant_or_product || v.topic);
      if (key) perfMap.set(key, v);
    }
    // Filter out reviewer-blocked competitor accounts (marked "Noise" on the Today board)
    let blockedCompetitorAccounts = [];
    try {
      const { data: blockSetting } = await supabase
        .from("settings").select("value").eq("key", "competitor_blocked_accounts").single();
      blockedCompetitorAccounts = (blockSetting?.value?.accounts || []).map(a => String(a).toLowerCase());
    } catch (e) { /* no blocklist yet */ }
    const recentCompetitors = (competitorActivity || []).filter(ca => {
      const name   = (ca.source_account_name   || "").toLowerCase();
      const handle = (ca.source_account_handle || "").toLowerCase().replace(/^@/, "");
      return !blockedCompetitorAccounts.some(b => {
        const bh = b.replace(/^@/, "");
        return (name && name === b) || (handle && handle === bh);
      });
    });
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

    // Normalise: lowercase, strip parenthetical scientific names, collapse all whitespace
    // Apply BEFORE building catalog arrays so comparisons are consistent
    const norm = (s) => (s || "").toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, "")  // strip "(Senecio peregrinus)" etc.
      .replace(/\s+/g, " ")           // collapse non-breaking spaces, tabs, double spaces
      .trim();

    // Build lookup sets from live sb_products data (all normalized for consistent matching)
    const catalog = sbProducts || [];
    const catalogTitles    = catalog.map(p => norm(p.title)).filter(Boolean);
    const catalogCommon    = catalog.map(p => norm(p.common_name || "")).filter(Boolean);
    const catalogSci       = catalog.map(p => norm(p.scientific_name || "")).filter(Boolean);
    const catalogGenera    = new Set(catalog.map(p => (p.genus || "").toLowerCase().trim()).filter(Boolean));

    // Specific varieties confirmed NOT in SB catalog.
    // Genus-level match alone isn't enough for highly specific varieties.
    // Add a term here whenever a cluster surfaces a plant you've confirmed you don't carry.
    const NOT_IN_CATALOG = [
      "black widow",        // Gymnocalycium mihanovichii var. black widow — not in SB catalog
      "springbokvlakensis", // Haworthia springbokvlakensis hybrid — not in SB catalog
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

    // ── OPPORTUNITY SCORE ─────────────────────────────────────────────────────
    // Weighted by signal source quality (per planning doc):
    //   Manual submission:    3× (intentional, high-context human observation)
    //   Owned comment:        3× (brand's own audience, high intent)
    //   Question (any source): +2 per question (clear audience need)
    //   Remaining audience:   1× (scraped signals — breadth/trend only)
    //   Audience recurring:  +4 (confirmed pattern across multiple sources)
    //   New signals:         +2 (recent momentum)
    //   Watchlist plant:     +5 (revenue priority)
    //   Follow-up demand:    +3 (published video generated follow-up questions = proven angle)
    // Old owned script matches are excluded from audience_signal_count (v13 field).
    const scoredClusters = activeClusters.map(c => {
      const inCatalog   = isInCatalog(c.plant_or_product);
      const isWatchlist = inCatalog && isWatchlistPlant(c.plant_or_product);

      const asc      = c.audience_signal_count    ?? c.signal_count ?? 0;
      const manual   = c.manual_signal_count       ?? 0;
      const owned    = c.owned_comment_signal_count ?? 0;
      const qc       = c.question_count            ?? 0;
      const scraped  = Math.max(0, asc - manual - owned); // remaining audience signals

      // Performance bonus: check if we've published on this plant/topic before
      const clusterKey = normStr(c.plant_or_product || c.title);
      const priorVideo = perfMap.get(clusterKey) ||
        // fuzzy fallback: find a video whose plant/topic is a substring of the cluster key
        [...perfMap.entries()].find(([k]) => clusterKey.includes(k) || k.includes(clusterKey))?.[1];
      const hasFollowupDemand = priorVideo &&
        Array.isArray(priorVideo.audience_followup_questions) &&
        priorVideo.audience_followup_questions.length > 0;
      const performanceBonus = hasFollowupDemand ? 3 : 0;

      const score =
        manual  * 3 +
        owned   * 3 +
        qc      * 2 +
        scraped * 1 +
        (c.audience_recurring_boolean        ? 4 : 0) +
        ((c.new_signals_since_review ?? 0) > 0 ? 2 : 0) +
        (isWatchlist                          ? 5 : 0) +
        performanceBonus;

      return {
        ...c,
        _inCatalog:       inCatalog,
        _priorVideo:      priorVideo || null,
        _hasFollowupDemand: hasFollowupDemand,
        _isWatchlist: isWatchlist,
        _asc:    asc,
        _manual: manual,
        _owned:  owned,
        _score:  score,
      };
    });

    // Prominent Topics: in-catalog plants only, ranked by score.
    // Threshold uses audience_signal_count (not raw signal_count) — owned archive matches
    // should not inflate a cluster into Prominent Topics.
    const prominentTopics = scoredClusters
      .filter(c => c._inCatalog && (c._asc >= 3 || (c.question_count ?? 0) >= 2))
      .sort((a, b) => b._score - a._score)
      .slice(0, 5)
      .map(c => {
        const catalogLabel = c._isWatchlist ? "⭐ Watchlist plant" :
                             c._inCatalog  ? "In SB catalog"      : "⚠️ Not in catalog";

        // Find past learning memories relevant to this cluster's topic/plant
        const relatedLearning = matchLearningToCluster(c.title, c.plant_or_product, learningMemory);
        const learningHints = relatedLearning.map(m => {
          const statusTag = m.status === "Needs review next time" ? " (draft)" : "";
          return `📚 Past${statusTag}: ${m.recommendation_next_time}`;
        });

        return {
          theme:         c.title,
          cluster_ids:   [c.id],
          signal_count:  c.signal_count,
          source_count:  c.distinct_source_count,
          question_count: c.question_count,
          catalog_plants: c.plant_or_product ? [c.plant_or_product] : [],
          platforms:     c.platforms || [],
          change_from_prior: (c.new_signals_since_review || 0) > 0 ? "growing" : "stable",
          related_owned_content: c._priorVideo?.video_title || null,
          why_prominent: [
            `${c._asc} audience signals`,
            c._manual > 0 ? `${c._manual} manual` : null,
            c._owned  > 0 ? `${c._owned} owned comments` : null,
            c.distinct_source_count > 1 ? `${c.distinct_source_count} sources` : null,
            (c.question_count ?? 0) > 0 ? `${c.question_count} questions` : null,
            c.audience_recurring_boolean ? "Audience recurring" : null,
            c._hasFollowupDemand ? "✅ Proven: audience asked for more" : null,
            c._priorVideo && !c._hasFollowupDemand ? `Prior video: ${c._priorVideo.video_title || "published"}` : null,
            c.covered_before_boolean ? "⚠️ Covered before" : null,
            c.novelty_status && !["None","Unclear"].includes(c.novelty_status) ? c.novelty_status : null,
            catalogLabel,
            ...learningHints,
          ].filter(Boolean).join(" · "),
        };
      });

    // Non-catalog clusters with enough signals → show in Market Watch section
    const nonCatalogClusters = scoredClusters
      .filter(c => (c.signal_count >= 3 || c.question_count >= 2) && !c._inCatalog)
      .sort((a, b) => b._score - a._score)
      .slice(0, 3);

    // market_watch_plants rows — filter out any plant now confirmed in SB catalog
    // (catches historical mis-routing before catalog matching was fixed)
    const trulyNonCatalogMW = marketWatchPlants.filter(mw => !isInCatalog(mw.plant_name));

    // Attention Items: clusters needing reviewer action — catalog plants only
    const attentionItems = scoredClusters
      .filter(c => c._inCatalog && (c.review_required || (c.new_signals_since_review || 0) >= 3 ||
        c.contradiction_status === "Detected" || c.novelty_status === "New tip or claim"))
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
    // Build compact performance text for the top 3 prominent topics
    const topPerformanceNotes = prominentTopics.slice(0, 3)
      .map(t => {
        const c = scoredClusters.find(sc => sc.id === t.cluster_ids?.[0]);
        if (!c?._priorVideo) return null;
        const v = c._priorVideo;
        const parts = [
          `"${t.theme}"`,
          v.performance_summary ? `perf: ${v.performance_summary}` : null,
          c._hasFollowupDemand ? `audience asked follow-up questions` : null,
        ].filter(Boolean);
        return parts.join(" — ");
      })
      .filter(Boolean);

    const summaryPrompt = buildSummaryPrompt({
      totalClusters: activeClusters.length,
      newSignalCount: newSignals.length,
      changedCount: clustersChanged.length,
      topTopics: prominentTopics.slice(0, 3).map(t => t.theme),
      competitorCount: recentCompetitors.length,
      marketWatchCount: trulyNonCatalogMW.length,
      briefingType, periodStart, periodEnd,
      learningBlock,
      topPerformanceNotes,
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

    // Carry over unreviewed items — mark "New today" → "Carried over" (keep them on the board)
    await supabase.from("today_board_items")
      .update({ status: "Carried over", updated_at: now.toISOString() })
      .eq("board_date", boardDate)
      .eq("status", "New today");

    // Get cluster+section combos already on today's board so we don't re-insert them
    const { data: existingBoardItems } = await supabase
      .from("today_board_items")
      .select("cluster_id, section")
      .eq("board_date", boardDate)
      .not("status", "in", '("Resolved","Cleanup confirmed","Already covered","Dismissed")');

    const existingBoardKeys = new Set(
      (existingBoardItems || []).map(i => `${i.section}|${i.cluster_id ?? "null"}`)
    );

    // Cross-day suppression: cluster+section combos the reviewer already resolved
    // on ANY previous day must not be re-inserted on later boards. Without this,
    // "Done" only hid the card for one day and the same alert reappeared tomorrow.
    const { data: priorResolved } = await supabase
      .from("today_board_items")
      .select("cluster_id, section")
      .in("status", ["Resolved", "Cleanup confirmed", "Already covered", "Dismissed", "Move to Content Review"])
      .not("cluster_id", "is", null)
      .limit(1000);
    for (const i of (priorResolved || [])) {
      existingBoardKeys.add(`${i.section}|${i.cluster_id}`);
    }

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

    // Content Candidates — catalog plants only, with status "Pattern detected" or "Content review ready"
    const candidates = scoredClusters
      .filter(c => c._inCatalog && (c.status === "Pattern detected" || c.status === "Content review ready"))
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

    // Market Watch Alerts — from market_watch_plants table (catalog-filtered above)
    for (const mw of trulyNonCatalogMW.slice(0, 3)) {
      todayRows.push({
        briefing_id: briefingId, cluster_id: null,
        section: "Market Watch Alerts", rank: rank++,
        title: `${mw.plant_name} — market activity`,
        summary: `${mw.signal_count} signals, ${mw.question_count} questions`,
        why_today: "Active in market watch this period",
        // Prefix mw.id so the Done button can mark the plant Reviewed without a lookup
        evidence_summary: `[mw:${mw.id}] ${mw.distinct_source_count} sources · ${(mw.platforms || []).join(", ")}`,
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
        // Prefix ca.id so the delete button can extract it without a separate lookup
        evidence_summary: `[ca:${ca.id}] ${ca.activity_type || ''}`,
        ai_confidence: "Medium", recommended_action: "Review competitor activity",
        status: "New today", board_date: boardDate,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    }

    // Only insert items not already on today's board
    const newTodayRows = todayRows.filter(r =>
      !existingBoardKeys.has(`${r.section}|${r.cluster_id ?? "null"}`)
    );
    if (newTodayRows.length > 0) {
      await supabase.from("today_board_items").insert(newTodayRows);
    }
    const todayItemsCount = newTodayRows.length;

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


// ── Match learning memories to a cluster by topic/plant text ─────────────────
// Returns the most relevant memories (up to 2) for a given cluster.
function matchLearningToCluster(clusterTitle, plantOrProduct, learningMemory) {
  if (!learningMemory?.length) return [];
  const needle = `${clusterTitle || ""} ${plantOrProduct || ""}`.toLowerCase();
  return learningMemory
    .filter(m => {
      if (!m.topic) return false;
      const hay = m.topic.toLowerCase();
      // Match if topic words appear in cluster title/plant, or vice versa
      const topicWords = hay.split(/\s+/).filter(w => w.length > 3);
      return topicWords.some(w => needle.includes(w));
    })
    .slice(0, 2);
}

// ── SUMMARY PROMPT (plain text only — no JSON) ────────────────────────────────
function buildSummaryPrompt(ctx) {
  const { totalClusters, newSignalCount, changedCount, topTopics,
    competitorCount, marketWatchCount, briefingType, periodStart, periodEnd,
    learningBlock, topPerformanceNotes } = ctx;

  const performanceSection = topPerformanceNotes?.length
    ? `\nPrior content performance on top topics:\n${topPerformanceNotes.join("\n")}`
    : "";

  const learningSection = learningBlock
    ? `\nLessons from past published videos (use these to shape what you recommend — if we tried a topic/angle and it underperformed, say so; if something drove saves or follows, flag it as worth repeating):\n${learningBlock}`
    : "";

  return `Write 2-3 sentences summarizing this social listening briefing for Succulents Box (succulent plant subscriptions). Highlight what's most actionable based on the data and any lessons below.

Data: ${totalClusters} active discovery clusters, ${newSignalCount} new signals (${periodStart?.slice(0,10)} to ${periodEnd?.slice(0,10)}), ${changedCount} clusters updated.
Top topics: ${topTopics.join(", ") || "none yet"}.
Competitor activity: ${competitorCount} items. Market watch: ${marketWatchCount} plants.${performanceSection}${learningSection}

Write only the 2-3 sentence summary. No intro, no lists, no JSON.`;
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
