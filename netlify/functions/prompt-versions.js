/**
 * Netlify Function: prompt-versions  (owner / admin only)
 *
 * Private prompt sets are stored as immutable, numbered versions in
 * ci_prompt_versions (server-only table). Exactly one version is active.
 *
 * GET                     → list versions (metadata only)
 * GET  ?id=<id>           → one version including its templates
 * POST { content, note, activate } → create a new version (optionally activate)
 * POST { activate_id }    → make an existing version active (rollback = activate an older id)
 *
 * Content format: { "format": 1, "templates": { "<key>": "<text with {{0}} placeholders>" } }
 * A new version must contain every key the current code uses (checked here), so an
 * incomplete set can't be activated by accident.
 */
const { PublicError, json, parseBody, preflightOrMethod, errorResponse } = require("../lib/http");
const { requireUser, ROLES } = require("../lib/auth");
const { serviceClient } = require("../lib/supabase");
const { PROMPT_SET } = require("../lib/prompts");
const REQUIRED_KEYS = require("../lib/prompt-keys.json");

function validateContent(content) {
  if (!content || typeof content !== "object" || !content.templates || typeof content.templates !== "object") {
    throw new PublicError(400, 'content must be { "templates": { … } }');
  }
  const t = content.templates;
  for (const [k, v] of Object.entries(t)) {
    if (typeof v !== "string") throw new PublicError(400, `template ${k} must be text`);
    if (v.length > 60000) throw new PublicError(400, `template ${k} is too long`);
  }
  const missing = REQUIRED_KEYS.filter(k => typeof t[k] !== "string");
  if (missing.length) throw new PublicError(400, `missing templates: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
}

exports.handler = async (event) => {
  try {
    const early = preflightOrMethod(event, ["GET", "POST"]);
    if (early) return early;
    const caller = await requireUser(event, { roles: ROLES.ADMINS, bucket: "admin" });
    const sb = serviceClient();

    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters && event.queryStringParameters.id;
      if (id) {
        if (!/^\d{1,12}$/.test(id)) throw new PublicError(400, "id must be a number");
        const { data, error } = await sb.from("ci_prompt_versions")
          .select("id, version, note, is_active, created_at, created_by, content").eq("id", Number(id)).maybeSingle();
        if (error) throw new Error("prompt read failed");
        if (!data) throw new PublicError(404, "Version not found");
        return json(200, data);
      }
      const { data, error } = await sb.from("ci_prompt_versions")
        .select("id, version, note, is_active, created_at, created_by").eq("prompt_set", PROMPT_SET)
        .order("version", { ascending: false }).limit(50);
      if (error) throw new Error("prompt list failed");
      return json(200, { versions: data || [], required_keys: REQUIRED_KEYS.length });
    }

    const body = parseBody(event, { maxBytes: 1024 * 1024, allowEmpty: false });
    if (body.activate_id !== undefined) {
      if (!Number.isInteger(body.activate_id)) throw new PublicError(400, "activate_id must be a number");
      const { data: v } = await sb.from("ci_prompt_versions").select("content").eq("id", body.activate_id).maybeSingle();
      if (!v) throw new PublicError(404, "Version not found");
      validateContent(v.content);
      const { error } = await sb.rpc("ci_activate_prompt_version", { p_id: body.activate_id });
      if (error) throw new Error("activate failed");
      return json(200, { success: true, active_id: body.activate_id });
    }
    validateContent(body.content);
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
    const { data: newId, error } = await sb.rpc("ci_create_prompt_version", {
      p_set: PROMPT_SET, p_content: body.content, p_note: note, p_created_by: caller.userId, p_activate: body.activate === true,
    });
    if (error) throw new Error("create failed");
    return json(200, { success: true, id: newId, active: body.activate === true });
  } catch (err) {
    return errorResponse(err, "prompt-versions");
  }
};
