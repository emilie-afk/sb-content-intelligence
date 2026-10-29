/**
 * Netlify Function: write-to-sheet
 *
 * Sends one APPROVED script to the script Google Sheet (current month tab) via
 * the Apps Script web app. The sheet location and the shared secret stay on the
 * server.
 *
 * POST { script_id }
 * Auth: approved owner / admin / assistant session.
 *
 * Retry-safe: a durable lock prevents parallel sends, the script row records when it
 * was exported, and the Apps Script reserves the target row in its _exports ledger
 * before writing, refills that same row on a retry and refuses a completed export id.
 * Retries and double clicks therefore never add a second row (failure-injection tested).
 */
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireUser, ROLES } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");
const { withLock } = require("../lib/locks");
const { callAppsScript } = require("../lib/sources");
const { uuid } = require("../lib/validate");

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    await requireUser(event, { roles: ROLES.WRITERS, bucket: "sheet" });

    const body = parseBody(event, { maxBytes: 4 * 1024, allowEmpty: false });
    const scriptId = uuid(body.script_id, "script_id");
    const sb = serviceClient();

    return await withLock(`sheet_export:${scriptId}`, 120, async () => {
      const { data: script, error } = await sb.from("script_outputs").select("*").eq("id", scriptId).maybeSingle();
      if (error) throw new PublicError(503, "Could not load the script");
      if (!script) throw new PublicError(404, "Script not found");
      if (script.review_status !== "Approved") throw new PublicError(400, "Only Approved scripts can be sent to the sheet");

      if (script.sheet_exported_at) {
        return json(200, { success: true, already_exported: true, ...placement(script.sheet_export_ref) });
      }

      // Hook first, CTA last (unchanged formatting rules)
      let scriptText = script.full_voiceover_script || "";
      if (script.opening_hook && !scriptText.trimStart().startsWith(script.opening_hook)) {
        scriptText = script.opening_hook + " " + scriptText;
      }
      if (script.cta && !scriptText.includes(script.cta)) {
        scriptText = scriptText.trimEnd() + "\n\n" + script.cta;
      }

      const result = await callAppsScript(sb, "append", {
        export_id:       script.id,
        title:           script.script_title || "",
        thumbnail_title: script.thumbnail_title || script.opening_hook || "",
        script_text:     scriptText,
        caption:         script.caption || "",
        platform:        script.platform || "",
      });

      const ref = String(result.placed || "").slice(0, 100);
      const { error: updErr } = await sb.from("script_outputs")
        .update({ sheet_exported_at: new Date().toISOString(), sheet_export_ref: ref })
        .eq("id", script.id);
      if (updErr) console.error("write-to-sheet: export recorded in sheet but not in DB; a retry is safe");

      return json(200, { success: true, already_exported: !!result.duplicate, ...placement(ref) });
    }, "This script is already being sent to the sheet.");
  } catch (err) {
    return errorResponse(err, "write-to-sheet");
  }
};

// "November row 42" → { month: "November", row: 42 } (what the dashboard toast shows)
function placement(ref) {
  const m = /^(\w+) row (\d+)$/.exec(ref || "");
  return m ? { month: m[1], row: Number(m[2]), placed: ref } : { placed: ref || null };
}
