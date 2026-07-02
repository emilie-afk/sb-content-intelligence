/**
 * cluster-signal-background.js
 *
 * Background wrapper around ai-analyze. Netlify gives *-background functions
 * a 15-minute budget instead of the ~26s synchronous cap, and returns 202 to
 * the caller immediately.
 *
 * Needed because clustering a manual submission runs the full pipeline
 * (idea extraction + cluster matching + owned-channel/repetition checks that
 * fetch the Google Sheet) which can exceed the synchronous limit.
 *
 * Called by batch-cluster with x-internal-secret. The analysis result isn't
 * returned to the caller — ai-analyze writes the outcome (Clustered / Noise /
 * Needs cleanup / etc.) directly to the signals table.
 */
exports.handler = require("./ai-analyze").handler;
