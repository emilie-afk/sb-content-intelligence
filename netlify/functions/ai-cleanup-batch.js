/**
 * Netlify Function: ai-cleanup-batch
 *
 * One-time (or periodic) AI pass that classifies existing clusters and routes
 * or removes irrelevant ones from active boards.
 *
 * Actions applied automatically (no reviewer needed):
 *   delete_and_block → status = "Blocked irrelevant"   (clearly irrelevant topic class)
 *   dismiss          → status = "Closed"               (weak but not harmful)
 *   reroute_mention  → status = "Mention only"         (catalog plant, showcase only)
 *
 * Actions queued for reviewer in cluster_review_suggestions:
 *   reroute_market_watch  → non-catalog plant with market demand
 *   reroute_competitor    → mainly about another brand/seller
 *   needs_research        → care claim needing fact-check
 *   merge                 → same audience issue with different wording
 *
 * keep → no change
 *
 * POST /.netlify/functions/ai-cleanup-batch
 * Body: { offset: 0, limit: 15, dry_run: false }
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "cleanup-v1";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!CLAUDE_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "CLAUDE_API_KEY not set" }) };

  let body = {};
  try { if (event.body) body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const offset  = body.offset  ?? 0;
  const limit   = Math.min(body.limit ?? 10, 12); // 10 clusters keeps Claude response under ~1800 tokens and well within timeout
  const dryRun  = body.dry_run ?? false;

  try {
    // ── 1. FETCH BATCH OF CLUSTERS ─────────────────────────────────────────────
    // Process weakest clusters first (lowest signal_count).
    // Skip already-closed, blocked, and "Mention only" clusters — they're already routed.
    const { data: clusters, error: fetchErr } = await supabase
      .from("discovery_clusters")
      .select(`
        id, title, summary, plant_or_product, primary_question,
        signal_count, audience_signal_count, question_count, distinct_source_count,
        problems_mentioned, tips_mentioned, audience_wording,
        novelty_status, status, repetition_source_type,
        first_seen_at, last_seen_at, platforms, ai_confidence
      `)
      .not("status", "in", '("Closed","Blocked irrelevant","Mention only")')
      .order("signal_count", { ascending: true })
      .range(offset, offset + limit - 1);

    if (fetchErr) throw new Error("Fetch error: " + fetchErr.message);
    if (!clusters?.length) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, message: "No clusters to process", processed: 0, actions: {} }),
      };
    }

    // ── 2. FETCH SB CATALOG FOR CATALOG MATCHING (genus list is enough here) ──
    const { data: sbProducts } = await supabase
      .from("sb_products")
      .select("title, common_name, scientific_name, genus")
      .eq("is_active", true);

    const norm = (s) => (s || "").toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const GENERAL_TERMS = ["cactus", "succulent", "air plant", "tillandsia", "houseplant", "plant"];
    const NOT_IN_CATALOG = ["black widow", "springbokvlakensis"];

    const catalog = sbProducts || [];
    const catalogTitles  = catalog.map(p => norm(p.title)).filter(Boolean);
    const catalogCommon  = catalog.map(p => norm(p.common_name || "")).filter(Boolean);
    const catalogSci     = catalog.map(p => norm(p.scientific_name || "")).filter(Boolean);
    const catalogGenera  = new Set(catalog.map(p => (p.genus || "").toLowerCase().trim()).filter(Boolean));

    const isInCatalog = (plantName) => {
      if (!plantName) return true;
      const lc = norm(plantName);
      if (NOT_IN_CATALOG.some(x => lc.includes(x))) return false;
      if (GENERAL_TERMS.some(t => lc.includes(t))) return true;
      if (catalogTitles.some(t => t && (lc.includes(t) || t.includes(lc)))) return true;
      if (catalogCommon.some(c => c && (lc.includes(c) || c.includes(lc)))) return true;
      if (catalogSci.some(s => s && (lc.includes(s) || s.includes(lc)))) return true;
      const words = lc.split(/\s+/);
      if (words.length <= 2 && catalogGenera.has(words[0])) return true;
      return false;
    };

    // ── 3. BUILD PROMPT ────────────────────────────────────────────────────────
    const clusterLines = clusters.map((c, i) => {
      const agedays = c.first_seen_at
        ? Math.round((Date.now() - new Date(c.first_seen_at)) / 86400000)
        : "?";
      const asc = c.audience_signal_count ?? c.signal_count ?? 0;
      const inCat = isInCatalog(c.plant_or_product);
      return [
        `[${i + 1}] ID: ${c.id}`,
        `Title: ${c.title}`,
        `Plant: ${c.plant_or_product || "unspecified"}`,
        `In SB catalog: ${inCat ? "yes" : "no"}`,
        `Status: ${c.status}`,
        `Audience signals: ${asc} | Questions: ${c.question_count ?? 0} | Sources: ${c.distinct_source_count ?? 0}`,
        `Age: ${agedays} days`,
        `Novelty: ${c.novelty_status || "Unclear"}`,
        `Summary: ${c.summary || c.primary_question || "(none)"}`,
        c.problems_mentioned?.length ? `Problems: ${c.problems_mentioned.slice(0, 3).join("; ")}` : null,
        c.tips_mentioned?.length ? `Tips: ${c.tips_mentioned.slice(0, 3).join("; ")}` : null,
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const prompt = `You are cleaning up a social listening Discovery board for Succulents Box, a succulent plant subscription company.

Review each cluster and assign a cleanup action using this decision tree:

DECISION TREE:
1. Is the topic completely unrelated to plants, plant care, plant shopping, or plant gifting?
   → delete_and_block (topic class will keep returning: spam, food, fashion, pets without plants, travel, broken extraction)
   → dismiss (weak/vague/one-off with no plant context — could still be logged)

2. Is the topic plant-related but NOT useful for content planning?
   - Catalog plant BUT only a showcase/photo/positive caption with no question, problem, claim, or confusion → reroute_mention
   - Non-catalog plant with visible collector demand or market interest → reroute_market_watch
   - Mainly about a competitor promotion, giveaway, or sale → reroute_competitor
   - Care claim that could be wrong or risky → needs_research
   - Same audience issue as another cluster with slightly different wording → merge (include which cluster it's similar to in reason)

3. Is the topic useful audience demand that belongs in Discovery? → keep

CONTENT RELEVANCE TEST (keep if any of these are true):
- Audience question about care, identification, selection, or gifting
- Audience problem or confusion about a catalog plant
- Repeated tip or claim across independent sources
- Product selection confusion
- Clear follow-up demand under owned content
- Contradiction worth explaining to audience

AUTO-APPLY rules (no reviewer needed):
- delete_and_block: only for clearly irrelevant topics (no plant connection at all, or spam)
- dismiss: weak plant content, vague, one-off, no content value
- reroute_mention: catalog plant that is only a showcase or aesthetic post

REVIEWER QUEUE (flag but don't auto-apply):
- reroute_market_watch, reroute_competitor, needs_research, merge

CLUSTERS TO CLASSIFY:
${clusterLines}

Return ONLY a JSON array, one object per cluster, in the same order. Keep reasons under 8 words.
[
  {
    "id": "<uuid>",
    "action": "keep|dismiss|reroute_mention|reroute_market_watch|reroute_competitor|needs_research|delete_and_block|merge",
    "confidence": "High|Medium|Low",
    "reason": "under 8 words"
  }
]

No extra text. Just the JSON array.`;

    // ── 4. CALL CLAUDE ─────────────────────────────────────────────────────────
    const decisions = await callClaude(prompt, 2000);

    // Validate: must be array matching cluster count
    if (!Array.isArray(decisions) || decisions.length === 0) {
      throw new Error("Claude returned unexpected format");
    }

    if (dryRun) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, dry_run: true, batch_size: clusters.length, decisions }),
      };
    }

    // ── 5. APPLY DECISIONS ─────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const summary = { keep: 0, dismiss: 0, reroute_mention: 0, delete_and_block: 0, queued_for_review: 0, errors: 0 };

    // Build lookup by id for safety (Claude might return in wrong order)
    const decisionMap = {};
    for (const d of decisions) {
      if (d.id) decisionMap[d.id] = d;
    }

    await Promise.all(clusters.map(async (cluster) => {
      const decision = decisionMap[cluster.id];
      if (!decision) { summary.errors++; return; }

      const action     = decision.action || "keep";
      const confidence = decision.confidence || "Medium";
      const reason     = decision.reason || "";

      try {
        if (action === "keep") {
          summary.keep++;
          return;
        }

        // ── AUTO-APPLY ACTIONS ───────────────────────────────────────────────
        if (action === "delete_and_block") {
          await supabase.from("discovery_clusters").update({
            status:             "Blocked irrelevant",
            maintenance_status: "Blocked irrelevant",
            last_ai_updated_at: now,
            ai_update_summary:  `Cleanup: ${reason}`,
            prompt_version:     PROMPT_VERSION,
          }).eq("id", cluster.id);

          await supabase.from("cluster_audit_log").insert({
            cluster_id:     cluster.id,
            field_changed:  "status",
            previous_value: cluster.status,
            new_value:      "Blocked irrelevant",
            reason:         `AI cleanup (${confidence}): ${reason}`,
            trigger:        "ai_cleanup_batch",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
          });
          summary.delete_and_block++;
          return;
        }

        if (action === "dismiss") {
          await supabase.from("discovery_clusters").update({
            status:             "Closed",
            maintenance_status: "Closed",
            last_ai_updated_at: now,
            ai_update_summary:  `Cleanup dismissed: ${reason}`,
            prompt_version:     PROMPT_VERSION,
          }).eq("id", cluster.id);

          await supabase.from("cluster_audit_log").insert({
            cluster_id:     cluster.id,
            field_changed:  "status",
            previous_value: cluster.status,
            new_value:      "Closed",
            reason:         `AI cleanup dismiss (${confidence}): ${reason}`,
            trigger:        "ai_cleanup_batch",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
          });
          summary.dismiss++;
          return;
        }

        if (action === "reroute_mention") {
          await supabase.from("discovery_clusters").update({
            status:             "Mention only",
            maintenance_status: "Mention only",
            last_ai_updated_at: now,
            ai_update_summary:  `Rerouted to Mention only: ${reason}`,
            prompt_version:     PROMPT_VERSION,
          }).eq("id", cluster.id);

          await supabase.from("cluster_audit_log").insert({
            cluster_id:     cluster.id,
            field_changed:  "status",
            previous_value: cluster.status,
            new_value:      "Mention only",
            reason:         `AI cleanup reroute (${confidence}): ${reason}`,
            trigger:        "ai_cleanup_batch",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
          });
          summary.reroute_mention++;
          return;
        }

        // ── QUEUE FOR REVIEWER ───────────────────────────────────────────────
        // reroute_market_watch, reroute_competitor, needs_research, merge
        const suggestionType = {
          reroute_market_watch: "Reroute",
          reroute_competitor:   "Reroute",
          needs_research:       "Needs research",
          merge:                "Merge",
        }[action] || "Reroute";

        const destination = {
          reroute_market_watch: "Market Watch",
          reroute_competitor:   "Competitor Activity",
          needs_research:       "Needs Research",
          merge:                "Merge with similar",
        }[action] || null;

        await supabase.from("cluster_review_suggestions").insert({
          cluster_id:            cluster.id,
          briefing_id:           null,
          suggestion_type:       suggestionType,
          suggested_destination: destination,
          reason:                `AI cleanup (${confidence}): ${reason}`,
          confidence,
          evidence_preview:      cluster.summary ? cluster.summary.slice(0, 120) : null,
          review_status:         "Pending",
          created_at:            now,
        });

        await supabase.from("cluster_audit_log").insert({
          cluster_id:     cluster.id,
          field_changed:  "maintenance_status",
          previous_value: cluster.maintenance_status || cluster.status,
          new_value:      `Queued: ${destination}`,
          reason:         `AI cleanup suggestion (${confidence}): ${reason}`,
          trigger:        "ai_cleanup_batch",
          ai_model:       CLAUDE_MODEL,
          prompt_version: PROMPT_VERSION,
          is_automatic:   false,
        });
        summary.queued_for_review++;

      } catch (applyErr) {
        console.error("Apply error for cluster", cluster.id, applyErr.message);
        summary.errors++;
      }
    }));

    // ── 6. RETURN RESULT ───────────────────────────────────────────────────────
    const totalProcessed = clusters.length;
    const nextOffset     = offset + totalProcessed;
    const hasMore        = totalProcessed === limit; // if full batch returned, there may be more

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:         true,
        batch_size:      totalProcessed,
        offset,
        next_offset:     hasMore ? nextOffset : null,
        has_more:        hasMore,
        actions:         summary,
        decisions,
      }),
    };

  } catch (err) {
    console.error("ai-cleanup-batch error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── CALL CLAUDE (JSON response) ───────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1200) {
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

  const text = (data.content?.[0]?.text || "").trim();
  // Strip markdown code fences if present
  const jsonStr = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  const arr = JSON.parse(jsonStr);
  if (!Array.isArray(arr)) throw new Error("Expected JSON array from Claude");
  return arr;
}
