/**
 * push-to-calendar.js — REMOVED. Kept only so old callers get a clear 410.
 * No database, sheet or model access.
 */
const { json } = require("../lib/http");
exports.handler = async () => json(410, { error: "This endpoint has been removed." });
