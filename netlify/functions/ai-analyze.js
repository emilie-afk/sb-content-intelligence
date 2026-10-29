/**
 * Netlify Function: ai-analyze
 *
 * Analyzes signals, briefs, and scripts using Claude.
 * Called by the dashboard when reviewing content.
 *
 * POST /.netlify/functions/ai-analyze
 * Body: { type: "signal"|"brief"|"script", data: { ...fields } }
 */

const prompts = require("../lib/prompts");
const crypto = require("crypto");
const { PublicError, parseBody, preflightOrMethod, errorResponse, header, baseHeaders } = require("../lib/http");
const { requireUser, requireService, ROLES } = require("../lib/auth");
const { lazyService } = require("../lib/supabase");
const locks = require("../lib/locks");
const { fetchScriptHistory } = require("../lib/sources");
const claude = require("../lib/claude");
const { isUuid, uuid, clampDeep, oneOf } = require("../lib/validate");

const supabase = lazyService;
const headers = baseHeaders();

const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "extract-v2";

const TYPES = ["signal", "brief", "generate_brief", "revise_brief", "opportunity", "script",
               "generate_script", "revise_script", "delete_scraper_cleanup", "cluster"];

// Load the stored row for an id the browser sent, so analysis/generation always
// works on the database version of the record (client fields can't spoof it).
async function loadRow(table, id) {
  if (!isUuid(id)) return null;
  const { data: row, error } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
  if (error) throw new PublicError(503, "Could not load the record");
  if (!row) throw new PublicError(404, "Record not found");
  return row;
}

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;

    const body = parseBody(event, { maxBytes: 256 * 1024, allowEmpty: false });
    const type = oneOf(body.type, "type", TYPES);
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      throw new PublicError(400, "type and data are required");
    }

    // Internal calls (batch-cluster → cluster-signal-background) carry the internal
    // service credential and may only run clustering. Everyone else needs an approved
    // session; deleting is owner/admin only.
    let caller;
    if (header(event, "x-internal-secret") !== undefined) {
      caller = await requireService(event, ["internal"]);
      if (type !== "cluster") throw new PublicError(403, "Not allowed for service calls");
    } else {
      const adminOnly = type === "delete_scraper_cleanup";
      caller = await requireUser(event, { roles: adminOnly ? ROLES.ADMINS : ROLES.WRITERS, bucket: adminOnly ? "admin" : "ai" });
    }
    const performedBy = caller.kind === "user" ? caller.userId : null;

    // Prompt set first: background jobs use the version their batch started with.
    // (Loaded before any claim or lock so missing configuration changes nothing.)
    const set = await prompts.loadPromptSet(supabase, { versionId: caller.kind === "service" && body.prompt_version != null ? Number(body.prompt_version) : undefined });

    let data = clampDeep(body.data);
    let lockKey = null, lockHolder = null, clusterClaim = null, previousStatus = null;

    // Server truth for referenced records
    if (type === "signal" && data.id) data = { ...data, ...(await loadRow("signals", data.id)) };
    if (type === "brief" && data.id) data = { ...data, ...(await loadRow("briefs", data.id)) };
    if (type === "opportunity" && data.id) data = { ...data, ...(await loadRow("opportunities", data.id)) };
    if (type === "script" && data.id) data = { ...data, ...(await loadRow("script_outputs", data.id)) };
    if (type === "generate_script") {
      if (data.id) data = { ...data, ...(await loadRow("briefs", uuid(data.id, "brief id"))) };
      if (data.id) lockKey = `generate_script:${data.id}`;
    }
    if (type === "revise_brief") {
      const id = uuid(data.brief && data.brief.id, "brief id");
      data = { ...data, brief: await loadRow("briefs", id) };
      lockKey = `revise_brief:${id}`;
    }
    if (type === "revise_script" && data.script && data.script.id) {
      const id = uuid(data.script.id, "script id");
      data = { ...data, script: { ...data.script, ...(await loadRow("script_outputs", id)) } };
      lockKey = `revise_script:${id}`;
    }
    if (type === "generate_brief") {
      for (const k of ["cluster_id", "opportunity_id"]) if (data[k] != null && !isUuid(data[k])) throw new PublicError(400, `${k} must be a valid id`);
      const ref = data.cluster_id || data.opportunity_id || (isUuid(data.id) ? data.id : null);
      if (ref) lockKey = `generate_brief:${ref}`;
    }
    if (type === "delete_scraper_cleanup" && Array.isArray(data.ids)) {
      if (data.ids.length > 500) throw new PublicError(400, "Too many ids (max 500)");
      data.ids.forEach(id => uuid(id));
    }
    if (type === "cluster") {
      const id = uuid(data.id, "signal id");
      clusterClaim = crypto.randomUUID();
      // Atomic claim: background jobs must hold the claim batch-cluster gave them;
      // interactive calls claim the signal unless it is already being clustered.
      const expected = caller.kind === "service" ? uuid(body.claim, "claim") : null;
      const { data: prev, error: claimErr } = await supabase.rpc("ci_claim_signal", { p_id: id, p_claim: clusterClaim, p_expected: expected });
      if (claimErr) throw new PublicError(503, "Could not claim the signal");
      if (!prev) throw new PublicError(409, "This signal is already being clustered", { code: "in_progress" });
      previousStatus = prev;
      data = { ...(await loadRow("signals", id)) };
    }

    if (lockKey) lockHolder = await locks.acquire(lockKey, 300, "This is already being generated. Wait for it to finish.");

    try {
      return await prompts.runWithPrompts(set, () => analyze(type, data, { performedBy, clusterClaim, previousStatus, isService: caller.kind === "service" }));
    } finally {
      if (lockKey) await locks.release(lockKey, lockHolder);
    }
  } catch (err) {
    return errorResponse(err, "ai-analyze");
  }
};

async function analyze(type, data, { performedBy, clusterClaim, previousStatus, isService }) {
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
          priority:               data.is_manual_submission === true ? "High" : (result.priority || data.priority),
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

      // FEEDBACK LOOP: persist review gaps as lessons so brief generation
      // stops repeating the same mistakes. Mirrors the script_gen_lessons
      // mechanism. Stored in settings, deduped by gap text, capped at 20.
      try {
        const gaps = (result.gaps || []).filter(Boolean);
        if (gaps.length) {
          const { data: lessonSetting } = await supabase
            .from("settings").select("value").eq("key", "brief_gen_lessons").maybeSingle();
          const lessons = lessonSetting?.value?.lessons || [];
          const byIssue = new Map(lessons.map(l => [l.issue.toLowerCase().trim(), l]));
          for (const g of gaps) {
            const key = g.toLowerCase().trim();
            const existing = byIssue.get(key);
            if (existing) {
              existing.count = (existing.count || 1) + 1;
              existing.last_seen = new Date().toISOString();
            } else {
              byIssue.set(key, { issue: g, count: 1, last_seen: new Date().toISOString() });
            }
          }
          const merged = [...byIssue.values()].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 20);
          await supabase.from("settings").upsert(
            { key: "brief_gen_lessons", value: { lessons: merged } },
            { onConflict: "key" }
          );
        }
      } catch (e) { console.warn("Could not save brief lessons:", e.message); }

    } else if (type === "generate_brief") {
      // ── GENERATE A FIRST-DRAFT BRIEF FROM AN APPROVED CANDIDATE ─────────────
      // data = a content_review_candidates row (optionally with joined `cluster`),
      // or an opportunities row. Both dead-end today at a status flag with no
      // brief ever created — this fills that gap.
      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");

      const lessons = await fetchBriefLessons(supabase);
      const learningMemory = await fetchLearningMemory(supabase, data.plant_or_product || data.topic || data.title);
      prompt = buildGenerateBriefPrompt(data, rules || [], lessons, data.human_notes || null, learningMemory);
      const gen = await callClaude(prompt, 1024);

      // cluster_id: candidates have data.cluster_id; direct cluster calls pass data.cluster_id = data.id
      const clusterIdForBrief = data.cluster_id || null;

      const row = {
        opportunity_id:   data.opportunity_id || null, // only set when sourced from an opportunity
        cluster_id:       clusterIdForBrief,
        title:            gen.title || data.title || data.topic || "Untitled brief",
        featured_product: gen.featured_product || data.plant_or_product || null,
        audience_problem: gen.audience_problem || null,
        opening_hook:     gen.opening_hook || null,
        visual_hook:      gen.visual_hook || null,
        video_format:     gen.video_format || "Talking head",
        video_flow:       gen.video_flow || null,
        caption:          gen.caption || null,
        cta:              gen.cta || null,
        status:           "Draft",
      };

      const { data: inserted, error: insErr } = await supabase
        .from("briefs")
        .insert(row)
        .select("id")
        .single();
      if (insErr) throw new Error("Brief insert failed: " + insErr.message);

      // Log AI brief generation
      await supabase.from("activity_log").insert({
        entity_type: "brief",
        entity_id:   inserted.id,
        entity_title: row.title,
        action:      "AI generated brief",
        old_value:   null,
        new_value:   row.featured_product || null,
        performed_by: null,
      });

      result = { ...row, id: inserted.id };

    } else if (type === "revise_brief") {
      // ── REWRITE A BRIEF IN PLACE FROM AI REVIEW FEEDBACK ────────────────────
      // data = { brief: <original briefs row>, feedback: <brief review analysis> }
      const orig     = data.brief    || {};
      const feedback = data.feedback || {};
      if (!orig.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "original brief id required for revision" }) };
      }

      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");

      const lessons = await fetchBriefLessons(supabase);
      prompt = buildBriefRevisionPrompt(orig, feedback, rules || [], lessons, data.human_notes || null);
      const gen = await callClaude(prompt, 1024);

      const updates = {
        title:            gen.title || orig.title,
        featured_product: gen.featured_product || orig.featured_product || null,
        audience_problem: gen.audience_problem || null,
        opening_hook:     gen.opening_hook || null,
        visual_hook:      gen.visual_hook || null,
        video_format:     gen.video_format || orig.video_format || null,
        video_flow:       gen.video_flow || null,
        caption:          gen.caption || null,
        cta:              gen.cta || null,
        updated_at:       new Date().toISOString(),
      };

      const { error: updErr } = await supabase
        .from("briefs")
        .update(updates)
        .eq("id", orig.id);
      if (updErr) throw new Error("Brief revision update failed: " + updErr.message);

      // Log AI brief revision
      await supabase.from("activity_log").insert({
        entity_type: "brief",
        entity_id:   orig.id,
        entity_title: updates.title || orig.title,
        action:      "AI revised brief",
        old_value:   null,
        new_value:   "Rewritten from reviewer feedback",
        performed_by: null,
      });

      result = { ...orig, ...updates };

    } else if (type === "opportunity") {
      // Fetch content history from the 2026 Google Sheet (all monthly tabs)
      // Owned-channel history from the script sheet (server-side source; [] if unavailable)
      const sheetEntries = await fetchScriptHistory(supabase);

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
      result = await callClaude(prompt, 2048);

      // FEEDBACK LOOP: persist Required violations as lessons so the script
      // generator stops repeating the same mistakes. Stored in settings
      // (no migration needed), deduped by rule name, capped at 20.
      try {
        const requiredViolations = (result.brand_violations || [])
          .filter(v => String(v.severity).toLowerCase() === "required");
        if (requiredViolations.length) {
          const { data: lessonSetting } = await supabase
            .from("settings").select("value").eq("key", "script_gen_lessons").maybeSingle();
          const lessons = lessonSetting?.value?.lessons || [];
          const byRule = new Map(lessons.map(l => [l.rule, l]));
          for (const v of requiredViolations) {
            const existing = byRule.get(v.rule);
            if (existing) {
              existing.count = (existing.count || 1) + 1;
              existing.fix = v.fix || existing.fix;
              existing.last_seen = new Date().toISOString();
            } else {
              byRule.set(v.rule, { rule: v.rule, fix: v.fix || v.issue, count: 1, last_seen: new Date().toISOString() });
            }
          }
          // Keep the 20 most frequent lessons
          const merged = [...byRule.values()].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 20);
          await supabase.from("settings").upsert(
            { key: "script_gen_lessons", value: { lessons: merged } },
            { onConflict: "key" }
          );
        }
      } catch (e) { console.warn("Could not save script lessons:", e.message); }

    } else if (type === "generate_script") {
      // ── GENERATE A PRODUCTION-READY SCRIPT FROM A BRIEF ────────────────────
      // data = the brief row (+ optional target_duration_seconds, default 20).
      // Duration is auto-computed from the generated voiceover word count.
      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");

      const target = Math.min(60, Math.max(5, Number(data.target_duration_seconds) || 20));
      const lessons = await fetchScriptLessons(supabase);
      const learningMemory = await fetchLearningMemory(supabase, data.featured_product || data.title);

      // Fetch hooks used in the last 30 days so the prompt can avoid repeating them
      const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { data: recentScripts } = await supabase
        .from("script_outputs")
        .select("opening_hook, script_title, created_at")
        .gte("created_at", thirtyDaysAgo.toISOString())
        .order("created_at", { ascending: false })
        .limit(50);
      const recentHooks = (recentScripts || []).filter(s => s.opening_hook).map(s => s.opening_hook);

      // Topic repetition: find scripts on a similar subject in the last 60 days
      // Uses a synonym map so "root rot", "mushy roots", "brown base" all count as the same cluster.
      const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const currentTopic = (data.title || data.featured_product || "").toLowerCase();
      const topicSearchTerms = expandTopicTerms(currentTopic);
      let recentSameTopicScripts = [];
      if (topicSearchTerms.length) {
        const orClauses = topicSearchTerms.map(k => `script_title.ilike.%${k}%`).join(",");
        const { data: topicMatches } = await supabase
          .from("script_outputs")
          .select("script_title, created_at, opening_hook")
          .or(orClauses)
          .gte("created_at", sixtyDaysAgo.toISOString())
          .order("created_at", { ascending: false })
          .limit(10);
        recentSameTopicScripts = (topicMatches || []).filter(s =>
          s.script_title?.toLowerCase() !== (data.title || "").toLowerCase()
        );
      }

      prompt = buildScriptGenPrompt(data, rules || [], target, lessons, learningMemory, recentHooks, recentSameTopicScripts);
      const gen = await callClaude(prompt, 2048);

      // Ensure the voiceover starts with the hook (safety net if AI forgot)
      if (gen.opening_hook && gen.full_voiceover_script) {
        const vo = gen.full_voiceover_script.trimStart();
        if (!vo.startsWith(gen.opening_hook)) {
          gen.full_voiceover_script = gen.opening_hook + " " + vo;
        }
      }

      // Auto duration: ~150 words/min ≈ 2.5 words/sec of voiceover
      const words = (gen.full_voiceover_script || "").trim().split(/\s+/).filter(Boolean).length;
      const estSecs = words ? Math.max(5, Math.round(words / 2.5)) : target;

      const row = {
        brief_id:                   data.id || null,
        platform:                   gen.platform || data.platform || "TikTok",
        script_title:               gen.script_title || data.title || "Untitled script",
        script_version:             "v1",
        script_type:                ALLOWED_SCRIPT_TYPES.includes(gen.script_type) ? gen.script_type : "TikTok / Reel short script",
        opening_hook:               gen.opening_hook || null,
        thumbnail_title:            gen.thumbnail_title || null,
        full_voiceover_script:      gen.full_voiceover_script || null,
        on_screen_text:             gen.on_screen_text || null,
        shot_list:                  gen.shot_list || null,
        broll_notes:                gen.broll_notes || null,
        product_mention:            gen.product_mention || data.featured_product || null,
        cta:                        gen.cta || data.cta || null,
        caption:                    gen.caption || null,
        hashtags:                   toHashtagArray(gen.hashtags),
        estimated_duration_seconds: estSecs,
        review_status:              "Draft",
      };

      const { data: inserted, error: insErr } = await supabase
        .from("script_outputs")
        .insert(row)
        .select("id")
        .single();
      if (insErr) throw new Error("Script insert failed: " + insErr.message);

      // Log AI generation to activity_log (performed_by null = AI action)
      // Fetch brief title so the log shows which brief triggered this
      let briefTitle = null;
      if (data.id) {
        const { data: b } = await supabase.from("briefs").select("title").eq("id", data.id).maybeSingle();
        briefTitle = b?.title || null;
      }
      await supabase.from("activity_log").insert({
        entity_type:  "script",
        entity_id:    inserted.id,
        entity_title: row.script_title,
        action:       "AI generated script",
        old_value:    briefTitle ? `From brief: ${briefTitle}` : null,
        new_value:    `${row.estimated_duration_seconds}s · ${row.platform} · v1`,
        performed_by: null,
      });

      result = { ...row, id: inserted.id, voiceover_words: words, target_duration_seconds: target };

    } else if (type === "revise_script") {
      // ── GENERATE A NEW SCRIPT VERSION FROM BRAND-CHECK FEEDBACK ────────────
      // data = { script: <original script_outputs row>, feedback: <brand check analysis> }
      const orig     = data.script   || {};
      const feedback = data.feedback || {};
      if (!orig.script_title && !orig.full_voiceover_script) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "original script required for revision" }) };
      }

      const { data: rules } = await supabase
        .from("brand_content_rules")
        .select("category, rule_name, rule_text, severity")
        .eq("active", true)
        .order("severity");

      // Prefer explicit target from request (user wants a different length); fall back to original
      const target = Math.min(120, Math.max(5, Number(data.target_duration_seconds || orig.estimated_duration_seconds) || 20));
      const lessons = await fetchScriptLessons(supabase);

      // Fetch hooks used in the last 30 days to avoid repeating patterns
      const thirtyDaysAgo2 = new Date(); thirtyDaysAgo2.setDate(thirtyDaysAgo2.getDate() - 30);
      const { data: recentScripts2 } = await supabase
        .from("script_outputs")
        .select("opening_hook")
        .gte("created_at", thirtyDaysAgo2.toISOString())
        .not("opening_hook", "is", null)
        .order("created_at", { ascending: false })
        .limit(30);
      const recentHooks2 = (recentScripts2 || []).map(s => s.opening_hook).filter(Boolean);

      prompt = buildScriptRevisionPrompt(orig, feedback, rules || [], target, lessons, data.human_notes || null, data.hook_pattern || null, data.force_fresh || false, recentHooks2);
      const gen = await callClaude(prompt, 2048);

      // Safety net: ensure hook is literally the first line of the voiceover
      if (gen.opening_hook && gen.full_voiceover_script) {
        const vo = gen.full_voiceover_script.trimStart();
        if (!vo.startsWith(gen.opening_hook)) {
          gen.full_voiceover_script = gen.opening_hook + " " + vo;
        }
      }

      const words   = (gen.full_voiceover_script || "").trim().split(/\s+/).filter(Boolean).length;
      const estSecs = words ? Math.max(5, Math.round(words / 2.5)) : target;
      // v1 → v2 → v3 …
      const nextVersion = "v" + ((parseInt(String(orig.script_version || "v1").replace(/\D/g, ""), 10) || 1) + 1);

      const row = {
        brief_id:                   orig.brief_id || null,
        platform:                   gen.platform || orig.platform || "TikTok",
        script_title:               gen.script_title || orig.script_title || "Untitled script",
        script_version:             nextVersion,
        script_type:                ALLOWED_SCRIPT_TYPES.includes(gen.script_type) ? gen.script_type : (ALLOWED_SCRIPT_TYPES.includes(orig.script_type) ? orig.script_type : "TikTok / Reel short script"),
        opening_hook:               gen.opening_hook || null,
        thumbnail_title:            gen.thumbnail_title || null,
        full_voiceover_script:      gen.full_voiceover_script || null,
        on_screen_text:             gen.on_screen_text || null,
        shot_list:                  gen.shot_list || null,
        broll_notes:                gen.broll_notes || null,
        product_mention:            gen.product_mention || orig.product_mention || null,
        cta:                        gen.cta || null,
        caption:                    gen.caption || null,
        hashtags:                   toHashtagArray(gen.hashtags) || toHashtagArray(orig.hashtags),
        estimated_duration_seconds: estSecs,
        review_status:              "Draft",
      };

      const { data: inserted, error: insErr } = await supabase
        .from("script_outputs")
        .insert(row)
        .select("id")
        .single();
      if (insErr) throw new Error("Revised script insert failed: " + insErr.message);

      // Log AI revision to activity_log
      await supabase.from("activity_log").insert({
        entity_type: "script",
        entity_id:   inserted.id,
        entity_title: row.script_title,
        action:      `AI revised script (${nextVersion})`,
        old_value:   orig.script_version || "v1",
        new_value:   `${nextVersion} · ${row.estimated_duration_seconds}s`,
        performed_by: null,
      });

      result = { ...row, id: inserted.id, voiceover_words: words };

    } else if (type === "delete_scraper_cleanup") {
      // ── BULK DELETE SCRAPER NEEDS-CLEANUP SIGNALS ─────────────────────────
      // Deletes all signals where status='Needs cleanup' AND is_manual_submission=false
      // (or a specific list of IDs if data.ids is provided)
      let delQuery = supabase
        .from("signals")
        .delete({ count: "exact" })
        .eq("status", "Needs cleanup")
        .eq("is_manual_submission", false);

      if (Array.isArray(data?.ids) && data.ids.length) {
        delQuery = supabase
          .from("signals")
          .delete({ count: "exact" })
          .in("id", data.ids);
      }

      const { count: deleted, error: delErr } = await delQuery;
      if (delErr) throw new Error("Delete failed: " + delErr.message);
      result = { deleted: deleted ?? 0 };

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

      // Step 1: Extract one or more distinct ideas + relevance check
      const extractPrompt = buildExtractionPrompt(data);
      const extracted = await callClaude(extractPrompt);

      // If AI says signal is not relevant to plants/succulents, mark as Noise and stop.
      // EXCEPT manual submissions — a human deliberately submitted these, so never
      // auto-noise them; let them cluster normally for review.
      if (extracted.relevant === false && data.is_manual_submission !== true) {
        await supabase.from("signals").update({ status: "Noise" }).eq("id", signalId);
        return { statusCode: 200, headers, body: JSON.stringify({
          success: true,
          analysis: { cluster_id: null, match_type: "noise", signal_count: 0,
                       qualifies: false, reason: extracted.noise_reason || "Not relevant to succulents/plants" }
        })};
      }

      // Write source attribution + dates back to the signals table
      const attr  = extracted.attribution || {};
      const dates = extracted.dates || {};
      const firstIdea = (extracted.ideas || [])[0] || {};
      await supabase.from("signals").update({
        source_account_handle:  attr.source_account_handle  || null,
        source_account_name:    attr.source_account_name    || null,
        collaborator_accounts:  attr.collaborator_accounts  || null,
        ownership_type:         attr.ownership_type         || "Unknown",
        ownership_confidence:   attr.ownership_confidence   || "Low",
        published_at:           dates.published_at          || null,
        published_at_estimated: dates.published_at_estimated ?? false,
        event_dates_claimed:    dates.event_dates_claimed   || null,
        event_date_labels:      dates.event_date_labels     || null,
        signal_purpose:         firstIdea.signal_purpose    || null,
        section_route:          firstIdea.section_route     || null,
        catalog_match_status:   firstIdea.catalog_match_status || null,
        matched_catalog_name:   firstIdea.matched_catalog_name || null,
        source_marketing_wording: firstIdea.source_marketing_wording || null,
      }).eq("id", signalId);

      // Support both old single-object format and new multi-idea array format
      const ideas = Array.isArray(extracted.ideas) && extracted.ideas.length > 0
        ? extracted.ideas
        : [extracted]; // fallback: treat the whole object as one idea

      // Step 2: Fetch existing clusters once — we'll append newly created ones as we go
      const { data: fetchedClusters } = await supabase
        .from("discovery_clusters")
        .select("id, title, primary_question, plant_or_product, problems_mentioned, tips_mentioned, audience_wording, signal_count, status")
        .not("status", "in", '("Closed","Blocked irrelevant")')
        .order("signal_count", { ascending: false })
        .limit(50);
      const knownClusters = [...(fetchedClusters || [])];

      // Fetch owned-channel history once (shared across all ideas for this signal)
      // Owned-channel history from the script sheet (server-side source; [] if unavailable)
      const sheetEntries = await fetchScriptHistory(supabase);

      const { data: dbPublished } = await supabase
        .from("published_videos")
        .select("video_title, topic, plant_or_product, hook_used, angle_used, platform, publish_date, performance_summary, audience_followup_questions")
        .order("publish_date", { ascending: false }).limit(30);

      // Blocked competitor accounts (reviewer marked "Noise" on the Today board).
      // Stored in settings so no schema migration is needed. Names/handles lowercase.
      let blockedAccounts = [];
      try {
        const { data: blockSetting } = await supabase
          .from("settings").select("value").eq("key", "competitor_blocked_accounts").single();
        blockedAccounts = (blockSetting?.value?.accounts || []).map(a => String(a).toLowerCase());
      } catch (e) { /* no blocklist yet — fine */ }
      const isBlockedAccount = (attr) => {
        const name   = (attr?.source_account_name   || "").toLowerCase();
        const handle = (attr?.source_account_handle || "").toLowerCase().replace(/^@/, "");
        return blockedAccounts.some(b => {
          const bh = b.replace(/^@/, "");
          return (name && name === b) || (handle && handle === bh);
        });
      };

      // Step 3: Process each extracted idea independently
      const clusterResults = [];

      for (const idea of ideas) {
        const route = idea.section_route || "";

        // ── COMPETITOR ACTIVITY routing ────────────────────────────────────────
        if (route === "Competitor Activity" || idea.processing_path === "Competitor routed") {
          // Reviewer-blocked account → drop silently, never alert again
          if (isBlockedAccount(attr)) {
            clusterResults.push({
              processing_path: "Competitor blocked",
              cluster_id: null, cluster_title: null,
              match_type: "competitor_activity",
              qualifies: false,
              discovery_reason: `Account "${attr?.source_account_name || attr?.source_account_handle}" is on the competitor blocklist`,
            });
            continue;
          }
          const caPayload = {
            signal_id:              signalId,
            source_url:             data.source_url || null,
            source_platform:        data.platform   || null,
            source_account_name:    attr.source_account_name   || null,
            source_account_handle:  attr.source_account_handle || null,
            collaborator_accounts:  attr.collaborator_accounts || null,
            ownership_type:         attr.ownership_type        || "Unknown",
            observed_at:            dates.observed_at          || new Date().toISOString(),
            published_at:           dates.published_at         || null,
            published_at_estimated: dates.published_at_estimated ?? false,
            event_dates_claimed:    dates.event_dates_claimed  || null,
            event_date_labels:      dates.event_date_labels    || null,
            activity_type:          idea.signal_purpose        || null,
            signal_purpose:         idea.signal_purpose        || null,
            ai_summary:             idea.summary               || null,
            plant_name:             idea.plant                 || null,
            catalog_match_status:   idea.catalog_match_status  || "Needs catalog review",
            matched_catalog_name:   idea.matched_catalog_name  || null,
            match_confidence:       idea.match_confidence      || null,
            source_marketing_wording: idea.source_marketing_wording || null,
            status:                 "New",
          };
          await supabase.from("competitor_activity").insert(caPayload);

          clusterResults.push({
            processing_path: "Competitor routed",
            cluster_id:      null,
            cluster_title:   null,
            match_type:      "competitor_activity",
            qualifies:       false,
            discovery_reason: "Routed to Competitor Activity",
          });

          // If the plant is also not in catalog, fall through to Market Watch too
          if (idea.catalog_match_status !== "Catalog match" && idea.catalog_match_status !== "Catalog family match" && idea.plant) {
            await upsertMarketWatchPlant(supabase, idea, signalId, data, attr);
          }
          continue;
        }

        // ── MARKET WATCH routing ───────────────────────────────────────────────
        if (route === "Market Watch" || idea.processing_path === "Market Watch") {
          await upsertMarketWatchPlant(supabase, idea, signalId, data, attr);
          clusterResults.push({
            processing_path: "Market Watch",
            cluster_id:      null,
            cluster_title:   null,
            match_type:      "market_watch",
            qualifies:       false,
            discovery_reason: "Routed to Market Watch",
          });
          continue;
        }

        // ── NEEDS CATALOG REVIEW ───────────────────────────────────────────────
        if (route === "Needs Catalog Review") {
          // Scraper signals: delete (low quality automated). Manual: flag for review.
          if (data.is_manual_submission) {
            await supabase.from("signals").update({ status: "Needs cleanup" }).eq("id", signalId);
          } else {
            await supabase.from("signals").delete().eq("id", signalId);
          }
          clusterResults.push({
            processing_path: "Needs review",
            cluster_id:      null,
            cluster_title:   null,
            match_type:      "needs_catalog_review",
            qualifies:       false,
            discovery_reason: "Catalog match uncertain — needs human review",
          });
          continue;
        }

        // Skip ideas that are Mention only or Noise — no discovery cluster needed
        if (idea.processing_path === "Mention only" || idea.processing_path === "Noise") {
          clusterResults.push({
            processing_path:  idea.processing_path,
            cluster_id:       null,
            cluster_title:    null,
            match_type:       "skipped",
            qualifies:        false,
            discovery_reason: idea.discovery_reason || null,
          });
          continue;
        }

        // ── CATALOG DISCOVERY (default) ────────────────────────────────────────
        // Step 3a: Match idea against known clusters
        const matchPrompt = buildClusterMatchPrompt(idea, knownClusters);
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
          const mergedWording      = [...new Set([...(cluster.audience_wording || []), ...(idea.audience_wording || [])])].slice(0, 20);
          const mergedProblems     = [...new Set([...(cluster.problems_mentioned || []), ...(idea.problems || [])])].slice(0, 10);
          const mergedTips         = [...new Set([...(cluster.tips_mentioned || []), ...(idea.tips || [])])].slice(0, 10);
          const mergedEvidenceTypes = [...new Set([...(cluster.evidence_types || []), idea.evidence_type].filter(Boolean))];

          const now = new Date().toISOString();
          const newSignalCount = (cluster.signal_count || 0) + 1;
          const newSinceReview = (cluster.new_signals_since_review || 0) + 1;

          // Determine signal source category for weighted scoring
          const isAudienceSignal = attr.ownership_type !== "Owned content";
          const isManualSignal   = data.is_manual_submission === true;
          const newAudienceCount = (cluster.audience_signal_count ?? cluster.signal_count ?? 0) + (isAudienceSignal ? 1 : 0);
          const newManualCount   = (cluster.manual_signal_count  ?? 0) + (isManualSignal   ? 1 : 0);
          const signalRepetitionType = getRepetitionSourceType(attr.ownership_type);
          // Upgrade repetition_source_type if the new signal is stronger evidence
          const currentRepType = cluster.repetition_source_type || "none";
          const newRepType = mergeRepetitionType(currentRepType, signalRepetitionType);

          // Build a short update summary describing what changed
          const updateParts = [`+1 signal (total: ${newSignalCount})`];
          if (idea.evidence_type === "Question") updateParts.push("new question");
          if ((idea.audience_wording || []).some(w => !(cluster.audience_wording || []).includes(w))) updateParts.push("new audience wording");
          if ((idea.problems || []).some(p => !(cluster.problems_mentioned || []).includes(p))) updateParts.push("new problem noted");
          if ((idea.tips || []).some(t => !(cluster.tips_mentioned || []).includes(t))) updateParts.push("new tip noted");
          const aiUpdateSummary = updateParts.join(", ");

          await supabase.from("discovery_clusters").update({
            signal_count:            newSignalCount,
            audience_signal_count:   newAudienceCount,
            manual_signal_count:     newManualCount,
            repetition_source_type:  newRepType,
            question_count:          idea.evidence_type === "Question" ? (cluster.question_count || 0) + 1 : cluster.question_count,
            last_seen_at:            now,
            audience_wording:        mergedWording,
            problems_mentioned:      mergedProblems,
            tips_mentioned:          mergedTips,
            evidence_types:          mergedEvidenceTypes,
            recent_mention_count:    (cluster.recent_mention_count || 0) + 1,
            last_ai_updated_at:      now,
            new_signals_since_review: newSinceReview,
            ai_update_summary:       aiUpdateSummary,
            prompt_version:          PROMPT_VERSION,
          }).eq("id", clusterId);

          // Audit log — record the signal addition
          await supabase.from("cluster_audit_log").insert({
            cluster_id:      clusterId,
            field_changed:   "signal_count",
            previous_value:  String(cluster.signal_count || 0),
            new_value:       String(newSignalCount),
            reason:          aiUpdateSummary,
            trigger:         "new_signal",
            ai_model:        CLAUDE_MODEL,
            prompt_version:  PROMPT_VERSION,
            is_automatic:    true,
            performed_by:    performedBy,
            source_function: "ai-analyze",
          });

        } else {
          // Create new cluster for this idea
          const clusterNow = new Date().toISOString();
          const { data: newCluster, error: clusterErr } = await supabase
            .from("discovery_clusters")
            .insert({
              title:                  idea.normalized_cluster_title || idea.cluster_title || idea.question || data.topic || "Untitled cluster",
              summary:                idea.core_issue || idea.summary,
              plant_or_product:       idea.plant || data.plant_or_product,
              primary_question:       idea.question,
              problems_mentioned:     idea.problems || [],
              tips_mentioned:         idea.tips || [],
              audience_wording:       idea.audience_wording || [],
              evidence_types:         idea.evidence_type ? [idea.evidence_type] : [],
              signal_count:           1,
              audience_signal_count:  attr.ownership_type !== "Owned content" ? 1 : 0,
              manual_signal_count:    data.is_manual_submission === true ? 1 : 0,
              repetition_source_type: getRepetitionSourceType(attr.ownership_type),
              question_count:         idea.evidence_type === "Question" ? 1 : 0,
              distinct_source_count:  1,
              platforms:              data.platform ? [data.platform] : [],
              first_seen_at:          clusterNow,
              last_seen_at:           clusterNow,
              recent_mention_count:   1,
              novelty_status:         idea.novelty_status || "Unclear",
              revenue_priority_match: idea.revenue_priority_match || "Needs check",
              ai_confidence:          idea.confidence || "Medium",
              ai_reason:              [
                "Auto-created from signal " + signalId,
                idea.relevant_conditions?.length ? "Conditions: " + idea.relevant_conditions.join(", ") : null,
                idea.location_materiality && idea.location_materiality !== "Not provided" ? "Location: " + idea.location_materiality : null,
              ].filter(Boolean).join(" | "),
              // v12 maintenance fields
              maintenance_status:      "Collecting",
              last_ai_updated_at:      clusterNow,
              new_signals_since_review: 1,
              ai_update_summary:       "Cluster created from signal " + signalId,
              prompt_version:          PROMPT_VERSION,
            })
            .select().single();
          if (clusterErr) throw new Error("Could not create cluster: " + clusterErr.message);
          clusterId = newCluster.id;
          cluster   = newCluster;

          // Audit log — record cluster creation
          await supabase.from("cluster_audit_log").insert({
            cluster_id:      clusterId,
            field_changed:   "status",
            previous_value:  null,
            new_value:       "Collecting",
            reason:          "New cluster auto-created from signal " + signalId,
            trigger:         "new_signal",
            ai_model:        CLAUDE_MODEL,
            prompt_version:  PROMPT_VERSION,
            is_automatic:    true,
            performed_by:    performedBy,
            source_function: "ai-analyze",
          });

          // Add newly created cluster to the known list so later ideas can match against it
          knownClusters.push({
            id: newCluster.id, title: newCluster.title,
            primary_question: newCluster.primary_question,
            plant_or_product: newCluster.plant_or_product,
            problems_mentioned: newCluster.problems_mentioned,
            tips_mentioned: newCluster.tips_mentioned,
            audience_wording: newCluster.audience_wording,
            signal_count: 1, status: newCluster.status,
          });
        }

        // Step 3b: Link this signal to this cluster (one idea = one link)
        await supabase.from("signal_cluster_links").upsert({
          signal_id:    signalId,
          cluster_id:   clusterId,
          match_reason: matchResult.match_reason || "Auto-matched",
          is_duplicate: matchResult.is_duplicate || false,
        }, { onConflict: "signal_id,cluster_id", ignoreDuplicates: true });

        // Step 3c: Refresh cluster and check qualification
        const { data: refreshed } = await supabase
          .from("discovery_clusters").select("*").eq("id", clusterId).single();
        cluster = refreshed;

        const qualifies = checkQualification(cluster);

        if (qualifies && cluster.status === "Collecting") {
          await supabase.from("discovery_clusters")
            .update({ status: "Pattern detected", maintenance_status: "Pattern detected" }).eq("id", clusterId);
          await supabase.from("cluster_audit_log").insert({
            cluster_id:      clusterId,
            field_changed:   "status",
            previous_value:  "Collecting",
            new_value:       "Pattern detected",
            reason:          qualifies.reason,
            trigger:         "new_signal",
            ai_model:        CLAUDE_MODEL,
            prompt_version:  PROMPT_VERSION,
            is_automatic:    true,
            performed_by:    performedBy,
            source_function: "ai-analyze",
          });
        }

        // Step 3d: Create Content Review candidate if qualifies and none exists
        if (qualifies) {
          const { data: existingCandidate } = await supabase
            .from("content_review_candidates")
            .select("id, status")
            .eq("cluster_id", clusterId)
            .not("status", "in", '("Dismissed","Already covered")')
            .maybeSingle();

          if (!existingCandidate) {
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
              // Force "Needs research" when qualification was triggered by a new claim
              status: (qualifies.reason && qualifies.reason.includes("needs verification"))
                ? "Needs research"
                : (candidateResult.candidate_status || "Ready for review"),
            });

            await supabase.from("discovery_clusters")
              .update({ status: "Content review ready", maintenance_status: "Pattern detected" }).eq("id", clusterId);
            await supabase.from("cluster_audit_log").insert({
              cluster_id:      clusterId,
              field_changed:   "status",
              previous_value:  cluster.status,
              new_value:       "Content review ready",
              reason:          qualifies.reason,
              trigger:         "new_signal",
              ai_model:        CLAUDE_MODEL,
              prompt_version:  PROMPT_VERSION,
              is_automatic:    true,
              performed_by:    performedBy,
              source_function: "ai-analyze",
            });
          } else {
            // Update existing candidate counts
            await supabase.from("content_review_candidates").update({
              signal_count:   cluster.signal_count,
              question_count: cluster.question_count,
              last_seen_at:   cluster.last_seen_at,
            }).eq("id", existingCandidate.id);
          }
        }

        clusterResults.push({
          processing_path:      idea.processing_path || "Discovery eligible",
          cluster_id:           clusterId,
          cluster_title:        cluster.title,
          match_type:           matchResult.match_type,
          signal_count:         cluster.signal_count,
          qualifies:            !!qualifies,
          qualification_reason: qualifies?.reason || null,
          relevant_conditions:  idea.relevant_conditions || [],
        });
      } // end ideas loop

      // Mark signal status:
      // - Any cluster link → Clustered
      // - All ideas Mention only → "Mention only" (processed, tracked, not clustered)
      // - All ideas competitor/market routed → "Watch" (filed in other tables)
      // - All ideas Noise → already marked Noise above (shouldn't reach here)
      const hasClusterLink  = clusterResults.some(r => r.cluster_id !== null);
      const allMentionOnly  = clusterResults.every(r => r.processing_path === "Mention only");
      const allRouted       = clusterResults.every(r =>
        ["Competitor routed", "Market Watch", "needs_catalog_review"].includes(r.match_type));
      if (hasClusterLink) {
        await supabase.from("signals").update({ status: "Clustered" }).eq("id", signalId);
      } else if (allMentionOnly) {
        await supabase.from("signals").update({ status: "Mention only" }).eq("id", signalId);
      } else if (allRouted) {
        await supabase.from("signals").update({ status: "Watch" }).eq("id", signalId);
      }
      // Interactive (re-)clustering claimed the signal as "Clustering": if no outcome
      // above set a new status, put back the status it had before the claim.
      if (!isService && previousStatus && previousStatus !== "Clustering") {
        await supabase.from("signals").update({ status: previousStatus })
          .eq("id", signalId).eq("status", "Clustering").eq("clustering_claim", clusterClaim);
      }

      // Return summary of all clusters touched
      const primaryResult = clusterResults[0] || {};
      result = {
        ...primaryResult,
        ideas_extracted: ideas.length,
        clusters:        clusterResults,
        extracted,
      };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "type must be signal, brief, opportunity, script, or cluster" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, analysis: result }) };

  } catch (err) {
    console.error("ai-analyze failed:", type, err && err.isPublic ? err.message : "internal error");
    // If clustering failed: queued scraper signals → delete; queued manual → Needs cleanup.
    // A re-cluster of an already-routed signal is put back to its previous status instead.
    if (type === "cluster" && data?.id && !isService && previousStatus && !["New", "Clustering"].includes(previousStatus)) {
      try {
        await supabase.from("signals").update({ status: previousStatus })
          .eq("id", data.id).eq("status", "Clustering").eq("clustering_claim", clusterClaim);
      } catch (_) {}
    } else if (type === "cluster" && data?.id) {
      try {
        if (data.is_manual_submission) {
          await supabase.from("signals")
            .update({ status: "Needs cleanup" })
            .eq("id", data.id)
            .in("status", ["New", "Clustering"]);
        } else {
          await supabase.from("signals")
            .delete()
            .eq("id", data.id)
            .in("status", ["New", "Clustering"]);
        }
      } catch (_) {}
    }
    throw err; // → safe error response in the handler
  }
}


// ── MARKET WATCH UPSERT HELPER ────────────────────────────────────────────────
// Creates or updates a market_watch_plants row and adds a signal link.
async function upsertMarketWatchPlant(supabase, idea, signalId, signal, attr) {
  const plantName = idea.plant;
  if (!plantName) return;

  // Try to find existing plant row
  const { data: existing } = await supabase
    .from("market_watch_plants")
    .select("id, signal_count, question_count, purchase_intent_count, distinct_source_count, platforms, competitors_featuring, audience_wording")
    .eq("plant_name", plantName)
    .maybeSingle();

  if (existing) {
    const mergedPlatforms    = [...new Set([...(existing.platforms || []), signal.platform].filter(Boolean))];
    const mergedWording      = [...new Set([...(existing.audience_wording || []), ...(idea.audience_wording || [])])].slice(0, 20);
    const mergedCompetitors  = [...new Set([...(existing.competitors_featuring || []),
      ...(attr.source_account_handle ? [attr.source_account_handle] : [])].filter(Boolean))];

    await supabase.from("market_watch_plants").update({
      signal_count:          (existing.signal_count || 0) + 1,
      question_count:        idea.evidence_type === "Question" ? (existing.question_count || 0) + 1 : existing.question_count,
      purchase_intent_count: idea.evidence_type === "Purchase intent" ? (existing.purchase_intent_count || 0) + 1 : existing.purchase_intent_count,
      distinct_source_count: (existing.distinct_source_count || 0) + 1,
      platforms:             mergedPlatforms,
      competitors_featuring: mergedCompetitors,
      audience_wording:      mergedWording,
      last_seen_at:          new Date().toISOString(),
      recent_mention_count:  (existing.recent_mention_count || 0) + 1,
    }).eq("id", existing.id);

    await supabase.from("market_watch_signal_links").upsert({
      plant_id:      existing.id,
      signal_id:     signalId,
      source_url:    signal.source_url || null,
      source_handle: attr.source_account_handle || null,
      signal_purpose: idea.signal_purpose || null,
    }, { onConflict: "plant_id,signal_id", ignoreDuplicates: true });

  } else {
    const { data: newPlant } = await supabase
      .from("market_watch_plants")
      .insert({
        plant_name:            plantName,
        signal_count:          1,
        question_count:        idea.evidence_type === "Question" ? 1 : 0,
        purchase_intent_count: idea.evidence_type === "Purchase intent" ? 1 : 0,
        distinct_source_count: 1,
        platforms:             signal.platform ? [signal.platform] : [],
        competitors_featuring: attr.source_account_handle ? [attr.source_account_handle] : [],
        audience_wording:      idea.audience_wording || [],
        closest_catalog_alternative: idea.matched_catalog_name || null,
        potential_catalog_opportunity: "No",
        verification_status:   "Unverified",
        reviewer_status:       "Unreviewed",
        first_seen_at:         new Date().toISOString(),
        last_seen_at:          new Date().toISOString(),
        recent_mention_count:  1,
      })
      .select().single();

    if (newPlant) {
      await supabase.from("market_watch_signal_links").insert({
        plant_id:      newPlant.id,
        signal_id:     signalId,
        source_url:    signal.source_url || null,
        source_handle: attr.source_account_handle || null,
        signal_purpose: idea.signal_purpose || null,
      });
    }
  }
}


// ── HASHTAG HELPER ────────────────────────────────────────────────────────────
// Normalises AI hashtag output to a plain space-separated string for text column.
function toHashtagArray(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val.filter(Boolean).join(' ');
  return val.trim(); // already a string
}

// ── REPETITION SOURCE TYPE HELPERS ────────────────────────────────────────────
// Maps ownership_type from the extraction prompt to the DB enum value.
function getRepetitionSourceType(ownershipType) {
  if (ownershipType === "Competitor content")                                return "competitor_repetition";
  if (ownershipType === "Owned content")                                     return "owned_archive_only";
  if (ownershipType === "Community content" || ownershipType === "Customer content") return "current_audience";
  return "current_audience"; // Unknown, Third-party media — default to audience
}

// When updating an existing cluster, keep the "strongest" repetition type seen so far.
// Priority: current_audience > competitor_repetition > market_repetition > owned_comments > owned_archive_only > none
const REP_PRIORITY = {
  current_audience:      5,
  competitor_repetition: 4,
  market_repetition:     3,
  owned_comments:        2,
  owned_archive_only:    1,
  none:                  0,
};
function mergeRepetitionType(existing, incoming) {
  const ep = REP_PRIORITY[existing]  ?? 0;
  const ip = REP_PRIORITY[incoming] ?? 0;
  return ip > ep ? incoming : existing;
}


// ── SIGNAL PROMPT ─────────────────────────────────────────────────────────────
function buildSignalPrompt(s, watchlistText) {
  return prompts.t("ai-analyze.buildSignalPrompt.1", [s.topic || s.raw_input || "", s.platform || "unknown", s.source_url || "not provided", s.caption_summary || "not provided", watchlistText]);
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
        prompts.t("ai-analyze.buildOpportunityPrompt.1", [p.video_title || p.topic, p.plant_or_product || "?", p.hook_used || "—", p.angle_used || "—", p.platform || "?", p.performance_summary || "not recorded", p.audience_followup_questions || "none"])
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
    historyLines.push(prompts.t("ai-analyze.buildOpportunityPrompt.2", [p.publish_date || "?", p.video_title || p.topic, p.plant_or_product || "?", p.hook_used || "—", p.angle_used || "—", p.performance_summary || "not recorded"]));
  });

  const historyText = historyLines.length
    ? historyLines.join("\n")
    : "No content history available yet.";

  return prompts.t("ai-analyze.buildOpportunityPrompt.3", [o.topic || "", o.plant_or_product || "", o.why_now || "", o.evidence_summary || "", o.suggested_hook || "", o.suggested_format || "", o.platform || "", o.shelf_life || "", watchlistText, historyText]);
}


// ── BRIEF PROMPT ──────────────────────────────────────────────────────────────
// NOTE: these are the REAL columns on the `briefs` table (see saveBrief() in
// index.html and schema.sql). This prompt previously read topic/platform/
// target_audience/key_message/notes, none of which exist on the table, so
// AI Review was silently reviewing blank fields regardless of brief content.
function buildBriefPrompt(b, watchlistText) {
  return prompts.t("ai-analyze.buildBriefPrompt.1", [b.title || "", b.featured_product || "not specified", b.audience_problem || "not specified", b.opening_hook || "not specified", b.visual_hook || "not specified", b.video_format || "not specified", b.video_flow || "not specified", b.caption || "not specified", b.cta || "not specified", watchlistText]);
}

// ── Plant category detection ───────────────────────────────────────────────────
// Used to scope synonym clusters so "root rot" in succulents doesn't match
// "root rot" scripts written for tropical houseplants or air plants.
// Air plants are checked FIRST — tillandsia is technically a bromeliad and
// shares some names with houseplants, but its care is completely different.
const AIR_PLANT_SIGNALS = [
  "air plant", "tillandsia", "tillandsia ionantha", "tillandsia xerographica",
  "tillandsia stricta", "tillandsia caput", "soaking air plant", "misting air plant",
  "no soil plant", "soilless plant",
];
const SUCCULENT_SIGNALS = [
  "succulent", "cactus", "cacti", "echeveria", "haworthia", "aloe", "sedum",
  "aeonium", "agave", "sempervivum", "gasteria", "lithops", "kalanchoe",
  "crassula", "jade", "euphorbia", "graptopetalum", "pachyphytum", "dudleya",
  "portulacaria", "string of pearl", "string of heart", "burro tail", "donkey tail",
  "ghost plant", "hen and chick", "prickly pear", "barrel cactus",
];
const HOUSEPLANT_SIGNALS = [
  "pothos", "monstera", "philodendron", "snake plant", "sansevieria", "zz plant",
  "zamioculcas", "peace lily", "spathiphyllum", "fern", "orchid", "calathea",
  "prayer plant", "maranta", "fiddle leaf", "ficus lyrata", "rubber plant",
  "ficus elastica", "dracaena", "spider plant", "chlorophytum", "tradescantia",
  "hoya", "anthurium", "alocasia", "dieffenbachia", "begonia",
  "syngonium", "arrowhead", "chinese evergreen", "aglaonema", "bird of paradise",
  "strelitzia", "bromeliad", "peperomia",
];

function detectPlantCategory(topic) {
  const lower = (topic || "").toLowerCase();
  // Air plant checked first — overlaps with bromeliad/houseplant signals
  if (AIR_PLANT_SIGNALS.some(s => lower.includes(s))) return "airplant";
  const isSuc   = SUCCULENT_SIGNALS.some(s => lower.includes(s));
  const isHouse = HOUSEPLANT_SIGNALS.some(s => lower.includes(s));
  if (isSuc && !isHouse) return "succulent";
  if (isHouse && !isSuc) return "houseplant";
  if (isSuc && isHouse)  return "general";
  return "general";
}

// ── Topic synonym clusters ─────────────────────────────────────────────────────
// category: "succulent" | "houseplant" | "general" (matches both)
// Root cause and symptoms differ between categories, so they are separate clusters
// with different synonyms even when the problem name is similar.
const TOPIC_CLUSTERS = [
  // ── SUCCULENT-SPECIFIC ──
  { category: "succulent", name: "root rot (succulent)",
    terms: ["root rot", "mushy base", "squishy base", "soft base", "brown root", "soggy root", "rotting root", "mushy stem", "black stem base"] },
  { category: "succulent", name: "stretching / etiolation",
    terms: ["stretch", "etiolat", "leggy", "leaning", "reaching for light", "grow tall", "tall and skinny", "not enough light", "low light fix"] },
  { category: "succulent", name: "watering (succulent)",
    terms: ["overwater", "underwater", "watering succulent", "how often to water succulent", "water schedule", "soak and dry", "bottom water", "deep water"] },
  { category: "succulent", name: "leaf shriveling",
    terms: ["shriveled", "shrivelling", "wrinkled leaf", "wrinkl", "flat leaf", "deflated", "thirsty"] },
  { category: "succulent", name: "sunburn (succulent)",
    terms: ["sunburn", "sun damage", "bleach", "bleaching", "too much direct sun", "crispy tip", "white patch"] },
  { category: "succulent", name: "propagation (succulent)",
    terms: ["propagat", "leaf prop", "leaf cutting", "offset", "pup", "baby plant", "chick", "hen and chick"] },
  { category: "succulent", name: "soil (succulent)",
    terms: ["gritty mix", "well-drain", "drainage", "perlite", "coarse sand", "cactus mix", "succulent soil", "soil mix"] },

  // ── HOUSEPLANT-SPECIFIC ──
  { category: "houseplant", name: "root rot (houseplant)",
    terms: ["root rot", "mushy root", "brown root", "soggy soil", "overwatered", "standing water", "wet soil", "no drainage", "smelly soil"] },
  { category: "houseplant", name: "watering (houseplant)",
    terms: ["overwater", "underwater", "watering houseplant", "how often to water", "moisture meter", "finger test", "dry out", "let it dry"] },
  { category: "houseplant", name: "leaf yellowing",
    terms: ["yellow leaf", "yellowing", "yellow leaves", "leaf yellow", "chlorosis"] },
  { category: "houseplant", name: "leaf drop",
    terms: ["leaf drop", "dropping leaves", "falling leaves", "losing leaves"] },
  { category: "houseplant", name: "humidity (houseplant)",
    terms: ["humid", "mist", "misting", "dry air", "brown tip", "crispy edge", "humidity tray", "pebble tray"] },
  { category: "houseplant", name: "light (houseplant)",
    terms: ["low light", "indirect light", "bright indirect", "not enough light", "leggy", "leaning toward light", "grow light"] },
  { category: "houseplant", name: "propagation (houseplant)",
    terms: ["propagat", "stem cutting", "node cutting", "water propagat", "root in water", "division", "air layer"] },
  { category: "houseplant", name: "semi-hydro / leca",
    terms: ["semi-hydro", "leca", "hydropon", "water culture", "grow in water", "growing in water", "passive hydro"] },

  // ── AIR PLANT-SPECIFIC ──
  // Air plants absorb water through leaves (trichomes), never through roots.
  // "Root rot" equivalent is base rot from trapped water. No soil = no soil problems.
  { category: "airplant", name: "base rot (air plant)",
    terms: ["base rot", "mushy base", "brown base", "soft base", "rotting base", "rot at base", "bottom rot", "dark base"] },
  { category: "airplant", name: "watering (air plant)",
    terms: ["soak", "soaking", "mist", "misting", "how to water air plant", "water air plant", "watering air plant", "dunk", "submerge", "dry upside down", "shake dry"] },
  { category: "airplant", name: "drying / air circulation",
    terms: ["dry", "drying", "air circulation", "airflow", "not drying", "too wet", "sit in water", "after watering", "dry upside down", "fan"] },
  { category: "airplant", name: "crispy / dehydrated (air plant)",
    terms: ["crispy", "crisp", "dry tip", "brown tip", "curling", "curled leaf", "dehydrat", "thirsty air plant", "dry air plant"] },
  { category: "airplant", name: "sunburn (air plant)",
    terms: ["sunburn", "sun damage", "bleach", "too much sun", "direct sun", "white patch", "faded color"] },
  { category: "airplant", name: "mounting / display",
    terms: ["mount", "mounting", "display", "hang", "terrarium", "driftwood", "wire", "glue", "no pot", "how to display"] },
  { category: "airplant", name: "blooming / pups (air plant)",
    terms: ["bloom", "blooming", "flower", "after bloom", "pup", "baby", "offset", "dying after bloom", "monocarpic"] },
  { category: "airplant", name: "fertilizing (air plant)",
    terms: ["fertiliz", "fertilis", "feed air plant", "bromeliad fertilizer", "tillandsia fertilizer", "diluted fertilizer"] },

  // ── GENERAL (applies to all categories) ──
  { category: "general", name: "pests",
    terms: ["pest", "mealybug", "mealy", "spider mite", "fungus gnat", "scale insect", "aphid", "thrip", "insect", "bug infestation"] },
  { category: "general", name: "repotting",
    terms: ["repot", "re-pot", "new pot", "pot size", "root bound", "rootbound", "too small pot", "outgrown pot"] },
  { category: "general", name: "fertilizing",
    terms: ["fertiliz", "fertilis", "feed", "nutrient", "nitrogen", "phosphor", "liquid feed", "slow release fertiliz"] },
  { category: "general", name: "dormancy",
    terms: ["dormant", "dormancy", "winter care", "slow growth", "stop growing", "resting period"] },
];

// Given a topic string, return all search terms that should be used to find
// "same subject" scripts — scoped by plant category so succulent root rot
// doesn't match houseplant root rot scripts.
function expandTopicTerms(topic) {
  if (!topic) return [];
  const lower = topic.toLowerCase();
  const category = detectPlantCategory(lower);

  const expanded = new Set();
  for (const cluster of TOPIC_CLUSTERS) {
    // Only use clusters that match this topic's category (or are general)
    if (cluster.category !== "general" && cluster.category !== category) continue;
    const clusterHit = cluster.terms.some(t => lower.includes(t));
    if (clusterHit) {
      cluster.terms.forEach(t => expanded.add(t));
    }
  }

  // Fallback: 4+ char words from the topic itself for anything unclustered
  const rawWords = lower.split(/\s+/).filter(w => w.length >= 4);
  rawWords.forEach(w => expanded.add(w));

  return [...expanded];
}

// Lessons learned from past brief-review gaps — injected into brief
// generation/revision prompts so the same gaps stop recurring.
// Fetch Active/Approved learning_memory rows, optionally filtered by topic hint.
// Used by generate_brief and generate_script to inject reviewer lessons.
async function fetchLearningMemory(supabase, topicHint) {
  try {
    let q = supabase
      .from("learning_memory")
      .select("applies_to, topic, what_happened, recommendation_next_time, confidence")
      .eq("status", "Approved rule")
      .order("date_added", { ascending: false })
      .limit(15);
    const { data } = await q;
    const rows = data || [];
    if (!rows.length) return null;
    // If a topic hint is provided, prioritise matching rows using synonym expansion
    if (topicHint) {
      const expandedTerms = expandTopicTerms(topicHint);
      const matchScore = (memTopic) => {
        const t = (memTopic || "").toLowerCase();
        return expandedTerms.some(term => t.includes(term)) ? -1 : 0;
      };
      rows.sort((a, b) => {
        const aMatch = matchScore(a.topic);
        const bMatch = matchScore(b.topic);
        return aMatch - bMatch;
      });
    }
    return rows.slice(0, 10).map(m =>
      `[${m.applies_to || "general"}${m.topic ? ` · ${m.topic}` : ""}] ${m.what_happened} → ${m.recommendation_next_time}`
    ).join("\n");
  } catch (e) { return null; }
}

async function fetchBriefLessons(supabase) {
  try {
    const { data } = await supabase
      .from("settings").select("value").eq("key", "brief_gen_lessons").maybeSingle();
    return data?.value?.lessons || [];
  } catch (e) { return []; }
}

function briefLessonsBlock(lessons) {
  if (!lessons?.length) return "";
  const lines = lessons.map(l =>
    `- ${l.issue}${l.count > 1 ? ` (flagged ${l.count}× before)` : ""}`
  ).join("\n");
  return prompts.t("ai-analyze.briefLessonsBlock.1", [lines]);
}

const BRIEF_PREFLIGHT_CHECKLIST = () => prompts.t("ai-analyze.BRIEF_PREFLIGHT_CHECKLIST.1");

// ── BRIEF GENERATION PROMPT ────────────────────────────────────────────────────
// Source (`c`) is usually a content_review_candidates row (optionally with a
// joined `cluster`), or an opportunities row — both fields sets are read
// defensively since either can be passed in.
function buildGenerateBriefPrompt(c, rules, lessons, humanNotes, learningMemory) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const cluster = c.cluster || {};
  const wording = (c.representative_wording || cluster.audience_wording || []).slice(0, 5);
  const directions = (c.possible_directions || []).slice(0, 5);

  return prompts.t("ai-analyze.buildGenerateBriefPrompt.1", [c.title || c.topic || "", c.plant_or_product || cluster.plant_or_product || "not specified", c.what_people_are_saying || c.evidence_summary || c.why_now || "not specified", wording.length ? wording.map(w => `"${w}"`).join(", ") : "none captured", c.what_appears_new || "not specified", c.claims_needing_verification || "none", c.contradictory_advice || "none", c.approved_direction || prompts.t("ai-analyze.buildGenerateBriefPrompt.2"), directions.length ? directions.join(", ") : "not specified", c.suggested_hook || "none — write your own", c.suggested_format || "not specified", humanNotes ? prompts.t("ai-analyze.buildGenerateBriefPrompt.3", [humanNotes]) : "", learningMemory ? prompts.t("ai-analyze.buildGenerateBriefPrompt.4", [learningMemory]) : "", rulesText || "No rules loaded", BRIEF_PREFLIGHT_CHECKLIST(), briefLessonsBlock(lessons)]);
}

// ── BRIEF REVISION PROMPT ──────────────────────────────────────────────────────
function buildBriefRevisionPrompt(orig, feedback, rules, lessons, humanNotes) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const gaps = (feedback.gaps || []).map(g => `- ${g}`).join("\n");
  const angles = (feedback.suggested_angles || []).map(a => `- ${a}`).join("\n");

  return prompts.t("ai-analyze.buildBriefRevisionPrompt.1", [orig.title || "", orig.featured_product || "not specified", orig.audience_problem || "not specified", orig.opening_hook || "not specified", orig.visual_hook || "not specified", orig.video_format || "not specified", orig.video_flow || "not specified", orig.caption || "not specified", feedback.overall || "Needs work", gaps ? `Gaps to fix:\n${gaps}` : "No gaps listed.", angles ? prompts.t("ai-analyze.buildBriefRevisionPrompt.2", [angles]) : "", feedback.suggested_hook ? prompts.t("ai-analyze.buildBriefRevisionPrompt.3", [feedback.suggested_hook]) : "", feedback.notes ? `\nReviewer notes: ${feedback.notes}` : "", humanNotes ? prompts.t("ai-analyze.buildBriefRevisionPrompt.4", [humanNotes]) : "", rulesText || "No rules loaded", BRIEF_PREFLIGHT_CHECKLIST(), briefLessonsBlock(lessons)]);
}


// ── SCRIPT GENERATION PROMPT ──────────────────────────────────────────────────
// Lessons learned from past brand-check failures — injected into generation
// prompts so the same mistakes stop recurring.
async function fetchScriptLessons(supabase) {
  try {
    const { data } = await supabase
      .from("settings").select("value").eq("key", "script_gen_lessons").maybeSingle();
    return data?.value?.lessons || [];
  } catch (e) { return []; }
}

function lessonsBlock(lessons) {
  if (!lessons?.length) return "";
  const lines = lessons.map(l =>
    `- ${l.rule}${l.count > 1 ? ` (flagged ${l.count}× before)` : ""}: ${l.fix}`
  ).join("\n");
  return prompts.t("ai-analyze.lessonsBlock.1", [lines]);
}

// Must match the CHECK constraint on script_outputs.script_type
const ALLOWED_SCRIPT_TYPES = [
  "TikTok / Reel short script",
  "YouTube Shorts script",
  "Facebook Reel script",
  "Longer educational script",
  "Caption-only variant",
  "UGC-style script",
];

// Hard requirements the brand check always verifies — bake them in up front so
// v1 passes review instead of needing a revision round.
const SCRIPT_PREFLIGHT_CHECKLIST = () => prompts.t("ai-analyze.SCRIPT_PREFLIGHT_CHECKLIST.1");

function buildScriptGenPrompt(b, rules, targetSecs, lessons, learningMemory, recentHooks = [], recentSameTopicScripts = []) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const wordBudget = Math.round(targetSecs * 2.5); // ~150 wpm speaking pace

  // Build hook avoidance block — exact lines + structural patterns extracted from them
  const hookAvoidanceBlock = recentHooks.length
    ? prompts.t("ai-analyze.buildScriptGenPrompt.1", [recentHooks.map(h => `- "${h}"`).join("\n")])
    : "";

  // Topic repetition block — warn if this subject was covered recently
  const topicRepeatBlock = recentSameTopicScripts.length
    ? prompts.t("ai-analyze.buildScriptGenPrompt.2", [recentSameTopicScripts.length, recentSameTopicScripts.length > 1 ? "s" : "", recentSameTopicScripts.map(s => {
  const daysAgo = Math.round((Date.now() - new Date(s.created_at).getTime()) / (1000 * 60 * 60 * 24));
  return `- "${s.script_title}" (${daysAgo}d ago)${s.opening_hook ? ` — hook: "${s.opening_hook}"` : ""}`;
}).join("\n")])
    : "";

  return prompts.t("ai-analyze.buildScriptGenPrompt.3", [b.title || "", b.featured_product || "not specified", b.audience_problem || "not specified", b.opening_hook || "none — write your own", b.visual_hook || "not specified", b.video_format || "TikTok / Reel short script", b.video_flow || "not specified", targetSecs, wordBudget, topicRepeatBlock ? topicRepeatBlock + "\n\n" : "", hookAvoidanceBlock ? hookAvoidanceBlock + "\n" : "", learningMemory ? prompts.t("ai-analyze.buildScriptGenPrompt.4", [learningMemory]) : "", rulesText || "No rules loaded", SCRIPT_PREFLIGHT_CHECKLIST(), lessonsBlock(lessons), wordBudget]);
}


// ── SCRIPT REVISION PROMPT ────────────────────────────────────────────────────
function buildScriptRevisionPrompt(orig, feedback, rules, targetSecs, lessons, humanNotes, hookPattern, forceFresh, recentHooks = []) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const wordBudget = Math.round(targetSecs * 2.5);

  const violationsText = (feedback.brand_violations || []).map(v =>
    `[${v.severity}] ${v.rule}: ${v.issue}\n  Fix: ${v.fix}`
  ).join("\n");
  const hookIdeas     = (feedback.hook_suggestions || []).map(h => `- "${h}"`).join("\n");
  const improvements  = (feedback.improvements || []).map(i => `- ${i}`).join("\n");

  const hookAvoidanceBlock = recentHooks.length
    ? prompts.t("ai-analyze.buildScriptRevisionPrompt.1", [recentHooks.map(h => `- "${h}"`).join("\n")])
    : "";

  // Fresh rewrite mode: no brand check was run, user just wants a genuinely new take
  if (forceFresh) {
    return prompts.t("ai-analyze.buildScriptRevisionPrompt.2", [orig.script_title || "the same topic as the original", hookAvoidanceBlock ? "\n" + hookAvoidanceBlock + "\n" : "", orig.script_version || "v1", orig.script_title || "", orig.platform || "", orig.opening_hook || "", orig.full_voiceover_script || "", humanNotes ? prompts.t("ai-analyze.buildScriptRevisionPrompt.3", [humanNotes]) : "", targetSecs, wordBudget, rulesText || "No rules loaded", SCRIPT_PREFLIGHT_CHECKLIST(), lessonsBlock(lessons), hookPattern ? prompts.t("ai-analyze.buildScriptRevisionPrompt.4", [hookPattern]) : prompts.t("ai-analyze.buildScriptRevisionPrompt.5"), wordBudget]);
  }

  return prompts.t("ai-analyze.buildScriptRevisionPrompt.6", [orig.script_title || "the same topic as the original", hookAvoidanceBlock ? "\n" + hookAvoidanceBlock + "\n" : "", orig.script_version || "v1", orig.script_title || "", orig.platform || "", orig.opening_hook || "", orig.full_voiceover_script || "", orig.on_screen_text || "none", orig.cta || "none", orig.caption || "none", feedback.score ?? "?", feedback.overall || "Needs revision", violationsText ? prompts.t("ai-analyze.buildScriptRevisionPrompt.7", [violationsText]) : "No brand violations.", hookIdeas ? prompts.t("ai-analyze.buildScriptRevisionPrompt.8", [hookIdeas]) : "", improvements ? prompts.t("ai-analyze.buildScriptRevisionPrompt.9", [improvements]) : "", feedback.notes ? `\nReviewer notes: ${feedback.notes}` : "", humanNotes ? prompts.t("ai-analyze.buildScriptRevisionPrompt.10", [humanNotes]) : "", targetSecs, wordBudget, rulesText || "No rules loaded", SCRIPT_PREFLIGHT_CHECKLIST(), lessonsBlock(lessons), hookPattern ? prompts.t("ai-analyze.buildScriptRevisionPrompt.11", [hookPattern]) : '', wordBudget]);
}

// ── SCRIPT PROMPT ─────────────────────────────────────────────────────────────
function buildScriptPrompt(s, rules) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");

  // Spoken-pace duration estimate: ~150 words/min ≈ 2.5 words/sec
  const words = (s.full_voiceover_script || "").trim().split(/\s+/).filter(Boolean).length;
  const spokenSecs = words ? Math.round(words / 2.5) : null;
  const target = s.estimated_duration_seconds || null;

  return prompts.t("ai-analyze.buildScriptPrompt.1", [s.script_title || "", s.platform || "", s.script_type || "", s.opening_hook || "not provided", s.full_voiceover_script || "not provided", words ? prompts.t("ai-analyze.buildScriptPrompt.2", [words, spokenSecs]) : "not provided", target ? `${target}s` : "not set", s.cta || "not provided", s.caption || "not provided", rulesText || "No rules loaded"]);
}


// ── CALL CLAUDE ───────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1024) {
  const data = await claude.messages({
    model:      CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new PublicError(502, "Could not read the AI response. Try again.");

  return JSON.parse(jsonMatch[1] || jsonMatch[0]);
}


// ── EXTRACTION PROMPT ─────────────────────────────────────────────────────────
// Full extraction: source attribution → dates → ideas → routing
function buildExtractionPrompt(signal) {
  return prompts.t("ai-analyze.buildExtractionPrompt.1", [signal.platform || "unknown", signal.source_url || "not provided", signal.raw_input || signal.caption_summary || signal.topic || "not provided", new Date().toISOString(), new Date().toISOString()]);
}


// ── CLUSTER MATCH PROMPT ──────────────────────────────────────────────────────
// Step 2: Find best matching cluster or declare new
function buildClusterMatchPrompt(extracted, existingClusters) {
  const clusterList = existingClusters.length
    ? existingClusters.map((c, i) =>
        prompts.t("ai-analyze.buildClusterMatchPrompt.1", [i, c.id, c.title, c.plant_or_product || "?", c.signal_count, c.primary_question || "—", (c.audience_wording || []).slice(0, 3).join(" / ")])
      ).join("\n")
    : "No existing clusters";

  return prompts.t("ai-analyze.buildClusterMatchPrompt.2", [extracted.normalized_cluster_title || extracted.cluster_title, extracted.plant || "unknown", extracted.core_issue || "none", extracted.question || "none", (extracted.problems || []).join(", ") || "none", (extracted.tips || []).join(", ") || "none", (extracted.audience_wording || []).join(", ") || "none", extracted.evidence_type || "unknown", clusterList]);
}


// ── CANDIDATE PROMPT ──────────────────────────────────────────────────────────
// Step 3: Prepare a Content Review candidate card for a qualifying cluster
function buildCandidatePrompt(cluster, sheetEntries, dbPublished, watchlistText) {
  const historyLines = [];
  sheetEntries.forEach(e => {
    historyLines.push(`[${e.month} 2026] "${e.title}"${e.style ? " | " + e.style : ""}${e.note ? " | " + e.note : ""}`);
  });
  dbPublished.forEach(p => {
    historyLines.push(prompts.t("ai-analyze.buildCandidatePrompt.1", [p.publish_date || "?", p.video_title || p.topic, p.plant_or_product || "?", p.hook_used || "—", p.performance_summary || "not recorded", p.audience_followup_questions || "none"]));
  });
  const historyText = historyLines.length ? historyLines.join("\n") : "No content history available.";

  return prompts.t("ai-analyze.buildCandidatePrompt.2", [cluster.title, cluster.plant_or_product || "unknown", cluster.primary_question || "none", (cluster.problems_mentioned || []).join(", ") || "none", (cluster.tips_mentioned || []).join(", ") || "none", (cluster.audience_wording || []).slice(0, 8).join(", ") || "none", cluster.novelty_status || "Unclear", cluster.signal_count, cluster.question_count, cluster.distinct_source_count, (cluster.platforms || []).join(", ") || "unknown", cluster.first_seen_at || "unknown", cluster.last_seen_at || "unknown", watchlistText, historyText]);
}


// ── PATTERN QUALIFICATION ─────────────────────────────────────────────────────
// Returns { qualifies: true, reason } or false.
// v14: manual_signal_count and owned_comment_signal_count trigger earlier qualification.
// NOTE: 2 distinct sources alone does NOT qualify for Content Review.
function checkQualification(cluster) {
  const asc    = cluster.audience_signal_count     ?? cluster.signal_count ?? 0;
  const manual = cluster.manual_signal_count        ?? 0;
  const owned  = cluster.owned_comment_signal_count ?? 0;
  const qc     = cluster.question_count             ?? 0;
  const dc     = cluster.distinct_source_count      ?? 0;
  const rc     = cluster.recent_mention_count       ?? 0;
  const pc     = cluster.previous_mention_count     ?? 0;

  // v14 Rule 0a: 1 manual + 1 question = immediately worth reviewing
  if (manual >= 1 && qc >= 1)
    return { qualifies: true, reason: `Manual signal with ${qc} audience question(s)` };

  // v14 Rule 0b: Strong owned-comment demand
  if (owned >= 2)
    return { qualifies: true, reason: `${owned} owned comment signals — audience follow-up demand` };

  // Rule 1: 3+ independent audience questions
  if (qc >= 3)
    return { qualifies: true, reason: `${qc} independent audience questions` };

  // Rule 2: 3+ audience signals across 2+ distinct sources
  if (asc >= 3 && dc >= 2)
    return { qualifies: true, reason: `${asc} audience signals across ${dc} sources` };

  // Rule 3a: 2+ sources + meaningful growth (at least double AND at least 3 recent)
  if (dc >= 2 && rc >= 3 && pc > 0 && rc >= pc * 2)
    return { qualifies: true, reason: `Growth: ${pc} → ${rc} mentions across ${dc} sources` };

  // Rule 3b: 2+ sources + new tip or claim (routes to Needs research)
  if (dc >= 2 && cluster.novelty_status === "New tip or claim")
    return { qualifies: true, reason: `New tip or claim across ${dc} sources — needs verification` };

  // Rule 3c: 2+ sources + contradiction
  if (dc >= 2 && cluster.contradiction_status === "Detected")
    return { qualifies: true, reason: `Conflicting advice detected across ${dc} sources` };

  // Rule 4: Reviewer manually pinned
  if (cluster.reviewer_status === "Pinned")
    return { qualifies: true, reason: "Manually pinned by reviewer" };

  return false;
}
