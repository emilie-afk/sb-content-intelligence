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
      const memory = buildMemory(video);

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
function buildMemory(video) {
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

  // Build recommendation — no quoting of full caption
  const recommendation = buildRecommendation(tier, cleanTopic, hook);

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

function buildRecommendation(tier, cleanTopic, hook) {
  const topicLabel = cleanTopic ? `"${cleanTopic}"` : "This topic";
  const hookSnip   = hook ? `"${hook.replace(/#\w+/g, "").trim().substring(0, 60)}…"` : null;

  if (tier === "Doing something good!") {
    return [
      `${topicLabel} performs strongly — repeat and build on it.`,
      hookSnip ? `The hook ${hookSnip} worked well — use a similar pattern next time.` : null,
    ].filter(Boolean).join(" ");
  }

  if (tier === "Unacceptable") {
    return [
      `${topicLabel} got very low views. Rethink the angle or format before posting again.`,
      hookSnip ? `The hook ${hookSnip} did not pull viewers in — try a bold curiosity or problem-first opener.` : "Try a bolder, problem-first hook.",
      "Also test a different publish time or platform.",
    ].filter(Boolean).join(" ");
  }

  if (tier === "Needs huge improvement") {
    return [
      `${topicLabel} underperformed. The hook or value proposition needs to be stronger.`,
      hookSnip ? `Current hook ${hookSnip} — try opening with a surprising fact or a direct question instead.` : "Try opening with a surprising fact or direct question.",
      "Look at what worked on top-performing videos in this topic and borrow elements.",
    ].filter(Boolean).join(" ");
  }

  // Normal
  return [
    `${topicLabel} hit expected view counts. Push for top-performer territory next time.`,
    "Test a stronger hook, shorter format, or earlier product mention.",
  ].join(" ");
}
