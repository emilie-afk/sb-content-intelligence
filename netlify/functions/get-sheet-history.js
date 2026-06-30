/**
 * Netlify Function: get-sheet-history
 *
 * Fetches 2026 content entries from the Google Sheet via the Apps Script
 * web app, for use in the repetition check.
 *
 * GET /.netlify/functions/get-sheet-history
 *
 * The Apps Script URL must be saved in Supabase settings:
 *   key = 'calendar_script_url', value = { url: '...' }
 */

const { createClient } = require("@supabase/supabase-js");
const { requireUserRole, CORS_HEADERS: headers } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
  if (authError) return authError;

  try {
    // Get the Apps Script URL from settings
    const { data: setting, error: settingErr } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "calendar_script_url")
      .single();

    if (settingErr || !setting?.value?.url) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Calendar script URL not configured in dashboard settings." }),
      };
    }

    // Append shared secret as query param so Apps Script can validate the caller
    const secret = process.env.CALENDAR_SCRIPT_SECRET;
    const baseUrl   = setting.value.url;
    const scriptUrl = secret
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(secret)}`
      : baseUrl;

    // Call Apps Script doGet — returns all 2026 entries as JSON
    const resp = await fetch(scriptUrl, {
      method:   "GET",
      redirect: "follow",
      headers:  { "Accept": "application/json" },
    });

    if (!resp.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Apps Script returned ${resp.status}` }),
      };
    }

    const data = await resp.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error("get-sheet-history error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
