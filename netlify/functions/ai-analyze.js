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
const { requireUserRole, getUserId, CORS_HEADERS: headers } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "extract-v2";

exports.handler = async (event) => {

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  // Internal calls from batch-cluster / submit-signal pass a shared secret instead of a user token
  const internalSecret = event.headers["x-internal-secret"] || event.headers["X-Internal-Secret"];
  if (!internalSecret || internalSecret !== process.env.INTERNAL_SECRET) {
    const authError = await requireUserRole(event, supabase, ["admin", "owner", "assistant"]);
    if (authError) return authError;
  }
  const performedBy = await getUserId(event, supabase); // null for internal secret calls

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

      result = { ...orig, ...updates };

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

      const target = Math.min(600, Math.max(5, Number(data.target_duration_seconds) || 20));
      const lessons = await fetchScriptLessons(supabase);
      const learningMemory = await fetchLearningMemory(supabase, data.featured_product || data.title);
      prompt = buildScriptGenPrompt(data, rules || [], target, lessons, learningMemory);
      const gen = await callClaude(prompt, 2048);

      // Auto duration: ~150 words/min ≈ 2.5 words/sec of voiceover
      const words = (gen.full_voiceover_script || "").trim().split(/\s+/).filter(Boolean).length;
      const estSecs = words ? Math.max(5, Math.round(words / 2.5)) : target;

      const row = {
        brief_id:                   data.id || null,
        platform:                   gen.platform || data.platform || "TikTok",
        script_title:               gen.script_title || data.title || "Untitled script",
        script_version:             "v1",
        script_type:                gen.script_type || "TikTok / Reel short script",
        opening_hook:               gen.opening_hook || null,
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

      const target = Math.min(600, Math.max(5, Number(orig.estimated_duration_seconds) || 20));
      const lessons = await fetchScriptLessons(supabase);
      prompt = buildScriptRevisionPrompt(orig, feedback, rules || [], target, lessons, data.human_notes || null, data.hook_pattern || null, data.force_fresh || false);
      const gen = await callClaude(prompt, 2048);

      const words   = (gen.full_voiceover_script || "").trim().split(/\s+/).filter(Boolean).length;
      const estSecs = words ? Math.max(5, Math.round(words / 2.5)) : target;
      // v1 → v2 → v3 …
      const nextVersion = "v" + ((parseInt(String(orig.script_version || "v1").replace(/\D/g, ""), 10) || 1) + 1);

      const row = {
        brief_id:                   orig.brief_id || null,
        platform:                   gen.platform || orig.platform || "TikTok",
        script_title:               gen.script_title || orig.script_title || "Untitled script",
        script_version:             nextVersion,
        script_type:                gen.script_type || orig.script_type || "TikTok / Reel short script",
        opening_hook:               gen.opening_hook || null,
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
    console.error("ai-analyze error:", err);
    // If clustering failed: scraper signals → delete; manual → mark Needs cleanup
    if (type === "cluster" && data?.id) {
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


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
// NOTE: these are the REAL columns on the `briefs` table (see saveBrief() in
// index.html and schema.sql). This prompt previously read topic/platform/
// target_audience/key_message/notes, none of which exist on the table, so
// AI Review was silently reviewing blank fields regardless of brief content.
function buildBriefPrompt(b, watchlistText) {
  return `You are reviewing a video brief for Succulents Box, a succulent plant subscription company.

BRIEF TITLE: ${b.title || ""}
FEATURED PRODUCT: ${b.featured_product || "not specified"}
AUDIENCE PROBLEM: ${b.audience_problem || "not specified"}
OPENING HOOK: ${b.opening_hook || "not specified"}
VISUAL HOOK: ${b.visual_hook || "not specified"}
VIDEO FORMAT: ${b.video_format || "not specified"}
VIDEO FLOW: ${b.video_flow || "not specified"}
CAPTION DRAFT: ${b.caption || "not specified"}
CALL TO ACTION: ${b.cta || "not specified"}

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

// Lessons learned from past brief-review gaps — injected into brief
// generation/revision prompts so the same gaps stop recurring.
// Fetch Active/Approved learning_memory rows, optionally filtered by topic hint.
// Used by generate_brief and generate_script to inject reviewer lessons.
async function fetchLearningMemory(supabase, topicHint) {
  try {
    let q = supabase
      .from("learning_memory")
      .select("applies_to, topic, what_happened, recommendation_next_time, confidence")
      .in("status", ["Active", "Approved rule"])
      .order("date_added", { ascending: false })
      .limit(15);
    const { data } = await q;
    const rows = data || [];
    if (!rows.length) return null;
    // If a topic hint is provided, prioritise matching rows (put them first)
    if (topicHint) {
      const hint = (topicHint || "").toLowerCase();
      rows.sort((a, b) => {
        const aMatch = (a.topic || "").toLowerCase().includes(hint) || hint.includes((a.topic || "").toLowerCase()) ? -1 : 0;
        const bMatch = (b.topic || "").toLowerCase().includes(hint) || hint.includes((b.topic || "").toLowerCase()) ? -1 : 0;
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
  return `\nPAST REVIEWER FEEDBACK — previous briefs were marked "Needs work"/"Incomplete" for these exact gaps. Do NOT repeat them:\n${lines}\n`;
}

const BRIEF_PREFLIGHT_CHECKLIST = `
PRE-FLIGHT CHECKLIST — the brief will be marked incomplete if ANY of these are missing:
1. Audience problem: must name the specific problem/question the audience has, in their own words — not just a topic label.
2. Opening hook: must create curiosity or name the problem in one line — never a generic restatement of the title.
3. Visual hook: must describe a specific, filmable first shot (not "show the plant").
4. Video flow: must lay out concrete steps/beats the video follows, not a vague summary.
5. CTA: every brief must end with a clear call to action.`;

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

  return `You are writing a first-draft video brief for Succulents Box, a succulent plant subscription company, based on an approved audience-research finding.

SOURCE TITLE: ${c.title || c.topic || ""}
PLANT / PRODUCT: ${c.plant_or_product || cluster.plant_or_product || "not specified"}
WHAT PEOPLE ARE SAYING: ${c.what_people_are_saying || c.evidence_summary || c.why_now || "not specified"}
AUDIENCE WORDING (exact phrases): ${wording.length ? wording.map(w => `"${w}"`).join(", ") : "none captured"}
WHAT APPEARS NEW: ${c.what_appears_new || "not specified"}
CLAIMS NEEDING VERIFICATION: ${c.claims_needing_verification || "none"}
CONTRADICTORY ADVICE FOUND: ${c.contradictory_advice || "none"}
APPROVED DIRECTION (reviewer's chosen angle — follow this if given): ${c.approved_direction || "not specified — pick the strongest of the possible directions below"}
POSSIBLE DIRECTIONS: ${directions.length ? directions.join(", ") : "not specified"}
SUGGESTED HOOK FROM RESEARCH: ${c.suggested_hook || "none — write your own"}
SUGGESTED FORMAT: ${c.suggested_format || "not specified"}
${humanNotes ? `\nHUMAN EDITOR NOTES (incorporate these into the brief):\n${humanNotes}` : ""}
${learningMemory ? `\nREVIEWER LESSONS FROM PAST CONTENT — apply these when writing the brief:\n${learningMemory}` : ""}
BRAND RULES (follow all Required rules, never do Forbidden ones):
${rulesText || "No rules loaded"}
${BRIEF_PREFLIGHT_CHECKLIST}
${briefLessonsBlock(lessons)}
Writing guidance:
- The audience problem must be written in plain audience language, grounded in the wording above — not a generic restatement of the title.
- The opening hook must create curiosity or name the problem in the first line.
- Video flow should read as a short numbered/beat outline a filmmaker could follow.

Return ONLY valid JSON:
{
  "title": "short internal title",
  "featured_product": "plant or product name, or null",
  "audience_problem": "the specific problem/question in plain audience language",
  "opening_hook": "first line of the video, under 12 words",
  "visual_hook": "specific first shot — what's on screen in the first 2 seconds",
  "video_format": "Talking head | Tutorial | Before & after | POV | Timelapse | Voiceover",
  "video_flow": "Step 1: … Step 2: … one per line",
  "caption": "post caption, 1-2 sentences",
  "cta": "closing call to action"
}`;
}

// ── BRIEF REVISION PROMPT ──────────────────────────────────────────────────────
function buildBriefRevisionPrompt(orig, feedback, rules, lessons, humanNotes) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const gaps = (feedback.gaps || []).map(g => `- ${g}`).join("\n");
  const angles = (feedback.suggested_angles || []).map(a => `- ${a}`).join("\n");

  return `You are revising a video brief for Succulents Box, a succulent plant subscription company.
A reviewer flagged gaps in the current brief. Write an improved version that fixes EVERY gap while keeping what already works.

CURRENT BRIEF:
Title: ${orig.title || ""}
Featured product: ${orig.featured_product || "not specified"}
Audience problem: ${orig.audience_problem || "not specified"}
Opening hook: ${orig.opening_hook || "not specified"}
Visual hook: ${orig.visual_hook || "not specified"}
Video format: ${orig.video_format || "not specified"}
Video flow: ${orig.video_flow || "not specified"}
Caption: ${orig.caption || "not specified"}
CTA: ${orig.cta || "not specified"}

REVIEWER FEEDBACK (verdict: ${feedback.overall || "Needs work"}):
${gaps ? `Gaps to fix:\n${gaps}` : "No gaps listed."}
${angles ? `\nSuggested angles not yet covered:\n${angles}` : ""}
${feedback.suggested_hook ? `\nReviewer's suggested hook: "${feedback.suggested_hook}"` : ""}
${feedback.notes ? `\nReviewer notes: ${feedback.notes}` : ""}
${humanNotes ? `\nHUMAN EDITOR NOTES (incorporate these into the revision):\n${humanNotes}` : ""}

BRAND RULES (follow all Required rules, never do Forbidden ones):
${rulesText || "No rules loaded"}
${BRIEF_PREFLIGHT_CHECKLIST}
${briefLessonsBlock(lessons)}
Keep the parts of the original that were NOT flagged — this is a revision, not a rewrite from scratch.

Return ONLY valid JSON:
{
  "title": "short internal title (keep the original unless it was flagged)",
  "featured_product": "plant or product name, or null",
  "audience_problem": "the specific problem/question in plain audience language",
  "opening_hook": "first line of the video, under 12 words",
  "visual_hook": "specific first shot — what's on screen in the first 2 seconds",
  "video_format": "Talking head | Tutorial | Before & after | POV | Timelapse | Voiceover",
  "video_flow": "Step 1: … Step 2: … one per line",
  "caption": "post caption, 1-2 sentences",
  "cta": "closing call to action"
}`;
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
  return `\nPAST REVIEWER FEEDBACK — previous scripts failed brand review for these exact reasons. Do NOT repeat them:\n${lines}\n`;
}

// Hard requirements the brand check always verifies — bake them in up front so
// v1 passes review instead of needing a revision round.
const SCRIPT_PREFLIGHT_CHECKLIST = `
PRE-FLIGHT CHECKLIST — the script will be rejected if ANY of these are missing:
1. CTA: every script MUST end with a clear call to action matched to viewer intent (e.g. "Save this before you water." / "Comment which one yours looks like.").
2. Caption: the "caption" field MUST be filled in — it doubles as the cover/text overlay.
3. Visual opening: the shot list MUST specify what is on screen in the first 2 seconds, and it must show the plant/symptom/comparison immediately.
4. Hook: must create curiosity or name the specific problem — NEVER restate the title or open with a generic question like "Is your plant dying?".
5. Care claims: hedge diagnosis language based on visual signs ("usually points to", "often means") — never absolute verdicts like "your roots are rotting".`;

function buildScriptGenPrompt(b, rules, targetSecs, lessons, learningMemory) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const wordBudget = Math.round(targetSecs * 2.5); // ~150 wpm speaking pace

  return `You are writing a short-form video script for Succulents Box, a succulent plant subscription company.

BRIEF:
Title: ${b.title || ""}
Featured product: ${b.featured_product || "not specified"}
Audience problem: ${b.audience_problem || "not specified"}
Hook idea from brief: ${b.opening_hook || "none — write your own"}
Visual hook: ${b.visual_hook || "not specified"}
Video format: ${b.video_format || "TikTok / Reel short script"}
Video flow: ${b.video_flow || "not specified"}
CTA: ${b.cta || "not specified"}

TARGET DURATION: ${targetSecs} seconds — the voiceover must be about ${wordBudget} words (±15%). Do NOT exceed this.

${learningMemory ? `REVIEWER LESSONS FROM PAST CONTENT — apply these when writing the script:\n${learningMemory}\n` : ""}
BRAND RULES (follow all Required rules, never do Forbidden ones):
${rulesText || "No rules loaded"}
${SCRIPT_PREFLIGHT_CHECKLIST}
${lessonsBlock(lessons)}
Writing guidance:

HOOK (opening_hook field - most important line of the script):
The first line determines whether someone keeps watching. Apply ONE of these proven TikTok hook patterns:
1. SYMPTOM FIRST - lead with what the viewer already sees or feels, not the topic name.
   Good: "Your succulent leaves are getting mushy and you don't know why."
   Bad: "Today we're talking about overwatering."
2. CHALLENGE A BELIEF - open with something counterintuitive.
   Good: "The more you water a succulent, the faster it dies."
   Bad: "Succulents are easy to care for."
3. STAKES / URGENCY - something is at risk right now.
   Good: "If you don't fix this before summer, your plant won't make it."
   Bad: "Here are some care tips for your succulent."
4. BOLD CLAIM - promise a specific, surprising payoff.
   Good: "Three signs your succulent is begging you to stop watering."
   Bad: "Let me show you how to water your succulent."
5. MID-ACTION START - drop the viewer into the middle of something.
   Good: "Wait - before you water that, look at the soil first."
   Bad: "Hi everyone, today I want to talk about..."

Hook rules (non-negotiable):
- Must use "you" or "your" - speak directly to the viewer, not about succulents in general.
- Must be under 10 words.
- Must NOT start with "Today", "Hi", "Welcome", "In this video", or a restatement of the title.
- Must name a problem the viewer already has OR make a bold claim they haven't heard before.
- Must create a reason to keep watching in the first 2 seconds.
- No em dashes in the hook or anywhere in the script.

Script structure:
- Casual, warm, plant-lover language. Short sentences that sound natural spoken aloud.
- Structure: hook → problem/payoff → 2-3 concrete tips or steps → CTA.

Return ONLY valid JSON:
{
  "script_title": "short internal title",
  "platform": "TikTok | Instagram | YouTube | Facebook",
  "script_type": "TikTok / Reel short script | YouTube Shorts script | Facebook Reel script | Longer educational script | UGC-style script",
  "opening_hook": "first line of the video, under 12 words",
  "full_voiceover_script": "the complete spoken script, ~${wordBudget} words",
  "on_screen_text": "text overlays, one per line",
  "shot_list": "Shot 1: … one per line",
  "broll_notes": "b-roll / close-up suggestions",
  "product_mention": "how/when the product is mentioned, or null",
  "cta": "closing call to action",
  "caption": "post caption, 1-2 sentences",
  "hashtags": "#space #separated #hashtags"
}`;
}


// ── SCRIPT REVISION PROMPT ────────────────────────────────────────────────────
function buildScriptRevisionPrompt(orig, feedback, rules, targetSecs, lessons, humanNotes, hookPattern, forceFresh) {
  const rulesText = rules.map(r =>
    `[${r.severity}] ${r.category} — ${r.rule_name}: ${r.rule_text}`
  ).join("\n");
  const wordBudget = Math.round(targetSecs * 2.5);

  const violationsText = (feedback.brand_violations || []).map(v =>
    `[${v.severity}] ${v.rule}: ${v.issue}\n  Fix: ${v.fix}`
  ).join("\n");
  const hookIdeas     = (feedback.hook_suggestions || []).map(h => `- "${h}"`).join("\n");
  const improvements  = (feedback.improvements || []).map(i => `- ${i}`).join("\n");

  // Fresh rewrite mode: no brand check was run, user just wants a genuinely new take
  if (forceFresh) {
    return `You are writing a fresh new version of a short-form video script for Succulents Box, a succulent plant subscription company.
The previous version is shown below as reference only — do NOT copy it. Write a meaningfully different script on the same topic.

PREVIOUS SCRIPT (${orig.script_version || "v1"}) — for reference, do NOT reuse its hook or opening structure:
Topic/title: ${orig.script_title || ""}
Platform: ${orig.platform || ""}
Previous hook (must be replaced): "${orig.opening_hook || ""}"
Previous voiceover: ${orig.full_voiceover_script || ""}
CTA: ${orig.cta || ""}

${humanNotes ? `EDITOR DIRECTION (prioritize these above all else):\n${humanNotes}\n` : ""}
TARGET DURATION: ${targetSecs} seconds — voiceover must be about ${wordBudget} words (±15%).

BRAND RULES (follow all Required rules, never do Forbidden ones):
${rulesText || "No rules loaded"}
${SCRIPT_PREFLIGHT_CHECKLIST}
${lessonsBlock(lessons)}
Writing guidance:

HOOK (write a brand new hook - do not use or paraphrase the previous one):
${hookPattern ? `REQUESTED HOOK PATTERN: Use the "${hookPattern}" pattern specifically.\n` : "Pick whichever pattern creates the strongest hook for this topic."}
Apply ONE of these proven TikTok hook patterns:
1. SYMPTOM FIRST - lead with what the viewer already sees, not the topic name.
   Good: "Your succulent leaves are getting mushy and you don't know why."
2. CHALLENGE A BELIEF - counterintuitive opener.
   Good: "The more you water a succulent, the faster it dies."
3. STAKES / URGENCY - something is at risk right now.
   Good: "If you don't fix this before summer, your plant won't make it."
4. BOLD CLAIM - specific, surprising payoff.
   Good: "Three signs your succulent is begging you to stop watering."
5. MID-ACTION START - drop into the middle of something.
   Good: "Wait - before you water that, look at the soil first."
Hook rules: use "you"/"your", under 10 words, never start with "Today"/"Hi"/"In this video", must name a problem or make a bold claim, no em dashes.

Script: casual, warm, plant-lover language. Short sentences that sound natural spoken aloud.
Structure: hook -> problem/payoff -> 2-3 concrete tips or steps -> CTA.

Return ONLY valid JSON:
{
  "script_title": "short internal title",
  "platform": "${orig.platform || "TikTok"}",
  "script_type": "${orig.script_type || "TikTok / Reel short script"}",
  "opening_hook": "first line of the video, under 10 words",
  "full_voiceover_script": "the complete spoken script, ~${wordBudget} words",
  "on_screen_text": "text overlays, one per line",
  "shot_list": "Shot 1: ... one per line",
  "broll_notes": "b-roll / close-up suggestions",
  "product_mention": "how/when the product is mentioned, or null",
  "cta": "closing call to action",
  "caption": "post caption, 1-2 sentences",
  "hashtags": "#space #separated #hashtags"
}`;
  }

  return `You are revising a short-form video script for Succulents Box, a succulent plant subscription company.
A brand reviewer flagged issues in the current version. Write an improved version that fixes EVERY flagged issue while keeping what already works.

CURRENT SCRIPT (${orig.script_version || "v1"}):
Title: ${orig.script_title || ""}
Platform: ${orig.platform || ""}
Hook: ${orig.opening_hook || ""}
Voiceover:
${orig.full_voiceover_script || ""}
On-screen text: ${orig.on_screen_text || "none"}
CTA: ${orig.cta || "none"}
Caption: ${orig.caption || "none"}

REVIEWER FEEDBACK (score ${feedback.score ?? "?"}/100, verdict: ${feedback.overall || "Needs revision"}):
${violationsText ? `Brand issues to fix — ALL Required issues MUST be resolved:\n${violationsText}` : "No brand violations."}
${hookIdeas ? `\nStronger hook ideas from the reviewer (use one or write something equally strong):\n${hookIdeas}` : ""}
${improvements ? `\nSuggested improvements:\n${improvements}` : ""}
${feedback.notes ? `\nReviewer notes: ${feedback.notes}` : ""}
${humanNotes ? `\nHUMAN EDITOR NOTES (incorporate these into the revision):\n${humanNotes}` : ""}

TARGET DURATION: ${targetSecs} seconds — the voiceover must be about ${wordBudget} words (±15%). Do NOT exceed this.

BRAND RULES (follow all Required rules, never do Forbidden ones):
${rulesText || "No rules loaded"}
${SCRIPT_PREFLIGHT_CHECKLIST}
${lessonsBlock(lessons)}
Writing guidance:

HOOK (if the hook was flagged, rewrite it - if it wasn't, keep it or make it stronger):
${hookPattern ? `REQUESTED HOOK PATTERN: Use the "${hookPattern}" pattern specifically.\n` : ''}Apply ONE of these proven TikTok hook patterns:
1. SYMPTOM FIRST - lead with what the viewer already sees, not the topic name.
   Good: "Your succulent leaves are getting mushy and you don't know why."
2. CHALLENGE A BELIEF - counterintuitive opener.
   Good: "The more you water a succulent, the faster it dies."
3. STAKES / URGENCY - something is at risk right now.
   Good: "If you don't fix this before summer, your plant won't make it."
4. BOLD CLAIM - specific, surprising payoff.
   Good: "Three signs your succulent is begging you to stop watering."
5. MID-ACTION START - drop into the middle of something.
   Good: "Wait - before you water that, look at the soil first."
Hook rules: use "you"/"your", under 10 words, never start with "Today"/"Hi"/"In this video", must name a problem or make a bold claim, no em dashes.

Script:
- Casual, warm, plant-lover language. Short sentences that sound natural spoken aloud.
- Keep the parts of the original that were NOT flagged — this is a revision, not a rewrite from scratch.

Return ONLY valid JSON:
{
  "script_title": "short internal title (keep the original unless it was flagged)",
  "platform": "TikTok | Instagram | YouTube | Facebook",
  "script_type": "TikTok / Reel short script | YouTube Shorts script | Facebook Reel script | Longer educational script | UGC-style script",
  "opening_hook": "first line of the video, under 12 words",
  "full_voiceover_script": "the complete spoken script, ~${wordBudget} words",
  "on_screen_text": "text overlays, one per line",
  "shot_list": "Shot 1: … one per line",
  "broll_notes": "b-roll / close-up suggestions",
  "product_mention": "how/when the product is mentioned, or null",
  "cta": "closing call to action",
  "caption": "post caption, 1-2 sentences",
  "hashtags": "#space #separated #hashtags"
}`;
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

  return `You are reviewing a video script for Succulents Box, a succulent plant subscription company.

SCRIPT TITLE: ${s.script_title || ""}
PLATFORM: ${s.platform || ""}
TYPE: ${s.script_type || ""}
HOOK: ${s.opening_hook || "not provided"}
VOICEOVER: ${s.full_voiceover_script || "not provided"}
VOICEOVER LENGTH: ${words ? `${words} words ≈ ${spokenSecs}s at a normal speaking pace` : "not provided"}
TARGET DURATION: ${target ? `${target}s` : "not set"}
CTA: ${s.cta || "not provided"}
CAPTION: ${s.caption || "not provided"}

BRAND RULES:
${rulesText || "No rules loaded"}

Review this script and return ONLY valid JSON:
{
  "overall": "Approved | Needs revision | Rejected",
  "score": 85,
  "hook_strength": "Strong | Weak | Missing",
  "hook_suggestions": ["2-3 stronger alternative opening hooks, each under 12 words, written in casual audience language (curiosity gap, surprising fact, or direct question). Empty array if hook_strength is Strong."],
  "duration_check": "OK | Too long — spoken length exceeds target, suggest what to cut | Too short — suggest what to add | No target set",
  "cta_present": true,
  "brand_violations": [
    { "severity": "Required|Recommended|Avoid|Forbidden", "rule": "rule name", "issue": "what's wrong", "fix": "how to fix it" }
  ],
  "strengths": ["strength 1"],
  "improvements": ["improvement 1"],
  "notes": "overall 1-2 sentence summary"
}

Score out of 100. brand_violations empty array if none found. A hook is Strong only if it creates curiosity or names a specific problem in the first sentence — restating the title is Weak.`;
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
// Full extraction: source attribution → dates → ideas → routing
function buildExtractionPrompt(signal) {
  return `You are analyzing a social listening signal for Succulents Box, a succulent plant subscription company.

RAW SIGNAL:
Platform:   ${signal.platform || "unknown"}
Source URL: ${signal.source_url || "not provided"}
Content:    ${signal.raw_input || signal.caption_summary || signal.topic || "not provided"}

═══════════════════════════════════════════════════
STEP 1 — SOURCE ATTRIBUTION
═══════════════════════════════════════════════════
Identify who published this content BEFORE reading its meaning.

Succulents Box official handles: @succulentsbox (Instagram, TikTok, Facebook).
Any other account is NOT owned content, even if it tags or collaborates with Succulents Box.

ownership_type values:
  Owned content       — published by an official Succulents Box account
  Competitor content  — plant seller, nursery, or direct competitor
  Community content   — plant hobbyist, grower community, non-commercial creator
  Customer content    — a customer of Succulents Box
  Third-party media   — blogger, media outlet, aggregator
  Unknown             — cannot be determined from available information

Rules:
- Never infer ownership from the monitoring account, scraper URL, or dashboard.
- Collaborator status does not make content "owned" unless an official SB account is the publisher.
- If account cannot be identified, use Unknown.

═══════════════════════════════════════════════════
STEP 2 — DATE EXTRACTION
═══════════════════════════════════════════════════
Separate these three date types:

  published_at        — platform publication timestamp (ISO 8601). If only relative ("3 hours ago"), estimate from observed_at and mark estimated: true.
  observed_at         — when this system collected the signal (use ${new Date().toISOString()}).
  event_dates_claimed — dates mentioned INSIDE the caption, image, or transcript (entry deadlines, sale dates, event dates). These are NOT publication dates.

Never use an event date as the publication date.

═══════════════════════════════════════════════════
STEP 3 — LANGUAGE + RELEVANCE CHECK
═══════════════════════════════════════════════════
First: Is the caption or audience content written primarily in a non-English language?
  Non-English = Spanish, French, Portuguese, Serbian, Turkish, Korean, Japanese, German, Dutch, etc.
  Exception: scientific plant names (Latin) are fine. A single non-English word in an otherwise English post is fine.
  If the main body of text is non-English → { "relevant": false, "noise_reason": "Non-English content" }

Second: Is this signal relevant to the plant/succulent market?
  Relevant = succulents, cacti, houseplants, plant care, propagation, watering, soil, pots, plant products, or anything a plant hobbyist would care about.
  NOT relevant = unrelated food, fashion, travel, celebrities, non-plant viral trends.

If NOT relevant:
{ "relevant": false, "noise_reason": "one sentence why" }

═══════════════════════════════════════════════════
STEP 4 — EXTRACT IDEAS + ROUTING
═══════════════════════════════════════════════════
If relevant, extract EVERY distinct idea. Most signals have 1. A post with two plants or two issues produces 2 ideas.

For each idea:

A) Context normalization
  core_issue          — the reusable question, problem, tip, or claim (stripped of incidental details)
  relevant_conditions — conditions that materially change the care answer (frost zone, humidity, indoor/outdoor, season)
  incidental_context  — details that describe the source but don't define the issue (city, personal story, promo language)
  Location rule: keep location only when it changes the meaning. Never put a country/city in normalized_cluster_title unless the cluster is genuinely about that region.

B) Plant and catalog matching
  plant               — plant or product name extracted from the signal
  catalog_match_status:
    Catalog match        — plant clearly matches an SB product (by scientific name, common name, cultivar, product title, or known alias)
    Catalog family match — matches a genus or family SB carries but specific variety unclear
    Not in catalog       — plant is confirmed outside current SB catalog
    Needs catalog review — name is ambiguous or uncertain
    No plant identified  — no plant mentioned

C) Signal purpose
  signal_purpose — what the source is doing:
    Audience question | Problem report | Care tip | Care claim | Comparison | Disagreement | Follow-up request |
    Product showcase | Giveaway or contest | Sale or promotion | Product launch | Availability announcement |
    Collaboration | General sentiment | Lifestyle post | Other

  IMPORTANT: Marketing copy from the source account is NOT audience wording.
  audience_wording = public comments, viewer questions, community phrases.
  source_marketing_wording = promotional captions, contest instructions, seller claims.

D) Section routing (assign based on ownership + purpose + catalog status)

  GEOGRAPHIC FILTER — apply when there is clear non-US evidence:
  Succulents Box ships within the US only. Apply this filter if the caption, bio, or content contains
  one or more of these signals:
    - Non-US currency (£, €, ₹, ₱, ¥, ₩, AUS$, NZ$, CAD$, R for ZAR, "Rs.", "INR", etc.)
    - Explicit non-US shipping phrase ("ships to Chile", "envíos a todo Chile", "deliver to Australia", "EU shipping", "ships to Canada", "all India delivery", "pan India shipping", "COD available")
    - A city or country clearly outside the US named in the caption or bio (e.g. "Cairns", "Sydney", "Melbourne", "London", "Toronto", "Cape Town", "Santiago", "Chile", "Australia", "UK", "Serbia", "Turkey", "Korea", "Brazil", "India", "Delhi", "Mumbai", "Bangalore", "Pune", "Manila", "Jakarta")
    - Caption or audience wording written primarily in a non-English language (Spanish, Serbian, Turkish, Korean, French, Portuguese, Hindi, Tagalog, etc.)
    - Hashtags indicating non-US geography (#australia, #serbia, #türkiye, #chile, #uk, #southafrica, #india, #plantsofindia, #nurserylife (when paired with other India cues), etc.)
    - Phone numbers in non-US formats (+91, +63, +44, WhatsApp ordering with country codes)

  Extra caution for Competitor Activity specifically: a seller is only a real competitor if a US
  customer could plausibly buy from them. If the seller's location or shipping region cannot be
  determined AND there are weak non-US cues (spelling, phrasing, currency ambiguity), prefer
  "Mention Tracking" over "Competitor Activity".

  If ANY of the above are present → Set section_route to "Mention Tracking", processing_path to "Mention only".

  DO NOT apply this filter based on:
    - Account name or handle alone (handles don't reveal location)
    - A single foreign word that is a plant name or scientific term
    - A city name that is common in the US without other context (e.g. "Portland", "Norfolk" alone)

  section_route:
    Catalog Discovery    — US source, catalog match AND (question | problem | tip | claim | comparison | disagreement | purchase intent)
    Competitor Activity  — US source, competitor/third-party AND (giveaway | sale | launch | showcase | collaboration | promotion)
    Market Watch         — US source, not in catalog AND relevant audience interest or competitor feature
    Mention Tracking     — catalog match BUT only showcase/sentiment/lifestyle with no audience issue; OR non-US source
    Needs Catalog Review — catalog match uncertain
    Noise                — unrelated to plants/market

  A single post can produce ideas with different routes. Route each idea independently.
  Competitor Activity and Market Watch can both apply to the same idea (store the idea once, link to both).

E) Processing path (for Discovery pipeline)
  processing_path:
    Discovery eligible — catalog match + discovery-worthy content → creates/updates a cluster
    Mention only       — catalog match + mention only → updates mention tracking only
    Competitor routed  — goes to competitor_activity table, not Discovery
    Market Watch       — goes to market_watch_plants table, not Discovery
    Noise              — discard
    Needs review       — hold for human

Evidence types (for Discovery eligible): Question | Problem report | Tip | Claim | Personal experience | Disagreement | Follow-up request | Purchase intent | General mention

Return ONLY valid JSON:
{
  "relevant": true,
  "attribution": {
    "source_account_handle": "@handle or null",
    "source_account_name": "Display name or null",
    "collaborator_accounts": ["@handle"],
    "ownership_type": "Owned content | Competitor content | Community content | Customer content | Third-party media | Unknown",
    "ownership_confidence": "High | Medium | Low"
  },
  "dates": {
    "published_at": "ISO 8601 or null",
    "published_at_estimated": false,
    "observed_at": "${new Date().toISOString()}",
    "event_dates_claimed": ["July 10", "July 11"],
    "event_date_labels": ["Last day to enter", "Winner drawn live"],
    "date_confidence": "High | Medium | Low"
  },
  "ideas": [
    {
      "section_route": "Catalog Discovery | Competitor Activity | Market Watch | Mention Tracking | Needs Catalog Review | Noise",
      "processing_path": "Discovery eligible | Mention only | Competitor routed | Market Watch | Noise | Needs review",
      "signal_purpose": "one value from the list above",
      "discovery_reason": "why discovery-eligible or why not, or null",
      "normalized_cluster_title": "reusable issue in audience language, no incidental location",
      "core_issue": "the reusable question, problem, tip, or claim",
      "relevant_conditions": ["conditions that materially affect the answer"],
      "incidental_context": ["details kept as evidence only"],
      "summary": "1-2 sentence description",
      "plant": "plant or product name, or null",
      "catalog_match_status": "Catalog match | Catalog family match | Not in catalog | Needs catalog review | No plant identified",
      "matched_catalog_name": "matched SB product name or null",
      "match_confidence": "High | Medium | Low | null",
      "question": "exact question if present, or null",
      "problems": ["problem or symptom"],
      "tips": ["care tip or recommendation"],
      "audience_wording": ["exact phrases from the audience, NOT from the source account's promotional copy"],
      "source_marketing_wording": ["promotional language from the source account"],
      "evidence_type": "single best-fit evidence type, or null",
      "novelty_status": "Known recurring topic | New audience wording | New question about a known topic | New tip or claim | New contradiction | New plant connected to a known problem | Unclear",
      "revenue_priority_match": "Yes | No | Needs check",
      "relevant_conditions": ["conditions that materially affect the care answer"],
      "location_materiality": "Material | Incidental | Unclear | Not provided",
      "confidence": "High | Medium | Low"
    }
  ]
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
Title: ${extracted.normalized_cluster_title || extracted.cluster_title}
Plant: ${extracted.plant || "unknown"}
Core issue: ${extracted.core_issue || "none"}
Question: ${extracted.question || "none"}
Problems: ${(extracted.problems || []).join(", ") || "none"}
Tips: ${(extracted.tips || []).join(", ") || "none"}
Audience wording: ${(extracted.audience_wording || []).join(", ") || "none"}
Evidence type: ${extracted.evidence_type || "unknown"}

EXISTING CLUSTERS:
${clusterList}

MATCHING RULES — read carefully, two different cases:

CASE A — PLANT-SPECIFIC ISSUE (ID, cultivar behavior, species-specific care):
  Example: "Why does my Haworthia go red?", "Echeveria lilacina losing lower leaves"
  → Require SAME plant genus/species to match. Different plant = different cluster.

CASE B — GENERAL CARE ISSUE (applies broadly across plants, plant is incidental evidence):
  Example: sunburn, overwatering, root rot, etiolation, propagation failure, pest damage
  → Match by ISSUE TYPE, not by plant. If the care answer would be substantially the same regardless of plant, merge into one cluster.
  → A new sunburn signal about Echeveria runyonii should match an existing "sunburn recovery" cluster even if the existing cluster mentions Echeveria lilacina.

OTHER RULES:
- Clearly different stages of the same problem should stay separate only if the audience question or care answer is meaningfully different (e.g. "how to prevent sunburn" vs "how to recover from sunburn" = two clusters).
- If an existing cluster already covers the same issue with broader plant scope, prefer it over creating a new narrow cluster.
- If no good match exists, declare "new".
- Do NOT force a match if genuinely uncertain.

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
