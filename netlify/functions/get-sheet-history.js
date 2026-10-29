/**
 * Netlify Function: get-sheet-history
 *
 * Returns the script sheet's content entries (all month tabs) for repetition
 * checking. The Apps Script location and secret stay on the server; the response
 * carries entries only, never the sheet or script URL.
 *
 * GET or POST /.netlify/functions/get-sheet-history
 * Auth: approved owner / admin / assistant session.
 */
const { json, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireUser, ROLES } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");
const { callAppsScript } = require("../lib/sources");

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["GET", "POST"]);
    if (early) return early;
    await requireUser(event, { roles: ROLES.WRITERS, bucket: "sheet" });
    const data = await callAppsScript(serviceClient(), "history");
    return json(200, { success: true, entries: Array.isArray(data.entries) ? data.entries : [], sheet: data.sheet || null });
  } catch (err) {
    return errorResponse(err, "get-sheet-history");
  }
};
