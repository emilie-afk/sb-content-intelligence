/**
 * Netlify Function: run-agent
 *
 * SB Signal Flow Agent — entry point.
 *
 * Keeps new signals moving into the right queue with clear priority and evidence.
 * Does NOT publish content, approve briefs, or perform destructive actions.
 *
 * POST /.netlify/functions/run-agent
 * Body: { run_type: "manual" | "scheduled" }   (ignored — the run type comes from the credential)
 *
 * Auth:
 *   Scheduled task  → scheduler credential (GitHub Actions) or internal credential
 *   Manual trigger  → approved owner / admin / assistant session
 *   One run at a time (durable lock).
 *
 * Limits, enforced in code (not left to the model):
 *   MAX_TOOL_CALLS = 20    tool executions per run (checked before every dispatch)
 *   MAX_BATCHES    = 4     process_signal_batch calls per run
 *   Run deadline   = 8.5 s from the start of the request (absolute). It is propagated as
 *                    an AbortSignal into every model call, internal HTTP call and database
 *                    operation of the run, so in-flight work is cancelled AT the deadline.
 *                    No model call starts with < 1.5 s left, no tool with < 0.25 s left.
 *   Finalisation   one shared 1.2 s budget (its own AbortSignal) for the queued action logs,
 *                    the run-log outcome and the lock release → at most ≈ 9.7 s in total.
 *   Deadline expiry → status "timeout", limit "time", deterministic partial summary.
 *   A provider failure before the deadline → status "failed".
 *   If the platform still kills the invocation: the lock expires after 2 minutes and the
 *   next run marks the abandoned "running" log row as "timeout".
 *
 * Note: cancelling a request cannot undo work a downstream function already accepted
 * (e.g. batch-cluster claims); those paths keep their own claims/locks/idempotency.
 */

const prompts = require("../lib/prompts");
const { preflightOrMethod, errorResponse, baseHeaders } = require("../lib/http");
const { requireUserOrService, ROLES } = require("../lib/auth");
const { lazyService, boundClient } = require("../lib/supabase");
const locks = require("../lib/locks");
const claude = require("../lib/claude");
const { createDeadline, isDeadlineError, DeadlineError } = require("../lib/deadline");
const { TOOL_SCHEMAS, dispatchTool } = require("../lib/agent-tools");

const supabase = lazyService;
const CORS_HEADERS = baseHeaders();

const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

const MAX_TOOL_CALLS = 20;
const MAX_BATCHES    = 4;
const MAX_RUNTIME_MS = 8500;
const FINALIZE_MS    = 1200;
const MIN_MODEL_MS   = 1500;
const MIN_TOOL_MS    = 250;
const LOCK_TTL_S     = 120;   // a run can't legitimately outlive this
const STALE_RUN_MS   = 2 * 60 * 1000;

// Tests may shorten (never lengthen) the budget to keep real-timer tests quick.
function runtimeBudget() {
  const v = Number(process.env.AGENT_RUNTIME_MS);
  return Number.isFinite(v) && v >= 1000 && v < MAX_RUNTIME_MS ? v : MAX_RUNTIME_MS;
}

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

// ── System prompt (private, versioned) ────────────────────────────────────────
const SYSTEM_PROMPT = () => prompts.t("run-agent.SYSTEM_PROMPT.1");

// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const deadline = createDeadline(runtimeBudget()); // absolute: counts from request start
  const finish = { fin: null };   // ONE finalisation budget shared by run log + lock release
  let caller, lockHolder, promptSet;
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) { deadline.dispose(); return early; }
    caller = await requireUserOrService(event, { roles: ROLES.WRITERS, scopes: ["scheduler", "internal"], bucket: "ai_batch" });
    if (!process.env.CLAUDE_API_KEY) { deadline.dispose(); return { statusCode: 503, headers: CORS_HEADERS, body: JSON.stringify({ error: "AI is not configured on the server" }) }; }
    promptSet = await prompts.loadPromptSet(supabase);
    lockHolder = await locks.acquire("agent_run", LOCK_TTL_S, "The agent is already running. Try again in a few minutes.");
  } catch (err) {
    deadline.dispose();
    return errorResponse(err, "run-agent");
  }
  try {
    return await prompts.runWithPrompts(promptSet, () => runAgent(caller, deadline, finish));
  } catch (err) {
    return errorResponse(err, "run-agent");
  } finally {
    deadline.dispose();
    const fin = finish.fin || createDeadline(FINALIZE_MS);
    await locks.release("agent_run", lockHolder, { client: boundClient(fin.signal) });
    fin.dispose();
  }
};

async function runAgent(caller, deadline, finish = {}) {
  const isScheduled = caller.kind === "service";
  const performedBy = caller.kind === "user" ? caller.userId : null;
  const runType  = isScheduled ? "scheduled" : "manual";

  // Every database operation of the run is cancelled at the deadline.
  const db = boundClient(deadline.signal);

  // Recover runs the platform killed before they could record an outcome.
  // (bounded to 0.5 s so a slow clean-up never eats the run's budget)
  try {
    await boundClient(deadline.child(500)).from("agent_run_log")
      .update({ status: "timeout", completed_at: new Date().toISOString(), error: "run did not finish (stopped by the platform)" })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
  } catch (_) { /* best effort */ }

  // ── Create run log ────────────────────────────────────────────────────────
  let run = null;
  try {
    const { data, error } = await db.from("agent_run_log")
      .insert({ run_type: runType, status: "running", started_at: new Date().toISOString(), performed_by: performedBy })
      .select()
      .single();
    if (!error) run = data;
  } catch (_) { /* handled below */ }
  if (!run) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Could not create the agent run log" }) };
  }

  const runId  = run.id;
  const context = { supabase: db, runId, performedBy, promptVersion: prompts.currentVersionId(), signal: deadline.signal };
  const pendingLogs = [];   // action logs that could not be written before the deadline

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

  const callModel = (extra = {}) => claude.messages({
    model:      CLAUDE_MODEL,
    max_tokens: 1024,
    system:     SYSTEM_PROMPT(),
    tools:      TOOL_SCHEMAS,
    messages,
    ...extra,
  }, { signal: deadline.signal });   // the run deadline is the ONLY timer for agent model calls

  const logAction = async (toolName, input, output, status, needsReview) => {
    const row = actionRow(runId, toolName, input, output, status, needsReview);
    if (deadline.expired()) { pendingLogs.push(row); return; }
    try {
      const { error } = await db.from("agent_action_log").insert(row);
      if (error) pendingLogs.push(row);
    } catch (_) { pendingLogs.push(row); }
  };

  // ── Agentic loop ──────────────────────────────────────────────────────────
  try {
    for (let turn = 0; turn <= MAX_TOOL_CALLS + 1; turn++) {
      if (deadline.remaining() < MIN_MODEL_MS) { hitTimeLimit = true; break; }
      if (toolCallsCount >= MAX_TOOL_CALLS) { hitToolLimit = true; break; }

      const claudeBody = await callModel();
      messages.push({ role: "assistant", content: claudeBody.content });

      if (claudeBody.stop_reason === "end_turn") {
        const textBlock = (claudeBody.content || []).find(b => b.type === "text");
        finalSummary = textBlock?.text || "Run complete.";
        break;
      }
      if (claudeBody.stop_reason !== "tool_use") break;

      const toolUseBlocks = (claudeBody.content || []).filter(b => b.type === "tool_use");
      const toolResults   = [];

      for (const toolUse of toolUseBlocks) {
        const toolName  = toolUse.name;
        const toolInput = toolUse.input || {};

        // Hard caps — checked before each dispatch
        let skipReason = null;
        if (toolCallsCount >= MAX_TOOL_CALLS) { hitToolLimit = true; skipReason = `Tool-call limit (${MAX_TOOL_CALLS}) reached.`; }
        else if (deadline.remaining() < MIN_TOOL_MS) { hitTimeLimit = true; skipReason = "Run time limit reached."; }
        else if (toolName === "process_signal_batch" && batchCallsCount >= MAX_BATCHES) {
          skipReason = `Batch limit (${MAX_BATCHES}) reached. This call was skipped. Note remaining signals in your summary.`;
        }
        if (skipReason) {
          const skippedOutput = { error: skipReason };
          await logAction(toolName, toolInput, skippedOutput, "skipped", false);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(skippedOutput) });
          continue;
        }

        toolCallsCount++;
        if (toolName === "process_signal_batch") batchCallsCount++;

        let toolOutput, toolStatus;
        try {
          toolOutput = await dispatchTool(toolName, toolInput, context);
          if (deadline.expired()) throw deadline.signal.reason || new DeadlineError();
          toolStatus = "success";
        } catch (err) {
          if (isDeadlineError(err, deadline.signal) || deadline.expired()) {
            hitTimeLimit = true;
            toolOutput = { error: "Cancelled at the run deadline" };
            toolStatus = "error";
          } else {
            toolOutput = { error: err.message };
            toolStatus = "error";
            console.error(`Tool "${toolName}" failed`);
          }
        }

        await logAction(toolName, toolInput, toolOutput, toolStatus, REQUIRES_REVIEW.has(toolName));
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(toolOutput) });
        if (hitTimeLimit) break;
      }

      messages.push({ role: "user", content: toolResults });
      if (hitToolLimit || hitTimeLimit) break;
    }

    // One bounded, tool-free summary after the tool-call limit, only with time to spare.
    if (!finalSummary && hitToolLimit && !hitTimeLimit && deadline.remaining() >= MIN_MODEL_MS) {
      messages.push({ role: "user", content: `You have reached the ${MAX_TOOL_CALLS}-tool-call limit. Do not call tools. Provide your final summary now.` });
      try {
        const last = await callModel({ tool_choice: { type: "none" } });
        const textBlock = (last.content || []).find(b => b.type === "text");
        finalSummary = textBlock?.text || null;
      } catch (err) {
        if (isDeadlineError(err, deadline.signal) || deadline.expired()) hitTimeLimit = true;
      }
    }
  } catch (err) {
    if (isDeadlineError(err, deadline.signal) || deadline.expired()) {
      hitTimeLimit = true;                 // deadline expiry is a timeout, not a provider failure
    } else {
      // stored in agent_run_log: keep it generic (no provider payloads)
      agentError = err && err.isPublic ? err.message : "Agent run failed (internal error)";
      console.error("Agent run failed:", err && err.isPublic ? err.message : "internal error");
    }
  }

  if (!finalSummary && (hitTimeLimit || hitToolLimit)) {
    const why = hitTimeLimit ? "the run time limit" : `the ${MAX_TOOL_CALLS}-tool-call limit`;
    finalSummary = `Stopped at ${why} after ${toolCallsCount} tool call(s) and ${batchCallsCount} batch call(s). Check the action log for details.`;
  }

  const finalStatus = agentError ? "failed" : (hitTimeLimit ? "timeout" : "completed");
  const limit = hitTimeLimit ? "time" : hitToolLimit ? "tool_calls" : undefined;

  // ── Finalize (bounded, independent of the expired run deadline) ───────────
  const fin = finish.fin = createDeadline(FINALIZE_MS);
  const fdb = boundClient(fin.signal);
  try {
    if (pendingLogs.length) await fdb.from("agent_action_log").insert(pendingLogs);
  } catch (_) { /* best effort */ }
  try {
    await fdb.from("agent_run_log").update({
      status:            finalStatus,
      completed_at:      new Date().toISOString(),
      summary:           finalSummary ? { text: finalSummary } : null,
      error:             agentError || (hitTimeLimit ? "stopped at time limit" : hitToolLimit ? "stopped at tool-call limit" : null),
      tool_calls_count:  toolCallsCount,
      batch_calls_count: batchCallsCount,
    }).eq("id", runId);
  } catch (_) {
    console.error("run-agent: could not record the run outcome (a later run marks it timed out)");
  }

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
      limit,
    }),
  };
}

// ── Helper: one agent_action_log row ─────────────────────────────────────────
function actionRow(runId, toolName, input, output, status, requiresHumanReview) {
  const targetId = input?.cluster_id || null;
  return {
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
  };
}
