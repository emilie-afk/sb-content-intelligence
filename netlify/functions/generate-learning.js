/**
 * Netlify Function: generate-learning
 *
 * Reads published_videos where learning_status = 'Ready', generates
 * a draft learning_memory row for each one, then marks the video
 * learning_status = 'Processed'.
 *
 * Analysis is relative to the full batch of published videos —
 * no absolute benchmarks, no platform speculation.
 * Also generates one batch-level pattern summary per run.
 *
 * POST (no body required)
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

  const internalSecret = event.headers["x-internal-secret"];
  if (internalSecret !== process.env.INTERNAL_SECRET) {
    const { requireUserRole } = require("./_auth");
    const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
    if (authError) return authError;
  }

  try {
    // ── 1. Fetch the full batch (all videos with metrics) for comparison ──
    const { data: allVideos } = await supabase
      .from("published_videos")
      .select("id, platform, views_count, views_day, likes_count, saves_count, comments_count, shares_count, follows_count, performance_tier, topic")
      .not("views_count", "is", null)
      .not("performance_tier", "is", null);

    const batch = (allVideos || []).filter(v => v.views_count > 0);
    const batchStats   = computeBatchStats(batch);
    const topicPlatformMap = buildTopicPlatformMap(batch);

    // ── 2. Fetch only videos ready for learning ───────────────────────────
    const { data: readyVideos, error: fetchErr } = await supabase
      .from("published_videos")
      .select(`
        id, topic, platform, publish_datetime, views_count, views_day,
        likes_count, comments_count, saves_count, shares_count, follows_count,
        performance_tier, performance_summary,
        script_outputs ( id, script_title, opening_hook )
      `)
      .eq("learning_status", "Ready")
      .not("performance_tier", "is", null);

    if (fetchErr) {
      return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: fetchErr.message }) };
    }

    if (!readyVideos || readyVideos.length === 0) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generated: 0, message: "No videos ready for learning" }) };
    }

    // ── 3. Generate individual memory for each ready video ────────────────
    let generated = 0;
    let errors    = 0;

    for (const video of readyVideos) {
      const memory = await buildMemory(video, batchStats, topicPlatformMap);

      const { error: insertErr } = await supabase
        .from("learning_memory")
        .insert(memory);

      if (insertErr) {
        console.error("learning_memory insert failed:", insertErr.message, "video:", video.id);
        errors++;
        continue;
      }

      await supabase
        .from("published_videos")
        .update({ learning_status: "Processed" })
        .eq("id", video.id);

      generated++;
    }

    // ── 4. Generate one batch-level pattern summary ───────────────────────
    if (generated > 0 && batch.length >= 3) {
      const batchMemory = await buildBatchSummary(batch, batchStats);
      if (batchMemory) {
        await supabase.from("learning_memory").insert(batchMemory);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generated, errors, total_ready: readyVideos.length, batch_size: batch.length }),
    };

  } catch (err) {
    console.error("generate-learning error:", err);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Compute batch-wide averages and percentiles ───────────────────────────────
function computeBatchStats(batch) {
  if (!batch.length) return null;

  const withViews = batch.filter(v => v.views_count > 0);
  if (!withViews.length) return null;

  const avg = (arr, fn) => arr.reduce((s, v) => s + (fn(v) || 0), 0) / arr.length;

  const avgViews    = avg(withViews, v => v.views_count);
  const avgSaveRate = avg(withViews, v => (v.saves_count || 0) / v.views_count);
  const avgLikeRate = avg(withViews, v => (v.likes_count || 0) / v.views_count);
  const avgFollows  = avg(withViews, v => v.follows_count || 0);
  const avgComments = avg(withViews, v => v.comments_count || 0);

  // Platform breakdown
  const platforms = {};
  for (const v of withViews) {
    const p = (v.platform || "unknown").toLowerCase();
    if (!platforms[p]) platforms[p] = { views: [], saveRates: [] };
    platforms[p].views.push(v.views_count);
    platforms[p].saveRates.push((v.saves_count || 0) / v.views_count);
  }
  const platformSummary = {};
  for (const [p, data] of Object.entries(platforms)) {
    platformSummary[p] = {
      count:       data.views.length,
      avgViews:    Math.round(data.views.reduce((a, b) => a + b, 0) / data.views.length),
      avgSaveRate: (data.saveRates.reduce((a, b) => a + b, 0) / data.saveRates.length * 100).toFixed(2),
    };
  }

  // Tier distribution
  const tierCounts = {};
  for (const v of withViews) {
    const t = v.performance_tier || "unknown";
    tierCounts[t] = (tierCounts[t] || 0) + 1;
  }

  return {
    count:      withViews.length,
    avgViews:   Math.round(avgViews),
    avgSaveRate: (avgSaveRate * 100).toFixed(2),
    avgLikeRate: (avgLikeRate * 100).toFixed(2),
    avgFollows:  avgFollows.toFixed(1),
    avgComments: avgComments.toFixed(1),
    platforms:   platformSummary,
    tierCounts,
  };
}

// ── Rank a single video against same-platform videos only ────────────────────
function rankVideo(video, batchStats) {
  if (!batchStats) return null;
  const views    = video.views_count || 0;
  const saveRate = views > 0 ? (video.saves_count || 0) / views : 0;
  const likeRate = views > 0 ? (video.likes_count || 0) / views : 0;

  // Use same-platform stats if available, fall back to full batch
  const platform   = (video.platform || "").toLowerCase();
  const platStats  = batchStats.platforms[platform];
  const compViews  = platStats ? platStats.avgViews : batchStats.avgViews;
  const compSave   = platStats ? parseFloat(platStats.avgSaveRate) / 100 : parseFloat(batchStats.avgSaveRate) / 100;
  const compLike   = parseFloat(batchStats.avgLikeRate) / 100;
  const compLabel  = platStats ? `other ${platform} videos` : "full batch";

  return {
    viewsVsAvg:    compViews > 0 ? ((views / compViews - 1) * 100).toFixed(0) : null,
    saveRateVsAvg: compSave  > 0 ? ((saveRate / compSave  - 1) * 100).toFixed(0) : null,
    likeRateVsAvg: compLike  > 0 ? ((likeRate / compLike  - 1) * 100).toFixed(0) : null,
    saveRate:      (saveRate * 100).toFixed(2),
    likeRate:      (likeRate * 100).toFixed(2),
    compAvgViews:  compViews,
    compAvgSave:   (compSave * 100).toFixed(2),
    compLabel,
    platformCount: platStats?.count || null,
  };
}

// ── Build topic → platform performance map from full batch ────────────────────
function buildTopicPlatformMap(batch) {
  const map = {}; // topicKey → { platform → { views, saveRate, likeRate } }
  for (const v of batch) {
    if (!v.topic || !v.platform || !v.views_count) continue;
    const key = v.topic.replace(/#\w+/g, "").replace(/\s+/g, " ").trim().substring(0, 60).toLowerCase();
    const p   = v.platform.toLowerCase();
    if (!map[key]) map[key] = {};
    if (!map[key][p]) map[key][p] = [];
    map[key][p].push({
      views:    v.views_count,
      saveRate: v.views_count > 0 ? (v.saves_count || 0) / v.views_count : 0,
      likeRate: v.views_count > 0 ? (v.likes_count || 0) / v.views_count : 0,
    });
  }
  // Average per platform per topic
  const result = {};
  for (const [key, platforms] of Object.entries(map)) {
    result[key] = {};
    for (const [p, entries] of Object.entries(platforms)) {
      result[key][p] = {
        avgViews:    Math.round(entries.reduce((s, e) => s + e.views, 0) / entries.length),
        avgSaveRate: (entries.reduce((s, e) => s + e.saveRate, 0) / entries.length * 100).toFixed(2),
        avgLikeRate: (entries.reduce((s, e) => s + e.likeRate, 0) / entries.length * 100).toFixed(2),
        count:       entries.length,
      };
    }
  }
  return result;
}

// ── Find cross-platform data for this video's topic ───────────────────────────
function getCrossPlatformData(video, topicPlatformMap) {
  if (!video.topic) return null;
  const key = video.topic.replace(/#\w+/g, "").replace(/\s+/g, " ").trim().substring(0, 60).toLowerCase();
  const platforms = topicPlatformMap[key];
  if (!platforms || Object.keys(platforms).length < 2) return null; // only interesting if on multiple platforms

  const thisPlatform = (video.platform || "").toLowerCase();
  const others = Object.entries(platforms).filter(([p]) => p !== thisPlatform);
  if (!others.length) return null;

  return others.map(([p, stats]) =>
    `${p}: ${stats.avgViews.toLocaleString()} views, ${stats.avgSaveRate}% save rate`
  ).join(" | ");
}

// ── Build a learning_memory row for one video ─────────────────────────────────
async function buildMemory(video, batchStats, topicPlatformMap) {
  const tier     = video.performance_tier || "unknown";
  const views    = video.views_count;
  const day      = video.views_day;
  const rawTopic = video.topic || null;
  const script   = Array.isArray(video.script_outputs)
    ? video.script_outputs[0]
    : video.script_outputs;
  const hook        = script?.opening_hook || null;
  const scriptTitle = script?.id ? (script.script_title || "Linked script") : null;
  const cleanTopic  = rawTopic ? cleanTopicText(rawTopic) : null;
  const rank        = rankVideo(video, batchStats);

  const appliesTo = hook ? "Hook" : cleanTopic ? "Topic" : "Format";

  // What happened — numbers + relative position
  const saves    = video.saves_count    || 0;
  const likes    = video.likes_count    || 0;
  const comments = video.comments_count || 0;
  const shares   = video.shares_count   || 0;
  const follows  = video.follows_count  || 0;

  const viewStr  = views != null ? `${views.toLocaleString()} views (Day ${day || "?"})` : "unknown";
  const engStr   = [
    saves    ? `${saves} saves`    : null,
    likes    ? `${likes} likes`    : null,
    comments ? `${comments} comments` : null,
    shares   ? `${shares} shares`  : null,
    follows  ? `${follows} follows` : null,
  ].filter(Boolean).join(", ");

  const rankStr  = rank?.viewsVsAvg != null
    ? ` (${rank.viewsVsAvg > 0 ? "+" : ""}${rank.viewsVsAvg}% vs ${rank.compLabel} avg ${rank.compAvgViews?.toLocaleString()} views)`
    : "";

  const platformLabel = video.platform ? ` on ${video.platform}` : "";
  const whatHappened  = `${tierLabel(tier)}${platformLabel}: ${viewStr}${rankStr}${engStr ? " — " + engStr : ""}.`;

  const { whatWorked, improve } = parsePerformanceSummary(video.performance_summary);
  const crossPlatform = getCrossPlatformData(video, topicPlatformMap);

  const recommendation = await generateRecommendation({
    cleanTopic, hook, views, day, video, whatWorked, improve, scriptTitle, rank, batchStats, crossPlatform,
  });

  const confidence = computeConfidence(video);

  const evidenceParts = [
    `Batch context: avg ${batchStats?.avgViews?.toLocaleString() || "?"} views, ${batchStats?.avgSaveRate || "?"}% save rate, ${batchStats?.avgLikeRate || "?"}% like rate across ${batchStats?.count || "?"} videos.`,
    video.performance_summary || null,
    scriptTitle ? `Script: "${scriptTitle}"` : null,
  ].filter(Boolean);

  return {
    applies_to:               appliesTo,
    topic:                    cleanTopic,
    hook:                     hook ? hook.substring(0, 500) : null,
    format:                   video.platform || null,
    source:                   scriptTitle,
    what_happened:            whatHappened,
    evidence_summary:         evidenceParts.join("\n\n"),
    recommendation_next_time: recommendation,
    confidence,
    status:                   "Needs review next time",
    published_video_id:       video.id,
    date_added:               new Date().toISOString().slice(0, 10),
  };
}

// ── Generate one batch-level pattern summary ──────────────────────────────────
async function buildBatchSummary(batch, batchStats) {
  if (!CLAUDE_API_KEY || !batchStats) return null;

  // Build platform comparison string
  const platformLines = Object.entries(batchStats.platforms)
    .map(([p, d]) => `  ${p}: ${d.count} videos, avg ${d.avgViews.toLocaleString()} views, ${d.avgSaveRate}% save rate`)
    .join("\n");

  // Find top and bottom performers by save rate and views
  const sorted = [...batch].filter(v => v.views_count > 0);
  const byViews    = [...sorted].sort((a, b) => b.views_count - a.views_count);
  const bySaveRate = [...sorted].sort((a, b) => {
    const sa = (a.saves_count || 0) / a.views_count;
    const sb = (b.saves_count || 0) / b.views_count;
    return sb - sa;
  });

  const topByViews = byViews.slice(0, 3).map(v =>
    `"${cleanTopicText(v.topic || "")}" (${v.platform || "?"}, ${v.views_count.toLocaleString()} views)`
  ).join("; ");
  const topBySave  = bySaveRate.slice(0, 3).filter(v => (v.saves_count || 0) > 0).map(v =>
    `"${cleanTopicText(v.topic || "")}" (${v.platform || "?"}, ${(((v.saves_count || 0) / v.views_count) * 100).toFixed(1)}% save rate)`
  ).join("; ");

  const tierLines = Object.entries(batchStats.tierCounts)
    .map(([t, n]) => `  ${t}: ${n} video${n > 1 ? "s" : ""}`)
    .join("\n");

  const prompt = `You are summarizing patterns across a batch of published short-form videos for Succulent Box, a plant subscription brand. Use only the data provided — no platform speculation, no external benchmarks.

BATCH DATA (${batchStats.count} videos total):
- Avg views: ${batchStats.avgViews.toLocaleString()}
- Avg save rate: ${batchStats.avgSaveRate}%
- Avg like rate: ${batchStats.avgLikeRate}%
- Avg follows per video: ${batchStats.avgFollows}
- Avg comments per video: ${batchStats.avgComments}

Performance tier breakdown:
${tierLines}

Platform breakdown:
${platformLines}

Top by views: ${topByViews || "none"}
Top by save rate: ${topBySave || "none — zero saves across batch"}

Write 3-4 sentences identifying the clearest patterns in THIS batch. Compare platforms if there's a difference worth noting. Call out what's getting saves vs. just views — those are different types of value. End with one specific thing to try in the next batch based on what the data shows. No bullet points, no headers, no speculation about platform changes.`;

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
        max_tokens: 400,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) { console.error("Batch summary Claude error:", data.error.message); return null; }

    const summary = data.content?.[0]?.text?.trim();
    if (!summary) return null;

    return {
      applies_to:               "Content pillar",
      topic:                    `Batch summary — ${new Date().toISOString().slice(0, 10)}`,
      what_happened:            `Batch of ${batchStats.count} videos: avg ${batchStats.avgViews.toLocaleString()} views, ${batchStats.avgSaveRate}% save rate. Tier breakdown: ${Object.entries(batchStats.tierCounts).map(([t,n]) => `${n} ${t}`).join(", ")}.`,
      evidence_summary:         `Platform breakdown:\n${platformLines}`,
      recommendation_next_time: summary,
      confidence:               "High",
      status:                   "Needs review next time",
      date_added:               new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.error("Batch summary failed:", err.message);
    return null;
  }
}

// ── Call Claude for individual video analysis ─────────────────────────────────
async function generateRecommendation({ cleanTopic, hook, views, day, video, whatWorked, improve, scriptTitle, rank, batchStats, crossPlatform }) {
  if (!CLAUDE_API_KEY) return "CLAUDE_API_KEY not set.";

  const saves    = video.saves_count    || 0;
  const comments = video.comments_count || 0;
  const shares   = video.shares_count   || 0;
  const follows  = video.follows_count  || 0;
  const saveRate = views > 0 ? ((saves / views) * 100).toFixed(2) : "0";
  const likeRate = views > 0 ? (((video.likes_count || 0) / views) * 100).toFixed(2) : "0";

  const viewTier  = getViewTier(views || 0);
  const compLabel = rank?.compLabel || "batch";

  const relativeViews = rank?.viewsVsAvg != null
    ? `${rank.viewsVsAvg > 0 ? "+" : ""}${rank.viewsVsAvg}% vs ${compLabel} avg (${rank.compAvgViews?.toLocaleString()} views)`
    : "comparison unavailable";

  // Build metrics section differently by view tier
  let metricsLines;
  if (viewTier === "low") {
    // Ratios are unreliable — show absolute numbers only
    metricsLines = `- Views (Day ${day || "?"}): ${views != null ? views.toLocaleString() : "unknown"} — ${relativeViews}
- ⚠️ Low view count (${views?.toLocaleString()}): ratios are unreliable at this scale. Focus on absolute engagement only.
- Absolute engagement: ${saves} saves | ${video.likes_count || 0} likes | ${comments} comments | ${shares} shares | ${follows} follows gained`;
  } else if (viewTier === "medium") {
    // Show ratios as directional, not conclusive
    const relativeSave = rank?.saveRateVsAvg != null && parseFloat(rank.compAvgSave) > 0
      ? `${rank.saveRateVsAvg > 0 ? "+" : ""}${rank.saveRateVsAvg}% vs ${compLabel} avg (${rank.compAvgSave}%)`
      : `${compLabel} avg: ${rank?.compAvgSave || batchStats.avgSaveRate}%`;
    metricsLines = `- Views (Day ${day || "?"}): ${views != null ? views.toLocaleString() : "unknown"} — ${relativeViews}
- Save rate: ${saveRate}% — ${relativeSave} (directional — moderate view count)
- Comments: ${comments} | Shares: ${shares} | Follows gained: ${follows}`;
  } else {
    // Normal view count — ratios are meaningful
    const relativeSave = rank?.saveRateVsAvg != null && parseFloat(rank.compAvgSave) > 0
      ? `${rank.saveRateVsAvg > 0 ? "+" : ""}${rank.saveRateVsAvg}% vs ${compLabel} avg (${rank.compAvgSave}%)`
      : `${compLabel} avg: ${rank?.compAvgSave || batchStats.avgSaveRate}%`;
    metricsLines = `- Views (Day ${day || "?"}): ${views != null ? views.toLocaleString() : "unknown"} — ${relativeViews}
- Save rate: ${saveRate}% — ${relativeSave}
- Comments: ${comments} | Shares: ${shares} | Follows gained: ${follows}`;
  }

  // Rules vary by view tier
  const tierRule = viewTier === "low"
    ? "- View count is too low for ratios to be reliable. Do NOT reference like rate or save rate percentages. Only mention whether saves, follows, or comments happened at all — and be honest that conclusions are limited at this view count."
    : viewTier === "medium"
    ? "- View count is moderate — treat save rate as directional, not conclusive. Mention if engagement happened, but don't overstate ratio differences."
    : "- Ratios are reliable at this view count. Save rate and follows are the strongest signals.";

  const prompt = `You are analyzing one video from a batch of ${batchStats?.count || "?"} published short-form videos for Succulent Box, a plant subscription brand. Compare this video's numbers against the batch — that is the only benchmark you have.

THIS VIDEO:
- Topic: ${cleanTopic || "unknown"}
- Platform: ${video.platform || "unknown"}
${metricsLines}
${hook ? `- Hook: "${hook.replace(/#\w+/g, "").trim().substring(0, 150)}"` : ""}
${scriptTitle ? `- Script: "${scriptTitle}"` : ""}
${whatWorked ? `- What worked (team note): ${whatWorked}` : ""}
${improve ? `- Improve (team note): ${improve}` : ""}
${crossPlatform ? `- Same content on other platforms: ${crossPlatform}` : ""}

RULES:
- Only use the data above. No platform speculation, no external benchmarks.
- If team notes exist, lead with those — they're direct observation.
- Compare this video to the batch, not to an imagined ideal.
${tierRule}
- If cross-platform data is provided, note which platform got more traction for this content and what that suggests.
- Saves signal lasting value; follows signal new audience; comments signal resonance. Reference whichever ones are notable.
- 2-3 sentences max. No headers, no bullet points. Be specific.`;

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
        max_tokens: 250,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) { console.error("Claude API error:", data.error.message); return `Analysis unavailable: ${data.error.message}`; }
    return data.content?.[0]?.text?.trim() || "No analysis returned.";
  } catch (err) {
    console.error("Claude call failed:", err.message);
    return `Analysis unavailable: ${err.message}`;
  }
}

// ── Weighted confidence scoring ───────────────────────────────────────────────
// Ratios on low-view videos are statistically unreliable.
// Confidence reflects data maturity AND whether the view base is large enough
// to trust engagement ratios.
function computeConfidence(video) {
  const views    = video.views_count    || 0;
  const day      = video.views_day      || 1;
  const saves    = video.saves_count    || 0;
  const follows  = video.follows_count  || 0;
  const comments = video.comments_count || 0;

  let score = 0;

  // Data maturity (0–2)
  if (day === 3)      score += 2;
  else if (day === 2) score += 1;

  // View volume — determines whether ratios mean anything
  if (views >= 2000)      score += 2;
  else if (views >= 500)  score += 1;
  else if (views < 200)   score -= 1; // ratios are noise this thin

  // Absolute engagement — only reward engagement where view base supports it
  if (views >= 500) {
    if (saves >= 1) score += 1;
    if (saves >= 3) score += 1; // extra: multiple saves = deliberate saves signal
    if (follows >= 2) score += 1;
    if (comments >= 3) score += 1;
  } else if (views >= 200) {
    // directional zone — only strong absolute signals count
    if (saves >= 3)   score += 1;
    if (follows >= 2) score += 1;
  }
  // < 200 views: no engagement bonus — ratios are too unreliable

  if (score >= 4) return "High";
  if (score >= 2) return "Medium";
  return "Low";
}

// ── View tier for prompt context ──────────────────────────────────────────────
function getViewTier(views) {
  if (views < 200)  return "low";
  if (views < 1000) return "medium";
  return "normal";
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanTopicText(raw) {
  let clean = raw.replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  const match = clean.match(/^[^.!?]+[.!?]?/);
  clean = match ? match[0].trim() : clean;
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

function parsePerformanceSummary(summary) {
  if (!summary) return { whatWorked: null, improve: null };
  const w = summary.match(/What worked:\s*(.+?)(?:\n|$)/i);
  const i = summary.match(/What to improve:\s*(.+?)(?:\n|$)/i);
  return {
    whatWorked: w ? w[1].trim() : null,
    improve:    i ? i[1].trim() : null,
  };
}
