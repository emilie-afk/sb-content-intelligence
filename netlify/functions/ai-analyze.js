/**
 * Netlify Function: ai-analyze
 *
 * Analyzes signals, briefs, and scripts using Claude.
 * Called by the dashboard when reviewing content.
 *
 * POST /.netlify/functions/ai-analyze
 * Body: { type: "signal"|"brief"|"script", data: { ...fields } }
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!CLAUDE_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "CLAUDE_API_KEY not set in Netlify environment variables." }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { type, data } = body;
  if (!type || !data) return { statusCode: 400, headers, body: JSON.stringify({ error: "type and data are required" }) };

  try {
    let prompt, result;

    // Fetch plant watchlist for revenue priority matching
    const { data: watchlist } = await supabase
      .from("plant_watchlist")
      .select("plant_name, revenue_tier, priority_level, stock_status, top_products")
      .order("revenue", { ascending: false });
    const watchlistText = watchlist?.length
      ? watchlist.map(p => {
          const products = p.top_products
            ? p.top_products.split(" || ").slice(0, 8).join(", ")
            : null;
          return `${p.plant_name}${products ? ` — known products: ${products}` : ""}`;
        }).join("\n")
      : "No watchlist loaded yet";

    if (type === "signal") {
      prompt = buildSignalPrompt(data, watchlistText);
      result = await callClaude(prompt);
      // Update signal in DB including revenue priority
      if (data.id && result) {
        await supabase.from("signals").update({
          topic:                  result.topic           || data.topic,
          plant_or_product:       result.plant_product   || data.plant_or_product,
          priority:               result.priority        || data.priority,
          shelf_life:             result.shelf_life      || data.shelf_life,
          signal_type:            result.signal_type     || data.signal_type,
          audience_problem:       result.why_matters     || data.audience_problem,
          ai_cleanup_notes:       result.suggestions     || data.ai_cleanup_notes,
          revenue_priority_match: result.revenue_priority_match || null,
          revenue_priority_note:  result.revenue_priority_note  || null,
        }).eq("id", data.id);
      }

    } else if (type === "brief") {
      prompt = buildBriefPrompt(data, watchlistText);
      result = await callClaude(prompt);

    } else if (type === "opportunity") {
      // Fetch content history from the 2026 Google Sheet (all monthly tabs)
      let sheetEntries = [];
      try {
        const { data: setting } = await supabase
          .from("settings").select("value").eq("key", "calendar_script_url").single();
        const scriptUrl = setting?.value?.url;
        if (scriptUrl) {
          const sheetResp = await fetch(scriptUrl, { method: "GET", redirect: "follow" });
          const sheetData = await sheetResp.json();
          sheetEntries = sheetData?.entries || [];
        }
      } catch (sheetErr) {
        console.warn("Could not fetch sheet history:", sheetErr.message);
      }

      // Also fetch any manually logged published videos from Supabase
      const { data: dbPublished } = await supabase
        .from("published_videos")
        .select("video_title, topic, plant_or_product, hook_used, angle_used, platform, publish_date, performance_summary, audience_followup_questions")
        .order("publish_date", { ascending: false })
        .limit(30);

      prompt = buildOpportunityPrompt(data, watchlistText, sheetEntries, dbPublished || []);
      result = await callClaude(prompt);
      // Save repetition fields back to opportunity
      if (data.id && result) {
        await supabase.from("opportunities").update({
          similar_published_url:     result.similar_published_url     || null,
          similar_published_date:    result.similar_published_date     || null,
          days_since_similar:        result.days_since_similar         || null,
          previous_plant:            result.previous_plant             || null,
          previous_hook:             result.previous_hook              || null,
          previous_angle:            result.previous_angle             || null,
          previous_format:           result.previous_format            || null,
          previous_performance:      result.previous_performance       || null,
          audience_followup_demand:  result.audience_followup_demand   || null,
          new_angle_available:       result.new_angle_available        ?? null,
          freshness_reason:          result.freshness_reason           || null,
          repetition_risk:           result.repetition_risk            || null,
          repetition_recommendation: result.repetition_recommendation  || null,
        }).eq("id", data.id);
      }

    } else if (type === "script") {
      // Fetch brand rules from DB
      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");
      prompt = buildScriptPrompt(data, rules || []);
      result = await callClaude(prompt);

    } else if (type === "cluster") {
      // ── DISCOVERY CLUSTERING ──────────────────────────────────────────────
      // 1. Extract structured signal from raw input
      // 2. Check for duplicate signals
      // 3. Find matching cluster or create new one
      // 4. Update cluster counts + check pattern qualification
      // 5. Run owned-channel + repetition check if pattern qualifies
      // 6. Create/update Content Review candidate if needed

      const signalId = data.id;
      if (!signalId) return { statusCode: 400, headers, body: JSON.stringify({ error: "signal id required for clustering" }) };

      // Step 1: Extract structured meaning from the signal
      const extractPrompt = buildExtractionPrompt(data);
      const extracted = await callClaude(extractPrompt);

      // Step 2: Fetch existing clusters to find a match
      const { data: existingClusters } = await supabase
        .from("discovery_clusters")
        .select("id, title, primary_question, plant_or_product, problems_mentioned, tips_mentioned, audience_wording, signal_count, status")
        .not("status", "eq", "Closed")
        .order("signal_count", { ascending: false })
        .limit(40);

      // Step 3: Ask Claude to match or create
      const matchPrompt = buildClusterMatchPrompt(extracted, existingClusters || []);
      const matchResult = await callClaude(matchPrompt);

      let clusterId;
      let cluster;

      if (matchResult.match_type === "existing" && matchResult.cluster_id) {
        // Attach to existing cluster
        clusterId = matchResult.cluster_id;
        const { data: existing } = await supabase
          .from("discovery_clusters").select("*").eq("id", clusterId).single();
        cluster = existing;

        // Merge new audience wording + evidence
        const mergedWording  = [...new Set([...(cluster.audience_wording || []), ...(extracted.audience_wording || [])])].slice(0, 20);
        const mergedProblems = [...new Set([...(cluster.problems_mentioned || []), ...(extracted.problems || [])])].slice(0, 10);
        const mergedTips     = [...new Set([...(cluster.tips_mentioned || []), ...(extracted.tips || [])])].slice(0, 10);
        const mergedEvidenceTypes = [...new Set([...(cluster.evidence_types || []), extracted.evidence_type].filter(Boolean))];

        await supabase.from("discovery_clusters").update({
          signal_count:         (cluster.signal_count || 0) + 1,
          question_count:       extracted.evidence_type === "Question" ? (cluster.question_count || 0) + 1 : cluster.question_count,
          last_seen_at:         new Date().toISOString(),
          audience_wording:     mergedWording,
          problems_mentioned:   mergedProblems,
          tips_mentioned:       mergedTips,
          evidence_types:       mergedEvidenceTypes,
          recent_mention_count: (cluster.recent_mention_count || 0) + 1,
        }).eq("id", clusterId);

      } else {
        // Create new cluster
        const { data: newCluster, error: clusterErr } = await supabase
          .from("discovery_clusters")
          .insert({
            title:               extracted.cluster_title || extracted.question || data.topic || "Untitled cluster",
            summary:             extracted.summary,
            plant_or_product:    extracted.plant || data.plant_or_product,
            primary_question:    extracted.question,
            problems_mentioned:  extracted.problems || [],
            tips_mentioned:      extracted.tips || [],
            audience_wording:    extracted.audience_wording || [],
            evidence_types:      extracted.evidence_type ? [extracted.evidence_type] : [],
            signal_count:        1,
            question_count:      extracted.evidence_type === "Question" ? 1 : 0,
            distinct_source_count: 1,
            platforms:           data.platform ? [data.platform] : [],
            first_seen_at:       new Date().toISOString(),
            last_seen_at:        new Date().toISOString(),
            recent_mention_count: 1,
            novelty_status:      extracted.novelty_status || "Unclear",
            revenue_priority_match: extracted.revenue_priority_match || "Needs check",
            ai_confidence:       extracted.confidence || "Medium",
            ai_reason:           "Auto-created from signal " + signalId,
          })
          .select().single();
        if (clusterErr) throw new Error("Could not create cluster: " + clusterErr.message);
        clusterId = newCluster.id;
        cluster   = newCluster;
      }

      // Link signal to cluster (ignore duplicate link errors)
      await supabase.from("signal_cluster_links").upsert({
        signal_id:    signalId,
        cluster_id:   clusterId,
        match_reason: matchResult.match_reason || "Auto-matched",
        is_duplicate: matchResult.is_duplicate || false,
      }, { onConflict: "signal_id,cluster_id", ignoreDuplicates: true });

      // Update signal status
      await supabase.from("signals").update({ status: "Clustered" }).eq("id", signalId);

      // Refresh cluster from DB
      const { data: refreshed } = await supabase
        .from("discovery_clusters").select("*").eq("id", clusterId).single();
      cluster = refreshed;

      // Step 4: Check pattern qualification
      const qualifies = checkQualification(cluster);

      if (qualifies && cluster.status === "Collecting") {
        await supabase.from("discovery_clusters")
          .update({ status: "Pattern detected" }).eq("id", clusterId);
      }

      // Step 5+6: If pattern qualifies and no active candidate exists, create one
      if (qualifies) {
        const { data: existingCandidate } = await supabase
          .from("content_review_candidates")
          .select("id, status")
          .eq("cluster_id", clusterId)
          .not("status", "in", '("Dismissed","Already covered")')
          .single();

        if (!existingCandidate) {
          // Fetch owned-channel history for repetition check
          let sheetEntries = [];
          try {
            const { data: setting } = await supabase
              .from("settings").select("value").eq("key", "calendar_script_url").single();
            const scriptUrl = setting?.value?.url;
            if (scriptUrl) {
              const sheetResp = await fetch(scriptUrl, { method: "GET", redirect: "follow" });
              const sheetData = await sheetResp.json();
              sheetEntries = sheetData?.entries || [];
            }
          } catch (e) { console.warn("Sheet fetch failed:", e.message); }

          const { data: dbPublished } = await supabase
            .from("published_videos")
            .select("video_title, topic, plant_or_product, hook_used, angle_used, platform, publish_date, performance_summary, audience_followup_questions")
            .order("publish_date", { ascending: false }).limit(30);

          const candidatePrompt = buildCandidatePrompt(cluster, sheetEntries, dbPublished || [], watchlistText);
          const candidateResult = await callClaude(candidatePrompt);

          await supabase.from("content_review_candidates").insert({
            cluster_id:               clusterId,
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
            status:                   candidateResult.candidate_status || "Ready for review",
          });

          await supabase.from("discovery_clusters")
            .update({ status: "Content review ready" }).eq("id", clusterId);
        } else {
          // Update existing candidate counts
          await supabase.from("content_review_candidates").update({
            signal_count:   cluster.signal_count,
            question_count: cluster.question_count,
            last_seen_at:   cluster.last_seen_at,
          }).eq("id", existingCandidate.id);
        }
      }

      result = {
        cluster_id:    clusterId,
        cluster_title: cluster.title,
        match_type:    matchResult.match_type,
        signal_count:  cluster.signal_count,
        qualifies:     !!qualifies,
        qualification_reason: qualifies?.reason || null,
        extracted,
      };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "type must be signal, brief, opportunity, script, or cluster" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, analysis: result }) };

  } catch (err) {
    console.error("ai-analyze error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── SIGNAL PROMPT ─────────────────────────────────────────────────────────────
function buildSignalPrompt(s, watchlistText) {
  return `You are analyzing a social media signal for Succulents Box, a succulent plant subscription company.

RAW INPUT: ${s.topic || s.raw_input || ""}
Platform: ${s.platform || "unknown"}
Source URL: ${s.source_url || "not provided"}
Caption/notes: ${s.caption_summary || "not provided"}

HIGH-REVENUE PLANT WATCHLIST (genus name — revenue tier — stock):
${watchlistText}

Return ONLY valid JSON:
{
  "topic": "short clear topic, e.g. Echeveria etiolation / stretching",
  "plant_product": "plant or product name, e.g. Echeveria, String of Pearls",
  "signal_type": "one of: TikTok manual observation | Instagram manual observation | Facebook Group manual observation | YouTube observation | Competitor observation | Customer comment / DM theme | Other community signal",
  "why_matters": "1 sentence on why this is worth making a video about",
  "priority": "High | Medium | Low",
  "shelf_life": "Trend | Seasonal | Evergreen | Experimental",
  "content_pillar": "one of: Repeated Questions | Common Mistakes | Plant Rescue | Myths and Debates | Experiments | Unusual Plant Features | Seasonal Problems | Trend Adaptation | Product / Catalog Fit",
  "suggestions": "Hook: [one strong opening line] | Format: [e.g. Talking head / Before-after / Tutorial]",
  "catalog_fit": "matched SB product name, or Needs check, or Not applicable",
  "revenue_priority_match": "Yes | No | Needs check",
  "revenue_priority_note": "e.g. Echeveria is High-revenue — strong reason to prioritize. Or: weak demand despite revenue match — watch item only."
}

Rules:
- High priority = strong comment demand + clear product fit.
- If plant matches watchlist AND demand is strong → mark revenue_priority_match Yes, boost priority.
- If plant matches watchlist BUT demand is weak → mark Yes but note watch item, not automatic priority.
- If plant is uncertain → Needs check.
- Keep it factual, no invented metrics.`;
}


// ── OPPORTUNITY / REPETITION PROMPT ──────────────────────────────────────────
function buildOpportunityPrompt(o, watchlistText, sheetEntries, dbPublished) {
  // Sheet entries: all 2026 content from the Google Sheet (planned + published)
  const sheetText = sheetEntries.length
    ? sheetEntries.map(e =>
        `[${e.month}] "${e.title}"${e.style ? " | Style: " + e.style : ""}${e.script && e.script !== "*No script*" ? " | Script excerpt: " + e.script.slice(0, 120) : ""}${e.note ? " | Note: " + e.note : ""}${e.status ? " | Status: " + e.status : ""}`
      ).join("\n")
    : "No sheet entries available";

  // DB published videos: manually logged with hook/angle/performance detail
  const dbText = dbPublished.length
    ? dbPublished.map(p =>
        `- "${p.video_title || p.topic}" | Plant: ${p.plant_or_product || "?"} | Hook: ${p.hook_used || "—"} | Angle: ${p.angle_used || "—"} | Platform: ${p.platform || "?"} | Performance: ${p.performance_summary || "not recorded"} | Follow-up: ${p.audience_followup_questions || "none"}`
      ).join("\n")
    : "";

  // Combine both sources into one history block for the prompt
  const historyLines = [];

  // Sheet entries — these are ALL production scripts (published or scheduled for 2026)
  sheetEntries.forEach(e => {
    const scriptHint = e.script && e.script !== "*No script*" && e.script.trim()
      ? ` | Script: "${e.script.slice(0, 120)}…"`
      : "";
    historyLines.push(`[${e.month} 2026] "${e.title}"${e.style ? " | Style: " + e.style : ""}${scriptHint}${e.note ? " | Note: " + e.note : ""}`);
  });

  // DB published videos (manually logged with hook/angle detail)
  dbPublished.forEach(p => {
    historyLines.push(`[Published ${p.publish_date || "?"}] "${p.video_title || p.topic}" | Plant: ${p.plant_or_product || "?"} | Hook: ${p.hook_used || "—"} | Angle: ${p.angle_used || "—"} | Performance: ${p.performance_summary || "not recorded"}`);
  });

  const historyText = historyLines.length
    ? historyLines.join("\n")
    : "No content history available yet.";

  return `You are reviewing a content opportunity for Succulents Box, a succulent plant subscription company.

OPPORTUNITY:
Topic: ${o.topic || ""}
Plant/product: ${o.plant_or_product || ""}
Why now: ${o.why_now || ""}
Evidence: ${o.evidence_summary || ""}
Suggested hook: ${o.suggested_hook || ""}
Suggested format: ${o.suggested_format || ""}
Platform: ${o.platform || ""}
Shelf life: ${o.shelf_life || ""}

HIGH-REVENUE PLANT WATCHLIST:
${watchlistText}

2026 PRODUCTION CONTENT HISTORY (published or scheduled — all months):
These are real Succulents Box production scripts. Use them to check repetition.
${historyText}

Check whether this opportunity is too similar to something already in production.
Rules:
- Same topic + same plant + same angle = High or Block risk regardless of timing.
- Same topic + different plant = Low risk (usually fine — different visual, different problem).
- Same plant + different care problem = Low risk.
- Same topic + follow-up from audience comments = Low risk, often priority.
- Same topic + new seasonal urgency = Medium risk — needs a distinct hook.
- High revenue alone does not justify repetition.
- "*No script*" entries are ideas only — still count as claimed territory for that month.

Return ONLY valid JSON:
{
  "repetition_risk": "Low | Medium | High | Block",
  "repetition_recommendation": "one clear sentence — can review / hold and revise angle / hold unless new format / do not recommend",
  "freshness_reason": "why this is or is not fresh — one to two sentences",
  "new_angle_available": true,
  "similar_published_url": "link from content history if found, else null",
  "similar_published_date": "month and year if found, e.g. April 2026, else null",
  "days_since_similar": null,
  "previous_plant": "plant from similar entry, or null",
  "previous_hook": "hook from similar entry, or null",
  "previous_angle": "angle from similar entry, or null",
  "previous_format": "format from similar entry, or null",
  "previous_performance": null,
  "audience_followup_demand": "any follow-up question opportunity found, or null",
  "revenue_priority_match": "Yes | No | Needs check",
  "revenue_priority_note": "note if plant is high-revenue"
}

If no similar entry exists, set repetition_risk to Low and similar fields to null.`;
}


// ── BRIEF PROMPT ──────────────────────────────────────────────────────────────
function buildBriefPrompt(b, watchlistText) {
  return `You are reviewing a video brief for Succulents Box, a succulent plant subscription company.

BRIEF TITLE: ${b.title || ""}
TOPIC: ${b.topic || ""}
PLATFORM: ${b.platform || ""}
TARGET AUDIENCE: ${b.target_audience || "not specified"}
KEY MESSAGE: ${b.key_message || "not specified"}
CALL TO ACTION: ${b.cta || "not specified"}
NOTES: ${b.notes || "none"}

HIGH-REVENUE PLANT WATCHLIST (genus — revenue tier — stock):
${watchlistText}

Review this brief and return ONLY valid JSON:
{
  "overall": "Strong | Needs work | Incomplete",
  "strengths": ["strength 1", "strength 2"],
  "gaps": ["what is missing or unclear"],
  "suggested_angles": ["angle 1 not covered", "angle 2"],
  "recommended_script_type": "e.g. TikTok / Reel short script | Longer educational script",
  "suggested_hook": "one strong opening line for this brief",
  "brand_fit": "High | Medium | Low",
  "revenue_priority_match": "Yes | No | Needs check",
  "revenue_priority_note": "note if plant is high-revenue and whether stock is confirmed",
  "notes": "any other recommendations in 1-2 sentences"
}`;
}


// ── SCRIPT PROMPT ─────────────────────────────────────────────────────────────
function buildScriptPrompt(s, rules) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");

  return `You are reviewing a video script for Succulents Box, a succulent plant subscription company.

SCRIPT TITLE: ${s.script_title || ""}
PLATFORM: ${s.platform || ""}
TYPE: ${s.script_type || ""}
HOOK: ${s.opening_hook || "not provided"}
VOICEOVER: ${s.full_voiceover_script || "not provided"}
CTA: ${s.cta || "not provided"}
CAPTION: ${s.caption || "not provided"}

BRAND RULES:
${rulesText || "No rules loaded"}

Review this script and return ONLY valid JSON:
{
  "overall": "Approved | Needs revision | Rejected",
  "score": 85,
  "hook_strength": "Strong | Weak | Missing",
  "cta_present": true,
  "brand_violations": [
    { "severity": "Required|Recommended|Avoid|Forbidden", "rule": "rule name", "issue": "what's wrong", "fix": "how to fix it" }
  ],
  "strengths": ["strength 1"],
  "improvements": ["improvement 1"],
  "notes": "overall 1-2 sentence summary"
}

Score out of 100. brand_violations empty array if none found.`;
}


// ── CALL CLAUDE ───────────────────────────────────────────────────────────────
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


// ── EXTRACTION PROMPT ─────────────────────────────────────────────────────────
// Step 1: Extract structured meaning from a raw signal
function buildExtractionPrompt(signal) {
  return `You are analyzing a social listening signal for Succulents Box, a succulent plant subscription company.

RAW SIGNAL:
Platform: ${signal.platform || "unknown"}
Source URL: ${signal.source_url || "not provided"}
Content: ${signal.raw_input || signal.caption_summary || signal.topic || "not provided"}

Extract what the audience is actually saying. Preserve their exact wording where possible.
Do NOT invent information. Only extract what is clearly present.

Evidence types: Question | Problem report | Tip | Claim | Personal experience | Disagreement | Follow-up request | General mention

Return ONLY valid JSON:
{
  "cluster_title": "plain-language title summarizing what this signal is about, using audience wording when possible",
  "summary": "1-2 sentence plain description of the pattern",
  "plant": "plant or product name, null if not clear",
  "question": "the exact question being asked, or null if not a question",
  "problems": ["problem or symptom mentioned"],
  "tips": ["any care tip or recommendation"],
  "audience_wording": ["exact or near-exact phrases from the audience that should be preserved"],
  "evidence_type": "the single most fitting evidence type from the list above",
  "novelty_status": "Known recurring topic | New audience wording | New question about a known topic | New tip or claim | New contradiction | New plant connected to a known problem | Unclear",
  "revenue_priority_match": "Yes | No | Needs check",
  "confidence": "High | Medium | Low"
}`;
}


// ── CLUSTER MATCH PROMPT ──────────────────────────────────────────────────────
// Step 2: Find best matching cluster or declare new
function buildClusterMatchPrompt(extracted, existingClusters) {
  const clusterList = existingClusters.length
    ? existingClusters.map((c, i) =>
        `[${i}] id:${c.id} | "${c.title}" | plant:${c.plant_or_product || "?"} | signals:${c.signal_count} | question:"${c.primary_question || "—"}" | wording:${(c.audience_wording || []).slice(0, 3).join(" / ")}`
      ).join("\n")
    : "No existing clusters";

  return `You are matching a new signal extraction to an existing discovery cluster for Succulents Box.

NEW SIGNAL EXTRACTION:
Title: ${extracted.cluster_title}
Plant: ${extracted.plant || "unknown"}
Question: ${extracted.question || "none"}
Problems: ${(extracted.problems || []).join(", ") || "none"}
Tips: ${(extracted.tips || []).join(", ") || "none"}
Audience wording: ${(extracted.audience_wording || []).join(", ") || "none"}
Evidence type: ${extracted.evidence_type || "unknown"}

EXISTING CLUSTERS:
${clusterList}

Rules:
- Match if the new signal addresses the SAME core question, problem, or claim about the SAME plant.
- Different plant = different cluster, even if the question is similar.
- Different stage of the same problem (e.g. "how to prevent rot" vs "my plant is rotting") should be separate clusters.
- If no good match exists, declare "new".
- Do NOT force a match if uncertain.

Return ONLY valid JSON:
{
  "match_type": "existing" or "new",
  "cluster_id": "UUID of best matching cluster, or null if new",
  "match_reason": "one sentence explaining the match or why no match was found",
  "is_duplicate": false
}`;
}


// ── CANDIDATE PROMPT ──────────────────────────────────────────────────────────
// Step 3: Prepare a Content Review candidate card for a qualifying cluster
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

Repetition risk: Low | Medium | High | Block | Needs reviewer check
Candidate status: Ready for review | Recommended follow-up | Needs research | Needs reviewer check | Hold for repetition | Already covered

Return ONLY valid JSON:
{
  "title": "candidate title using audience language",
  "what_people_are_saying": "2-3 sentence summary of what the audience is asking or saying",
  "representative_wording": ["exact audience phrases, up to 5"],
  "pattern_growth": "description of how this pattern has grown over time",
  "evidence_urls": [],
  "what_appears_new": "what is genuinely new about this pattern vs existing content, or null",
  "claims_needing_verification": "any care claims that need fact-checking, or null",
  "contradictory_advice": "if sources disagree, describe both positions, or null",
  "closest_published_title": "title of most similar owned content, or null",
  "closest_published_urls": [],
  "closest_published_date": "YYYY-MM-DD or null",
  "days_since_similar": null,
  "previous_performance": "performance summary of closest content, or null",
  "audience_followup_demand": "any follow-up question demand found, or null",
  "repetition_risk": "Low | Medium | High | Block | Needs reviewer check",
  "freshness_reason": "why this is or is not fresh — 1-2 sentences",
  "same_topic": null,
  "same_plant": null,
  "same_question": null,
  "same_advice": null,
  "same_hook_or_angle": null,
  "possible_directions": ["Answer the repeated question", "Verify the claim", "Compare conflicting advice"],
  "ai_confidence": "High | Medium | Low",
  "candidate_status": "Ready for review | Recommended follow-up | Needs research | Needs reviewer check | Hold for repetition | Already covered"
}`;
}


// ── PATTERN QUALIFICATION ─────────────────────────────────────────────────────
// Returns { qualifies: true, reason } or false
function checkQualification(cluster) {
  const sc = cluster.signal_count || 0;
  const qc = cluster.question_count || 0;
  const dc = cluster.distinct_source_count || 0;
  const rc = cluster.recent_mention_count || 0;
  const pc = cluster.previous_mention_count || 0;

  if (qc >= 3)  return { qualifies: true, reason: `${qc} independent question signals` };
  if (dc >= 2)  return { qualifies: true, reason: `${dc} distinct sources` };
  if (pc > 0 && rc >= pc * 2) return { qualifies: true, reason: `Mention count doubled: ${pc} → ${rc}` };
  if (cluster.novelty_status === "New tip or claim") return { qualifies: true, reason: "New tip or claim needs verification" };
  if (cluster.contradiction_status === "Detected") return { qualifies: true, reason: "Conflicting advice detected" };
  if (cluster.reviewer_status === "Pinned") return { qualifies: true, reason: "Manually pinned by reviewer" };

  return false;
}
