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
 *   Scheduled task  → scheduler credential (GitHub Actions) or internal credential
 *   Manual trigger  → approved owner / admin / assistant session
 *   One run at a time (durable lock); the run type comes from the credential,
 *   never from the request body.
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

const prompts = require("../lib/prompts");
const { preflightOrMethod, errorResponse, baseHeaders } = require("../lib/http");
const { requireUserOrService, ROLES } = require("../lib/auth");
const { lazyService } = require("../lib/supabase");
const locks = require("../lib/locks");
const claude = require("../lib/claude");
const { TOOL_SCHEMAS, dispatchTool } = require("../lib/agent-tools");

const supabase = lazyService;
const CORS_HEADERS = baseHeaders();

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
const SYSTEM_PROMPT = () => prompts.t("run-agent.SYSTEM_PROMPT.1");

// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  let caller, lockHolder, promptSet;
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    caller = await requireUserOrService(event, { roles: ROLES.WRITERS, scopes: ["scheduler", "internal"], bucket: "ai_batch" });
    if (!process.env.CLAUDE_API_KEY) return { statusCode: 503, headers: CORS_HEADERS, body: JSON.stringify({ error: "AI is not configured on the server" }) };
    promptSet = await prompts.loadPromptSet(supabase);
    lockHolder = await locks.acquire("agent_run", 10 * 60, "The agent is already running. Try again in a few minutes.");
  } catch (err) {
    return errorResponse(err, "run-agent");
  }
  try {
    return await prompts.runWithPrompts(promptSet, () => runAgent(caller));
  } catch (err) {
    return errorResponse(err, "run-agent");
  } finally {
    await locks.release("agent_run", lockHolder);
  }
};

async function runAgent(caller) {
  const isScheduled = caller.kind === "service";
  const performedBy = caller.kind === "user" ? caller.userId : null;
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
      body: JSON.stringify({ error: "Could not create the agent run log" }),
    };
  }

  const runId  = run.id;
  const context = { supabase, runId, performedBy, promptVersion: promptSetId() };

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
      const claudeBody = await claude.messages({
        model:      CLAUDE_MODEL,
        max_tokens: 1024,
        system:     SYSTEM_PROMPT(),
        tools:      TOOL_SCHEMAS,
        messages,
      });

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
    // stored in agent_run_log: keep it generic (no provider payloads)
    agentError = err && err.isPublic ? err.message : "Agent run failed (internal error)";
    console.error("Agent run failed:", err && err.isPublic ? err.message : "internal error");
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
}

function promptSetId() { return prompts.currentVersionId(); }

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
