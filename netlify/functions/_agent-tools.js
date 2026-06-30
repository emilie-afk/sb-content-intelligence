/**
 * _agent-tools.js
 *
 * Defines the allowlisted tools available to the SB Signal Flow Agent.
 *
 * Claude's tool_use API picks from TOOL_SCHEMAS.
 * run-agent.js dispatches via dispatchTool() — only tools in ALLOWED_TOOLS execute.
 *
 * Tool categories
 *   READ   — Supabase queries only, no writes
 *   WRITE  — safe, non-destructive writes (suggestions + logs only)
 *   BLOCKED — never callable by agent (not in ALLOWED_TOOLS)
 *             examples: ai-cleanup-batch, merge-clusters, push-to-calendar
 */

const NETLIFY_URL    = process.env.URL || "https://sb-content-intelligence.netlify.app";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

// ─────────────────────────────────────────────────────────────────────────────
// TOOL SCHEMAS — sent to Claude as the tools[] array in the messages API
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = [

  // ── READ ──────────────────────────────────────────────────────────────────

  {
    name: "check_signal_queue",
    description:
      "Returns a snapshot of the current signal queue: counts by status, " +
      "how many New signals are unclustered (not yet routed into any cluster), " +
      "and whether a processing backlog exists. Call this first at the start of every run.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "get_unclustered_signals",
    description:
      "Returns New signals that have no cluster link yet, ordered manual-first then oldest-first. " +
      "Use to understand the backlog before calling process_signal_batch.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max signals to return. Default 20, max 50.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_stuck_signals",
    description:
      "Returns signals that are linked to a cluster but still have status 'New' instead of 'Analyzed'. " +
      "These are stuck and can usually be fixed by running the maintenance pass.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "get_cluster_health",
    description:
      "Returns clusters that need attention: stale (no new signals in N days), " +
      "high signal count but still Collecting (not yet promoted), " +
      "or in a terminal state that looks wrong. " +
      "Use to decide what needs a maintenance pass or a review suggestion.",
    input_schema: {
      type: "object",
      properties: {
        stale_days: {
          type: "number",
          description: "Flag clusters with no new signals in this many days. Default 14.",
        },
        limit: {
          type: "number",
          description: "Max clusters per category to return. Default 15.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_content_candidates",
    description:
      "Returns content_review_candidates that are ready for human review, " +
      "with their cluster context. Use to assess review queue depth before suggesting moves.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          description: "Filter by candidate status, e.g. 'Ready for review'. Default: all non-dismissed.",
        },
        limit: {
          type: "number",
          description: "Max candidates to return. Default 10.",
        },
      },
      required: [],
    },
  },

  // ── WRITE (non-destructive) ───────────────────────────────────────────────

  {
    name: "process_signal_batch",
    description:
      "Runs one batch of unclustered signals through AI analysis and cluster routing " +
      "by calling the batch-cluster function. Returns { processed, errors, remaining }. " +
      "Call again if remaining > 0, but you will be stopped at the run's batch limit. " +
      "Do not call if check_signal_queue shows unclustered_new = 0.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "run_maintenance_pass",
    description:
      "Runs the fast DB-only qualification pass: promotes clusters from Collecting " +
      "to Pattern detected when they meet signal thresholds. No Claude calls inside — fast. " +
      "Run once after processing signals or whenever stuck signals are found.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "suggest_review_move",
    description:
      "Creates a non-destructive suggestion in cluster_review_suggestions for a human reviewer " +
      "to consider moving a cluster to Content Review. " +
      "Does NOT change the cluster's status — human must approve. " +
      "Only suggest when: signal_count >= 3, distinct_source_count >= 2 OR is_manual_submission present, " +
      "and the cluster has a clear audience problem or question.",
    input_schema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "UUID of the cluster to suggest moving.",
        },
        cluster_title: {
          type: "string",
          description: "Title of the cluster (for logging context).",
        },
        reason: {
          type: "string",
          description: "Why this cluster looks ready for Content Review. Be specific about evidence.",
        },
        confidence: {
          type: "string",
          enum: ["High", "Medium", "Low"],
          description: "Agent's confidence in the suggestion.",
        },
        evidence_preview: {
          type: "string",
          description: "Brief evidence summary: signal count, sources, example wording.",
        },
      },
      required: ["cluster_id", "cluster_title", "reason", "confidence"],
    },
  },

  {
    name: "suggest_cleanup",
    description:
      "Flags a cluster for human cleanup review in cluster_review_suggestions. " +
      "Does NOT close, block, merge, or modify the cluster — human decides. " +
      "Use for clusters that look noisy, irrelevant, too vague, or duplicate of another.",
    input_schema: {
      type: "object",
      properties: {
        cluster_id: {
          type: "string",
          description: "UUID of the cluster to flag.",
        },
        cluster_title: {
          type: "string",
          description: "Title of the cluster (for logging context).",
        },
        reason: {
          type: "string",
          description: "Why this cluster looks noisy, weak, or irrelevant.",
        },
        suggested_action: {
          type: "string",
          enum: ["dismiss", "merge", "reroute", "needs_research"],
          description: "What the agent thinks should happen. Human decides.",
        },
        confidence: {
          type: "string",
          enum: ["High", "Medium", "Low"],
        },
      },
      required: ["cluster_id", "cluster_title", "reason", "suggested_action", "confidence"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED TOOLS — only these names can be dispatched; everything else is blocked
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = new Set([
  "check_signal_queue",
  "get_unclustered_signals",
  "get_stuck_signals",
  "get_cluster_health",
  "get_content_candidates",
  "process_signal_batch",
  "run_maintenance_pass",
  "suggest_review_move",
  "suggest_cleanup",
]);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// Each receives (context, input) where:
//   context = { supabase, runId, performedBy }
//   input   = Claude's tool input object (validated by schema)
// ─────────────────────────────────────────────────────────────────────────────

// ── READ ─────────────────────────────────────────────────────────────────────

async function check_signal_queue({ supabase }) {
  // Signal counts by status
  const { data: signals } = await supabase
    .from("signals")
    .select("status")
    .neq("status", "Archived");

  const counts = {};
  for (const row of signals || []) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }

  // Unclustered = New signals with no entry in signal_cluster_links
  const { data: linked } = await supabase
    .from("signal_cluster_links")
    .select("signal_id");
  const linkedIds = (linked || []).map(l => l.signal_id);

  let unclusteredCount = 0;
  if ((counts["New"] || 0) > 0) {
    let q = supabase.from("signals").select("id", { count: "exact", head: true }).eq("status", "New");
    if (linkedIds.length) {
      q = q.not("id", "in", `(${linkedIds.map(id => `'${id}'`).join(",")})`);
    }
    const { count } = await q;
    unclusteredCount = count || 0;
  }

  // Cluster counts by status
  const { data: clusters } = await supabase
    .from("discovery_clusters")
    .select("status")
    .not("status", "in", '("Closed","Blocked irrelevant")');

  const clusterCounts = {};
  for (const row of clusters || []) {
    clusterCounts[row.status] = (clusterCounts[row.status] || 0) + 1;
  }

  return {
    signal_counts_by_status: counts,
    unclustered_new: unclusteredCount,
    has_backlog: unclusteredCount > 0,
    cluster_counts_by_status: clusterCounts,
    total_active_signals: (signals || []).length,
  };
}

async function get_unclustered_signals({ supabase }, { limit = 20 }) {
  const safeLimit = Math.min(limit, 50);

  const { data: linked } = await supabase
    .from("signal_cluster_links")
    .select("signal_id");
  const linkedIds = (linked || []).map(l => l.signal_id);

  let query = supabase
    .from("signals")
    .select("id, content, platform, source_url, priority, is_manual_submission, created_at")
    .eq("status", "New")
    .order("is_manual_submission", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(safeLimit);

  if (linkedIds.length) {
    query = query.not("id", "in", `(${linkedIds.map(id => `'${id}'`).join(",")})`);
  }

  const { data } = await query;
  return {
    signals: (data || []).map(s => ({
      id: s.id,
      platform: s.platform,
      is_manual: s.is_manual_submission,
      priority: s.priority,
      content_preview: (s.content || "").slice(0, 120),
      created_at: s.created_at,
    })),
    count: (data || []).length,
  };
}

async function get_stuck_signals({ supabase }) {
  // Signals linked to a cluster but still status = New
  const { data: linked } = await supabase
    .from("signal_cluster_links")
    .select("signal_id");
  const linkedIds = (linked || []).map(l => l.signal_id);

  if (!linkedIds.length) return { stuck_signals: [], count: 0 };

  const { data } = await supabase
    .from("signals")
    .select("id, platform, priority, created_at")
    .eq("status", "New")
    .in("id", linkedIds)
    .limit(50);

  return { stuck_signals: data || [], count: (data || []).length };
}

async function get_cluster_health({ supabase }, { stale_days = 14, limit = 15 }) {
  const safeLimit = Math.min(limit, 30);
  const staleDate = new Date(Date.now() - stale_days * 86400_000).toISOString();

  const [staleResult, highCountResult, patternReadyResult] = await Promise.all([
    // Stale: no new signals in N days, still active
    supabase
      .from("discovery_clusters")
      .select("id, title, status, signal_count, last_seen_at")
      .in("status", ["Collecting", "Pattern detected"])
      .lt("last_seen_at", staleDate)
      .order("signal_count", { ascending: false })
      .limit(safeLimit),

    // High count but still Collecting (should have been promoted)
    supabase
      .from("discovery_clusters")
      .select("id, title, status, signal_count, distinct_source_count, question_count")
      .eq("status", "Collecting")
      .gte("signal_count", 4)
      .order("signal_count", { ascending: false })
      .limit(safeLimit),

    // Pattern detected but no content candidate yet (may be ready to suggest)
    supabase
      .from("discovery_clusters")
      .select("id, title, status, signal_count, distinct_source_count, question_count, manual_signal_count")
      .eq("status", "Pattern detected")
      .order("signal_count", { ascending: false })
      .limit(safeLimit),
  ]);

  return {
    stale_clusters:          staleResult.data || [],
    high_count_collecting:   highCountResult.data || [],
    pattern_detected_no_candidate: patternReadyResult.data || [],
    stale_threshold_days:    stale_days,
  };
}

async function get_content_candidates({ supabase }, { status_filter, limit = 10 }) {
  const safeLimit = Math.min(limit, 25);

  let query = supabase
    .from("content_review_candidates")
    .select("id, cluster_id, title, status, signal_count, question_count, distinct_source_count, repetition_risk, surfaced_reason, created_at")
    .not("status", "in", '("Dismissed","Already covered")')
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (status_filter) query = query.eq("status", status_filter);

  const { data } = await query;
  return { candidates: data || [], count: (data || []).length };
}

// ── WRITE (non-destructive) ───────────────────────────────────────────────────

async function process_signal_batch({ runId }) {
  const resp = await fetch(
    `${NETLIFY_URL}/.netlify/functions/batch-cluster`,
    {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ agent_run_id: runId }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`batch-cluster returned ${resp.status}: ${text.slice(0, 200)}`);
  }
  const result = await resp.json();
  return {
    processed: result.processed || 0,
    errors:    result.errors    || 0,
    remaining: result.remaining || 0,
  };
}

async function run_maintenance_pass({ runId }) {
  const resp = await fetch(
    `${NETLIFY_URL}/.netlify/functions/maintenance-run`,
    {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ limit: 100, agent_run_id: runId }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`maintenance-run returned ${resp.status}: ${text.slice(0, 200)}`);
  }
  const result = await resp.json();
  return {
    promoted:           result.promoted           || 0,
    candidates_created: result.candidates_created || 0,
  };
}

async function suggest_review_move(
  { supabase },
  { cluster_id, cluster_title, reason, confidence, evidence_preview }
) {
  const { error } = await supabase.from("cluster_review_suggestions").insert({
    cluster_id,
    suggestion_type:       "Content Review",
    reason:                `[Agent] ${reason}`,
    confidence,
    evidence_preview:      evidence_preview || null,
    review_status:         "Pending",
    created_at:            new Date().toISOString(),
  });
  if (error) throw new Error("suggest_review_move insert failed: " + error.message);
  return { queued: true, cluster_id, cluster_title, suggestion_type: "Content Review" };
}

async function suggest_cleanup(
  { supabase },
  { cluster_id, cluster_title, reason, suggested_action, confidence }
) {
  const typeMap = {
    dismiss:        "Dismiss",
    merge:          "Merge",
    reroute:        "Reroute",
    needs_research: "Needs research",
  };
  const { error } = await supabase.from("cluster_review_suggestions").insert({
    cluster_id,
    suggestion_type:       typeMap[suggested_action] || "Reroute",
    reason:                `[Agent cleanup] ${reason}`,
    confidence,
    review_status:         "Pending",
    created_at:            new Date().toISOString(),
  });
  if (error) throw new Error("suggest_cleanup insert failed: " + error.message);
  return { flagged: true, cluster_id, cluster_title, suggested_action };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH — validates allowlist, routes to implementation
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_IMPLEMENTATIONS = {
  check_signal_queue,
  get_unclustered_signals,
  get_stuck_signals,
  get_cluster_health,
  get_content_candidates,
  process_signal_batch,
  run_maintenance_pass,
  suggest_review_move,
  suggest_cleanup,
};

/**
 * @param {string} toolName
 * @param {object} input      — Claude's tool input (already validated by schema)
 * @param {object} context    — { supabase, runId, performedBy }
 * @returns {Promise<object>} — tool result (will be JSON-stringified for Claude)
 */
async function dispatchTool(toolName, input, context) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    // Security: reject anything not explicitly allowlisted
    throw new Error(
      `Tool "${toolName}" is not in the agent allowlist. ` +
      `Allowed tools: ${[...ALLOWED_TOOLS].join(", ")}`
    );
  }
  const impl = TOOL_IMPLEMENTATIONS[toolName];
  if (!impl) {
    throw new Error(`Tool "${toolName}" has no implementation (this is a bug).`);
  }
  return impl(context, input || {});
}

module.exports = { TOOL_SCHEMAS, ALLOWED_TOOLS, dispatchTool };
