/**
 * _auth.js — Shared auth helper for Netlify functions.
 *
 * Usage:
 *   const { requireUserRole } = require("./_auth");
 *   const authError = await requireUserRole(event, supabase, ["admin", "owner"]);
 *   if (authError) return authError;  // already a formatted { statusCode, headers, body }
 */

const CORS_HEADERS = {
  "Content-Type":                "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":"Content-Type, Authorization",
};

/**
 * Verify the caller's Supabase JWT and check they hold one of the allowed roles.
 *
 * @param {object} event       - Netlify handler event
 * @param {object} supabase    - Supabase client initialised with the service-role key
 * @param {string[]} roles     - Roles allowed to call this function, e.g. ["admin","owner"]
 * @returns {null | object}    - null = OK, object = { statusCode, headers, body } error response
 */
async function requireUserRole(event, supabase, roles = ["admin", "owner"]) {
  const authHeader =
    event.headers["authorization"] ||
    event.headers["Authorization"] ||
    "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Authorization header required" }),
    };
  }

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid or expired token" }),
    };
  }

  const { data: profile } = await supabase
    .from("users_profile")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!roles.includes(profile?.role)) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Requires one of: ${roles.join(", ")}` }),
    };
  }

  return null; // caller is authenticated and authorised
}

module.exports = { requireUserRole, CORS_HEADERS };
