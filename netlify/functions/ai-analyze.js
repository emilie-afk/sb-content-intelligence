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
      .select("plant_name, revenue_tier, priority_level, stock_status")
      .order("revenue", { ascending: false });
    const watchlistText = watchlist?.length
      ? watchlist.map(p => `${p.plant_name} (${p.revenue_tier}, stock: ${p.stock_status})`).join(", ")
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

    } else if (type === "script") {
      // Fetch brand rules from DB
      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");
      prompt = buildScriptPrompt(data, rules || []);
      result = await callClaude(prompt);

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "type must be signal, brief, or script" }) };
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
      max_tokens: 1024,
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
