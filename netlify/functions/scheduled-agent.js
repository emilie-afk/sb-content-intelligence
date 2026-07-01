/**
 * Netlify Scheduled Function: scheduled-agent
 *
 * Runs daily (configured in netlify.toml) to trigger the Signal Flow Agent.
 * Calls run-agent with internal secret — no user JWT needed.
 */

const NETLIFY_URL =
  process.env.URL || "https://sb-content-intelligence.netlify.app";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

exports.handler = async () => {
  try {
    const resp = await fetch(`${NETLIFY_URL}/.netlify/functions/run-agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ run_type: "scheduled" }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("run-agent failed:", JSON.stringify(data));
      return { statusCode: resp.status, body: JSON.stringify(data) };
    }

    console.log("scheduled-agent done:", JSON.stringify(data));
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    console.error("scheduled-agent error:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
