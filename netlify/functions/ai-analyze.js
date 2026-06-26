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
const { requireUserRole } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "extract-v2";

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type, Authorization",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  // Internal calls from batch-cluster / submit-signal pass a shared secret instead of a user token
  const internalSecret = event.headers["x-internal-secret"] || event.headers["X-Internal-Secret"];
  if (!internalSecret || internalSecret !== process.env.INTERNAL_SECRET) {
    const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
    if (authError) return authError;
  }

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

      // Step 1: Extract one or more distinct ideas + relevance check
      const extractPrompt = buildExtractionPrompt(data);
      const extracted = await callClaude(extractPrompt);

      // If AI says signal is not relevant to plants/succulents, mark as Noise and stop
      if (extracted.relevant === false) {
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

      // Step 3: Process each extracted idea independently
      const clusterResults = [];

      for (const idea of ideas) {
        const route = idea.section_route || "";

        // ── COMPETITOR ACTIVITY routing ────────────────────────────────────────
        if (route === "Competitor Activity" || idea.processing_path === "Competitor routed") {
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
          // Flag signal for human review; don't cluster
          await supabase.from("signals").update({ status: "Needs cleanup" }).eq("id", signalId);
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
            cluster_id:    clusterId,
            field_changed: "signal_count",
            previous_value: String(cluster.signal_count || 0),
            new_value:      String(newSignalCount),
            reason:         aiUpdateSummary,
            trigger:        "new_signal",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
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
            cluster_id:    clusterId,
            field_changed: "status",
            previous_value: null,
            new_value:      "Collecting",
            reason:         "New cluster auto-created from signal " + signalId,
            trigger:        "new_signal",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
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
            cluster_id:     clusterId,
            field_changed:  "status",
            previous_value: "Collecting",
            new_value:      "Pattern detected",
            reason:         qualifies.reason,
            trigger:        "new_signal",
            ai_model:       CLAUDE_MODEL,
            prompt_version: PROMPT_VERSION,
            is_automatic:   true,
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
              cluster_id:     clusterId,
              field_changed:  "status",
              previous_value: cluster.status,
              new_value:      "Content review ready",
              reason:         qualifies.reason,
              trigger:        "new_signal",
              ai_model:       CLAUDE_MODEL,
              prompt_version: PROMPT_VERSION,
              is_automatic:   true,
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
    // If clustering failed, mark the signal so it doesn't stay stuck as New forever
    if (type === "cluster" && data?.id) {
      try {
        await supabase.from("signals")
          .update({ status: "Needs cleanup" })
          .eq("id", data.id)
          .eq("status", "New");  // only update if still New — don't overwrite manual decisions
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
    - Non-US currency (£, €, AUS$, NZ$, CAD$, R for ZAR, etc.)
    - Explicit non-US shipping phrase ("ships to Chile", "envíos a todo Chile", "deliver to Australia", "EU shipping", "ships to Canada")
    - A city or country clearly outside the US named in the caption or bio (e.g. "Cairns", "Sydney", "Melbourne", "London", "Toronto", "Cape Town", "Santiago", "Chile", "Australia", "UK", "Serbia", "Turkey", "Korea", "Brazil")
    - Caption or audience wording written primarily in a non-English language (Spanish, Serbian, Turkish, Korean, French, Portuguese, etc.)
    - Hashtags indicating non-US geography (#australia, #serbia, #türkiye, #chile, #uk, #southafrica, etc.)

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
