/**
 * Netlify Function: scheduled-agent
 *
 * Optional server-side trigger for the Signal Flow Agent (the daily schedule runs
 * in GitHub Actions). Not registered as a Netlify schedule, so it is reachable over
 * HTTP — it therefore requires the scheduler credential, and forwards with the
 * internal credential. No model call happens here.
 */
const { json, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireService, internalHeaders, siteUrl } = require("../lib/auth");

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["POST"]);
    if (early) return early;
    await requireService(event, ["scheduler"]);
    const resp = await fetch(`${siteUrl()}/.netlify/functions/run-agent`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ run_type: "scheduled" }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await resp.json().catch(() => ({}));
    console.log("scheduled-agent:", resp.status, data.status || "");
    return json(resp.ok ? 200 : resp.status, { run_id: data.run_id || null, status: data.status || null, error: data.error || undefined });
  } catch (err) {
    return errorResponse(err, "scheduled-agent");
  }
};
