/**
 * Netlify Function: run-agent
 *
 * SB Signal Flow Agent — entry point.
 *
 * Keeps new signals moving into the right queue with clear priority and evidence.
 * Does NOT publish content, approve briefs, or perform destructive actions.
 *
 * POST /.netlify/functions/run-agent
 * Body: { run_type: "manual" | "scheduled" }   (optional — inferred from auth)
 *
 * Auth:
 *   Scheduled task  → x-internal-secret header  (no user JWT needed)
 *   Manual trigger  → Authorization: Bearer <admin/owner token>
 *
 * Hard caps (safety):
 *   MAX_TOOL_CALLS  = 20   — total Claude tool_use blocks per run
 *   MAX_BATCHES     = 4    — max process_signal_batch calls per run
 *   MAX_RUNTIME_MS  = 8500 — abort before Netlify's 10s function timeout
 *
 * Outputs:
 *   run_id, status, tool_calls, batches, summary (from Claude), error
 *   Every action is logged to agent_action_log in Supabase.
 */

const { createClient }              = require("@supabase/supabase-js");
const { requireUserRole, getUserId, CORS_HEADERS } = require("./_auth");
const { TOOL_SCHEMAS, dispatchTool } = require("./_agent-tools");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

const MAX_TOOL_CALLS = 20;
const MAX_BATCHES    = 4;
const MAX_RUNTIME_MS = 8500;

// ── Action type map — used for agent_action_log.action_type ──────────────────
const ACTION_TYPE = {
  check_signal_queue:    "read",
  get_unclustered_signals: "read",
  get_stuck_signals:     "read",
  get_cluster_health:    "read",
  get_content_candidates: "read",
  process_signal_batch:  "write",
  run_maintenance_pass:  "write",
  suggest_review_move:   "suggest",
  suggest_cleanup:       "suggest",
};

// ── Which tools produce suggestions that require human review ─────────────────
const REQUIRES_REVIEW = new Set(["suggest_review_move", "suggest_cleanup"]);

// ── System prompt — tells Claude its role, constraints, and output format ─────
const SYSTEM_PROMPT = `You are the SB Signal Flow Agent for Succulents Box, a subscription plant brand.

YOUR JOB:
Keep new audience signals moving into the right queue with clear priority and evidence.
You operate on the signal flow only. You do not write briefs, scripts, or publish anything.

EACH RUN, work through these steps in order:
1. Call check_signal_queue to understand the current state.
2. If unclustered_new > 0: call process_signal_batch. Call it again if remaining > 0, but stop at the batch limit.
3. If stuck_signals exist: call run_maintenance_pass.
4. Call get_cluster_health to find clusters needing attention.
5. For clusters in pattern_detected_no_candidate: consider suggest_review_move if evidence is strong.
6. For stale or high-count-but-stuck clusters: consider suggest_cleanup if clearly problematic.
7. Call get_content_candidates so you can include the review queue depth in your summary.
8. Stop calling tools and provide your final summary.

RULES — you must follow these:
- Use only the tools provided. Never attempt actions outside them.
- suggest_review_move and suggest_cleanup create suggestions only — they do NOT change cluster status. A human reviewer must approve. Make this clear in your summary.
- Only suggest_review_move for clusters where evidence is meaningful:
    - signal_count >= 3, AND
    - distinct_source_count >= 2 OR manual_signal_count >= 1, AND
    - there is a clear repeated question or audience problem.
- Set confidence = "Low" unless evidence is clear and specific.
- Do not suggest moving a cluster if it is already in Content review ready or Closed.
- If you reach the batch limit, note remaining signals in your summary.
- Do not repeat tool calls for the same data. Read once, act, summarize.

FINAL SUMMARY FORMAT (always end with this):
Provide a plain-text summary with these sections:
- Signals processed: [number, or "none — no backlog"]
- Maintenance: [promoted X clusters / nothing to promote]
- Review suggestions queued: [list cluster titles + one-line reason, or "none"]
- Cleanup suggestions queued: [list cluster titles + one-line reason, or "none"]
- Content review queue: [X candidates waiting for human review]
- Needs human attention: [anything specific the reviewer should check first]
- Next recommended action: [one sentence]`;

// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!CLAUDE_API_KEY) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "CLAUDE_API_KEY not set" }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const internalSecret =
    event.headers["x-internal-secret"] ||
    event.headers["X-Internal-Secret"];
  const isScheduled = internalSecret && internalSecret === process.env.INTERNAL_SECRET;

  let performedBy = null;
  if (!isScheduled) {
    const authError = await requireUserRole(event, supabase, ["admin", "owner", "assistant"]);
    if (authError) return authError;
    performedBy = await getUserId(event, supabase);
  }

  const body     = JSON.parse(event.body || "{}");
  const runType  = isScheduled ? "scheduled" : "manual";
  const startedAt = Date.now();

  // ── Create run log ────────────────────────────────────────────────────────
  const { data: run, error: runErr } = await supabase
    .from("agent_run_log")
    .insert({
      run_type:     runType,
      status:       "running",
      started_at:   new Date().toISOString(),
      performed_by: performedBy,
    })
    .select()
    .single();

  if (runErr || !run) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Could not create agent run log: " + (runErr?.message || "unknown") }),
    };
  }

  const runId  = run.id;
  const context = { supabase, runId, performedBy };

  // ── Agent state ───────────────────────────────────────────────────────────
  let toolCallsCount  = 0;
  let batchCallsCount = 0;
  let hitToolLimit    = false;
  let hitTimeLimit    = false;
  let finalSummary    = null;
  let agentError      = null;

  const messages = [
    {
      role: "user",
      content:
        `Run type: ${runType}. Today is ${new Date().toISOString().slice(0, 10)}. ` +
        `Max tool calls this run: ${MAX_TOOL_CALLS}. Max batch calls: ${MAX_BATCHES}. ` +
        `Begin your run.`,
    },
  ];

  // ── Agentic loop ──────────────────────────────────────────────────────────
  try {
    while (true) {
      // Check hard caps before each Claude call
      if (toolCallsCount >= MAX_TOOL_CALLS && !hitToolLimit) {
        hitToolLimit = true;
        messages.push({
          role: "user",
          content: `You have reached the ${MAX_TOOL_CALLS}-tool-call limit. Stop calling tools and provide your final summary now.`,
        });
      }
      if (Date.now() - startedAt > MAX_RUNTIME_MS && !hitTimeLimit) {
        hitTimeLimit = true;
        messages.push({
          role: "user",
          content: "Run time limit reached. Stop calling tools and provide your final summary now.",
        });
      }

      // ── Call Claude ───────────────────────────────────────────────────────
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: 1024,
          system:     SYSTEM_PROMPT,
          tools:      TOOL_SCHEMAS,
          messages,
        }),
      });

      const claudeBody = await claudeResp.json();

      if (!claudeResp.ok) {
        throw new Error(
          "Claude API error " + claudeResp.status + ": " +
          (claudeBody?.error?.message || JSON.stringify(claudeBody).slice(0, 200))
        );
      }

      // Add assistant turn to message history
      messages.push({ role: "assistant", content: claudeBody.content });

      // ── Stop condition: Claude finished ───────────────────────────────────
      if (claudeBody.stop_reason === "end_turn") {
        const textBlock = (claudeBody.content || []).find(b => b.type === "text");
        finalSummary = textBlock?.text || "Run complete.";
        break;
      }

      // ── Stop condition: no more tool calls expected ────────────────────────
      if (claudeBody.stop_reason !== "tool_use") break;

      // ── Process tool calls ────────────────────────────────────────────────
      const toolUseBlocks = (claudeBody.content || []).filter(b => b.type === "tool_use");
      const toolResults   = [];

      for (const toolUse of toolUseBlocks) {
        toolCallsCount++;

        const toolName  = toolUse.name;
        const toolInput = toolUse.input || {};

        // Enforce batch cap
        if (toolName === "process_signal_batch") {
          if (batchCallsCount >= MAX_BATCHES) {
            const skippedOutput = {
              error: `Batch limit (${MAX_BATCHES}) reached. This call was skipped. Note remaining signals in your summary.`,
            };
            await _logAction(runId, toolName, toolInput, skippedOutput, "skipped", false);
            toolResults.push({
              type:        "tool_result",
              tool_use_id: toolUse.id,
              content:     JSON.stringify(skippedOutput),
            });
            continue;
          }
          batchCallsCount++;
        }

        // ── Dispatch the tool ─────────────────────────────────────────────
        let toolOutput, toolStatus;
        try {
          toolOutput = await dispatchTool(toolName, toolInput, context);
          toolStatus = "success";
        } catch (err) {
          toolOutput = { error: err.message };
          toolStatus = "error";
          console.error(`Tool "${toolName}" failed:`, err.message);
        }

        const needsReview = REQUIRES_REVIEW.has(toolName);
        await _logAction(runId, toolName, toolInput, toolOutput, toolStatus, needsReview);

        toolResults.push({
          type:        "tool_result",
          tool_use_id: toolUse.id,
          content:     JSON.stringify(toolOutput),
        });
      }

      // Append tool results as a user turn
      messages.push({ role: "user", content: toolResults });

      // Safety: if we've been going long, force stop on next iteration
      if (toolCallsCount >= MAX_TOOL_CALLS || Date.now() - startedAt > MAX_RUNTIME_MS) {
        // Limits already injected above — loop once more to let Claude summarize
      }
    }

  } catch (err) {
    agentError = err.message;
    console.error("Agent run failed:", err);
  }

  // ── Finalize run log ──────────────────────────────────────────────────────
  const finalStatus = agentError
    ? "failed"
    : (hitTimeLimit ? "timeout" : "completed");

  await supabase.from("agent_run_log").update({
    status:            finalStatus,
    completed_at:      new Date().toISOString(),
    summary:           finalSummary ? { text: finalSummary } : null,
    error:             agentError   || null,
    tool_calls_count:  toolCallsCount,
    batch_calls_count: batchCallsCount,
  }).eq("id", runId);

  return {
    statusCode: 200,
    headers:    CORS_HEADERS,
    body: JSON.stringify({
      run_id:      runId,
      status:      finalStatus,
      tool_calls:  toolCallsCount,
      batches:     batchCallsCount,
      summary:     finalSummary,
      error:       agentError || undefined,
    }),
  };
};

// ── Helper: log a single tool action ─────────────────────────────────────────
async function _logAction(runId, toolName, input, output, status, requiresHumanReview) {
  // Extract target_id from suggest_ calls (cluster_id in input)
  const targetId = input?.cluster_id || null;

  await supabase.from("agent_action_log").insert({
    run_id:               runId,
    tool_name:            toolName,
    action_type:          ACTION_TYPE[toolName] || "read",
    target_table:         REQUIRES_REVIEW.has(toolName) ? "cluster_review_suggestions" :
                          toolName === "run_maintenance_pass" ? "discovery_clusters" :
                          null,
    target_id:            targetId || undefined,
    input:                input,
    output:               output,
    status:               status,
    requires_human_review: requiresHumanReview,
    created_at:           new Date().toISOString(),
  });
}
