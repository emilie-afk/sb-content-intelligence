/**
 * push-to-calendar.js — REMOVED
 *
 * This function has been decommissioned.
 * Script push to Google Sheet is no longer used.
 * Sheet history is still read by get-sheet-history.js for repetition checking.
 *
 * TODO: delete this file from the repo.
 */
exports.handler = async () => ({
  statusCode: 410,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: "This endpoint has been removed." }),
});
