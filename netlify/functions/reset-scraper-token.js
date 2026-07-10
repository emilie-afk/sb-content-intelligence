/**
 * One-time function to reset the Instagram Scraper submission token.
 * Protected by x-internal-secret header.
 * DELETE THIS FILE after use.
 *
 * POST /.netlify/functions/reset-scraper-token
 * Header: x-internal-secret: <INTERNAL_SECRET>
 */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TOKEN_ID = "29a9fde4-4461-4e07-9b17-b6c66224d7e7";
const NEW_HASH = "7263b466c4fe93b3f6909373b07592783f4351e0104e90e3104b2cedd2469447";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const secret = event.headers["x-internal-secret"];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const { error } = await supabase
    .from("submission_tokens")
    .update({
      token_hash: NEW_HASH,
      last_used_at: null,
      requests_this_hour: 0,
      hour_window_start: null,
    })
    .eq("id", TOKEN_ID);

  if (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, message: "Token reset. Delete this function now." }),
  };
};
