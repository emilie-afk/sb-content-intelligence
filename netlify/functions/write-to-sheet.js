// write-to-sheet.js
// Receives a script_id, fetches the script from Supabase,
// and posts it to the Google Sheets Apps Script web app.

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INTERNAL_SECRET       = process.env.INTERNAL_SECRET;
const SCRIPT_SHEET_HOOK_URL = process.env.SCRIPT_SHEET_HOOK_URL;   // Apps Script web app URL
const SCRIPT_SHEET_TOKEN    = process.env.SCRIPT_SHEET_TOKEN;       // Shared secret

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || "";
  let authed = false;
  if (authHeader === `Bearer ${INTERNAL_SECRET}`) {
    authed = true;
  } else {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user && !error) authed = true;
  }
  if (!authed)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  if (!SCRIPT_SHEET_HOOK_URL)
    return { statusCode: 503, headers, body: JSON.stringify({ error: "SCRIPT_SHEET_HOOK_URL not configured" }) };

  // ── Parse body ────────────────────────────────────────────────────────────
  const { script_id, approved_at } = JSON.parse(event.body || "{}");
  if (!script_id)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "script_id required" }) };

  // ── Fetch script from Supabase ────────────────────────────────────────────
  const { data: script, error: fetchErr } = await supabase
    .from("script_outputs")
    .select("*")
    .eq("id", script_id)
    .single();

  if (fetchErr || !script)
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Script not found" }) };

  if (script.review_status !== "Approved")
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Only Approved scripts can be sent to the sheet" }) };

  // ── Post to Apps Script web app ───────────────────────────────────────────
  try {
    // Ensure hook is the first line of the voiceover (safety net for older scripts)
    let scriptText = script.full_voiceover_script || "";
    if (script.opening_hook && !scriptText.trimStart().startsWith(script.opening_hook)) {
      scriptText = script.opening_hook + " " + scriptText;
    }
    // Append CTA if not already present
    if (script.cta && !scriptText.includes(script.cta)) {
      scriptText = scriptText.trimEnd() + "\n\n" + script.cta;
    }

    const res = await fetch(SCRIPT_SHEET_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "x-script-secret": SCRIPT_SHEET_TOKEN,
        title:             script.script_title || "",
        thumbnail_title:   script.thumbnail_title || script.opening_hook || "",
        script_text:       scriptText,
        caption:           script.caption || "",
        platform:          script.platform || "",
      }),
      redirect: "follow",
    });

    const text = await res.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }

    if (result.error)
      return { statusCode: 500, headers, body: JSON.stringify({ error: result.error }) };

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
