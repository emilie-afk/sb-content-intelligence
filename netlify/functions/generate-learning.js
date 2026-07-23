/**
 * Netlify Function: generate-learning
 *
 * Reads published_videos where learning_status = 'Ready', generates
 * a draft learning_memory row for each one, then marks the video
 * learning_status = 'Processed'.
 *
 * Memories are created with status = 'Needs review next time' so the
 * team can approve or edit before they influence AI briefs.
 *
 * POST (no body required)
 * Can be called from dashboard or GitHub Actions.
 */

const { createClient } = require("@supabase/supabase-js");
const { CORS_HEADERS } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Allow internal secret (GitHub Actions) or authenticated admin/owner
  const internalSecret = event.headers["x-internal-secret"];
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    const { requireUserRole } = require("./_auth");
    const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
    if (authError) return authError;
  }

  try {
    // ── 1. Fetch all videos ready for learning generation ─────────────────
    const { data: videos, error: fetchErr } = await supabase
      .from("published_videos")
      .select(`
        id, topic, platform, publish_datetime, views_count, views_day,
        likes_count, comments_count, saves_count, shares_count, follows_count,
        performance_tier, performance_summary,
        script_outputs ( id, opening_hook, performance_note )
      `)
      .eq("learning_status", "Ready")
      .not("performance_tier", "is", null);

    if (fetchErr) {
      console.error("Fetch error:", fetchErr.message);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: fetchErr.message }),
      };
    }

    if (!videos || videos.length === 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generated: 0, message: "No videos ready for learning" }),
      };
    }

    // ── 2. Generate a draft learning_memory for each video ────────────────
    let generated = 0;
    let errors = 0;

    for (const video of videos) {
      const memory = await buildMemory(video);

      const { error: insertErr } = await supabase
        .from("learning_memory")
        .insert(memory);

      if (insertErr) {
        console.error("learning_memory insert failed:", insertErr.message, "video:", video.id);
        errors++;
        continue;
      }

      // Mark video as processed so we don't re-generate
      await supabase
        .from("published_videos")
        .update({ learning_status: "Processed" })
        .eq("id", video.id);

      generated++;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generated,
        errors,
        skipped: videos.length - generated - errors,
        total_ready: videos.length,
      }),
    };

  } catch (err) {
    console.error("generate-learning error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Build a learning_memory row from a published_videos record ────────────────
async function buildMemory(video) {
  const tier   = video.performance_tier || "unknown";
  const views  = video.views_count;
  const day    = video.views_day;
  const rawTopic = video.topic || null;
  const script = Array.isArray(video.script_outputs)
    ? video.script_outputs[0]
    : video.script_outputs;
  const hook        = script?.opening_hook || null;
  const scriptTitle = script?.id ? (script.script_title || "Linked script") : null;

  // Clean topic — strip hashtags, take first sentence, max 80 chars
  const cleanTopic = rawTopic ? cleanTopicText(rawTopic) : null;

  // Determine applies_to
  const appliesTo = hook ? "Hook" : cleanTopic ? "Topic" : "Format";

  // Build what_happened — stats only, no quoted caption
  const viewStr  = views != null ? `${views.toLocaleString()} views (Day ${day || "?"})` : "unknown views";
  const engParts = [
    video.likes_count    ? `${video.likes_count} likes`    : null,
    video.saves_count    ? `${video.saves_count} saves`    : null,
    video.comments_count ? `${video.comments_count} comments` : null,
    video.shares_count   ? `${video.shares_count} shares`  : null,
    video.follows_count  ? `${video.follows_count} follows gained` : null,
  ].filter(Boolean);
  const engStr = engParts.length ? ` — ${engParts.join(", ")}` : "";
  const platformLabel = video.platform ? ` on ${video.platform}` : "";
  const whatHappened = `${tierLabel(tier)}${platformLabel}: ${viewStr}${engStr}.`;

  // Parse "What worked" / "Improve" notes from the human-filled sheet columns
  const { whatWorked, improve } = parsePerformanceSummary(video.performance_summary);

  // Generate recommendation via Claude using actual video data
  const recommendation = await generateRecommendation({
    tier, cleanTopic, hook, views, day, video, whatWorked, improve,
    scriptTitle,
  });

  // Confidence based on which day's data we have
  const confidence = day === 3 ? "High" : day === 2 ? "Medium" : "Low";

  // evidence_summary: full performance summary + script info
  const evidenceParts = [
    video.performance_summary || null,
    scriptTitle ? `Script used: "${scriptTitle}"` : null,
    hook ? `Opening hook: "${hook.substring(0, 200)}${hook.length > 200 ? "…" : ""}"` : null,
  ].filter(Boolean);

  return {
    applies_to:               appliesTo,
    topic:                    cleanTopic,
    hook:                     hook ? hook.substring(0, 500) : null,
    format:                   video.platform || null,
    source:                   scriptTitle,   // visible in dashboard as script attribution
    what_happened:            whatHappened,
    evidence_summary:         evidenceParts.join("\n\n") || null,
    recommendation_next_time: recommendation,
    confidence,
    status:                   "Needs review next time",
    published_video_id:       video.id,
    date_added:               new Date().toISOString().slice(0, 10),
  };
}

// Strip hashtags and take first clean sentence, max 80 chars
function cleanTopicText(raw) {
  // Remove hashtags and trim
  let clean = raw.replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  // Take up to first period, question mark, or exclamation
  const match = clean.match(/^[^.!?]+[.!?]?/);
  clean = match ? match[0].trim() : clean;
  // Truncate
  if (clean.length > 80) clean = clean.substring(0, 77) + "…";
  return clean || null;
}

function tierLabel(tier) {
  const labels = {
    "Doing something good!":  "🏆 Top performer",
    "Normal":                 "✅ Normal",
    "Needs huge improvement": "⚠️ Underperformed",
    "Unacceptable":           "❌ Very low performance",
  };
  return labels[tier] || tier;
}

// ── Parse human-filled "What worked" and "Improve" notes from performance_summary ──
function parsePerformanceSummary(summary) {
  if (!summary) return { whatWorked: null, improve: null };
  const w = summary.match(/What worked:\s*(.+?)(?:\n|$)/i);
  const i = summary.match(/What to improve:\s*(.+?)(?:\n|$)/i);
  return {
    whatWorked: w ? w[1].trim() : null,
    improve:    i ? i[1].trim() : null,
  };
}

// ── Call Claude to generate an actual analysis ────────────────────────────────
async function generateRecommendation({ tier, cleanTopic, hook, views, day, video, whatWorked, improve, scriptTitle }) {
  if (!CLAUDE_API_KEY) {
    return "CLAUDE_API_KEY not set — cannot generate analysis.";
  }

  const saves    = video.saves_count    || 0;
  const likes    = video.likes_count    || 0;
  const comments = video.comments_count || 0;
  const shares   = video.shares_count   || 0;
  const follows  = video.follows_count  || 0;

  const prompt = `You are analyzing the performance of a short-form social media video for Succulent Box, a plant subscription brand.

VIDEO DATA:
- Topic: ${cleanTopic || "unknown"}
- Platform: ${video.platform || "unknown"}
- Performance tier: ${tier}
- Views: ${views != null ? views.toLocaleString() : "unknown"} (measured on Day ${day || "?"})
- Likes: ${likes} | Saves: ${saves} | Comments: ${comments} | Shares: ${shares} | Follows gained: ${follows}
${hook ? `- Opening hook used: "${hook.replace(/#\w+/g, "").trim().substring(0, 150)}"` : ""}
${scriptTitle ? `- Script used: "${scriptTitle}"` : ""}
${whatWorked ? `- Team note — what worked: ${whatWorked}` : ""}
${improve ? `- Team note — what to improve: ${improve}` : ""}

Write 2-3 sentences of specific, actionable analysis for the content team. Focus on:
1. What the engagement numbers actually tell us (e.g. save rate, like-to-view ratio, follows)
2. What specifically to do differently or repeat next time
3. If team notes are provided, synthesize them with the numbers

Be direct and specific. Do NOT use generic phrases like "consider testing" or "look at what worked". Reference the actual numbers. Write as if advising a content creator who posted this video yesterday.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 300,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) {
      console.error("Claude API error:", data.error.message);
      return `Analysis unavailable: ${data.error.message}`;
    }
    return data.content?.[0]?.text?.trim() || "No analysis returned.";
  } catch (err) {
    console.error("Claude call failed:", err.message);
    return `Analysis unavailable: ${err.message}`;
  }
}
