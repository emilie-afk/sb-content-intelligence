// Proxy: forwards approved script data to the Google Apps Script sheet web app.
// Runs server-side so there are no CORS issues from the browser.

const { createClient } = require("@supabase/supabase-js");
const { requireUserRole } = require("./_auth");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
  if (authError) return authError;

  try {
    const { title, style, script_text, platform, calendar_url } = JSON.parse(event.body || '{}');

    if (!calendar_url) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'calendar_url is required. Set it in dashboard → Scripts → ⚙ Calendar URL.' }),
      };
    }
    if (!title) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'title is required' }),
      };
    }

    const response = await fetch(calendar_url, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ title, style, script_text, platform }),
      redirect: 'follow',   // Google Apps Script redirects once before responding
    });

    const text = await response.text();
    let result;
    try   { result = JSON.parse(text); }
    catch { result = { success: response.ok, raw: text }; }

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(result),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
