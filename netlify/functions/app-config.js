/**
 * Netlify Function: app-config
 *
 * GET  → links the dashboard needs, for APPROVED members only:
 *          { script_sheet_url, video_tracker_url }
 *        Approved members DO receive these sheet URLs (they open them); the URLs
 *        are simply no longer shipped in public code to everyone on the internet.
 * POST → owner/admin: update the current year's script spreadsheet link
 *          { script_sheet_url: "https://docs.google.com/spreadsheets/d/…" }
 *        (monthly tab ids stay as configured; see docs/SECURITY-ROLLOUT.md)
 */
const { json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireUser, ROLES } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");
const { getIntegration, scriptSheetLink, videoTrackerLink, normaliseSheetUrl } = require("../lib/sources");

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["GET", "POST"]);
    if (early) return early;
    const sb = serviceClient();

    if (event.httpMethod === "GET") {
      await requireUser(event, { roles: ROLES.ALL, bucket: "read" });
      const [sheet, tracker] = await Promise.all([scriptSheetLink(sb, new Date()), videoTrackerLink(sb)]);
      return json(200, { script_sheet_url: sheet, video_tracker_url: tracker });
    }

    const caller = await requireUser(event, { roles: ROLES.ADMINS, bucket: "admin" });
    const body = parseBody(event, { maxBytes: 4096, allowEmpty: false });
    const url = normaliseSheetUrl(body.script_sheet_url);
    const year = String(new Date().getFullYear());
    const current = (await getIntegration(sb, "script_sheet")) || {};
    const value = { ...current, base_url: { ...(current.base_url || {}), [year]: url } };
    const { error } = await sb.from("ci_integration_config").upsert(
      { key: "script_sheet", value, updated_at: new Date().toISOString(), updated_by: caller.userId },
      { onConflict: "key" }
    );
    if (error) throw new Error("config update failed");
    return json(200, { success: true, script_sheet_url: await scriptSheetLink(sb, new Date()) });
  } catch (err) {
    return errorResponse(err, "app-config");
  }
};
