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
  const topic  = video.topic || null;
  const script = Array.isArray(video.script_outputs)
    ? video.script_outputs[0]
    : video.script_outputs;
  const hook   = script?.opening_hook || null;

  // Determine applies_to
  const appliesTo = hook ? "Hook" : topic ? "Topic" : "Format";

  // Build what_happened — plain-English performance sentence
  const viewStr  = views != null ? `${views.toLocaleString()} views (Day ${day || "?"})` : "unknown views";
  const engParts = [
    video.likes_count    ? `${video.likes_count} likes`    : null,
    video.saves_count    ? `${video.saves_count} saves`    : null,
    video.comments_count ? `${video.comments_count} comments` : null,
    video.shares_count   ? `${video.shares_count} shares`  : null,
    video.follows_count  ? `${video.follows_count} follows gained` : null,
  ].filter(Boolean);
  const engStr = engParts.length ? ` | ${engParts.join(", ")}` : "";

  const whatHappened = [
    `${tierLabel(tier)} — ${viewStr}${engStr}.`,
    hook ? `Hook used: "${hook.substring(0, 120)}${hook.length > 120 ? "…" : ""}"` : null,
  ].filter(Boolean).join(" ");

  // Build recommendation_next_time based on tier
  const recommendation = buildRecommendation(tier, topic, hook, script?.performance_note);

  // Confidence based on which day's data we have
  const confidence = day === 3 ? "High" : day === 2 ? "Medium" : "Low";

  return {
    applies_to:               appliesTo,
    topic:                    topic,
    hook:                     hook ? hook.substring(0, 500) : null,
    format:                   video.platform || null,
    what_happened:            whatHappened,
    evidence_summary:         video.performance_summary || null,
    recommendation_next_time: recommendation,
    confidence,
    status:                   "Needs review next time",
    published_video_id:       video.id,
    date_added:               new Date().toISOString().slice(0, 10),
  };
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

function buildRecommendation(tier, topic, hook, performanceNote) {
  if (tier === "Doing something good!") {
    return [
      topic ? `Repeat content about "${topic}" — this topic performs strongly.` : "This topic performs strongly — repeat it.",
      hook  ? `The hook "${hook.substring(0, 80)}…" drove high views — use a similar pattern.` : null,
    ].filter(Boolean).join(" ");
  }

  if (tier === "Unacceptable") {
    return [
      topic ? `Avoid or significantly rework content about "${topic}" until the format is tested.` : "This content format needs a full rethink.",
      hook  ? `The hook "${hook.substring(0, 80)}…" did not pull viewers — try a stronger curiosity or problem-first opener.` : null,
      "Consider testing a different angle, hook style, or publish time.",
    ].filter(Boolean).join(" ");
  }

  if (tier === "Needs huge improvement") {
    return [
      topic ? `"${topic}" content needs a stronger hook or clearer value proposition.` : "Content needs a stronger hook or clearer value.",
      hook  ? `The hook "${hook.substring(0, 80)}…" underdelivered — test a bolder opening.` : null,
      "Review what worked in higher-performing videos on this topic and borrow elements.",
    ].filter(Boolean).join(" ");
  }

  // Normal
  return [
    topic ? `"${topic}" performs at expected levels. Look for ways to push it into top-performer territory.` : "Performance is normal. Look for angles to boost engagement.",
    "Test variations in hook style, video length, or CTA placement.",
  ].join(" ");
}
