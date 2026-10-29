/**
 * prompts.js — confidential prompt text lives in the database (ci_prompt_versions),
 * not in this public repository. Code keeps the assembly logic and the dynamic
 * values; the private prompt set supplies the wording.
 *
 *   const set = await loadPromptSet(sb, { versionId });   // once per request / job
 *   await runWithPrompts(set, async () => { ... t("key", [v0, v1]) ... });
 *
 * Templates use positional placeholders {{0}}, {{1}} … and are rendered with the same
 * string conversion as a JavaScript template literal, so output matches the previous
 * inline prompts exactly. Versions are immutable; long-running jobs pass the version
 * id they started with (pinning). There is no hard-coded fallback: a missing prompt
 * set or template stops the request before any model call.
 */
const { AsyncLocalStorage } = require("async_hooks");
const { PublicError } = require("./http");

const PROMPT_SET = "content";
const storage = new AsyncLocalStorage();
const byId = new Map(); // immutable versions → safe to cache in memory

function validateContent(content) {
  return content && typeof content === "object" && content.templates && typeof content.templates === "object";
}

async function loadPromptSet(sb, { versionId } = {}) {
  if (versionId != null && byId.has(Number(versionId))) return byId.get(Number(versionId));
  let q = sb.from("ci_prompt_versions").select("id, version, content");
  q = versionId != null ? q.eq("id", Number(versionId)) : q.eq("prompt_set", PROMPT_SET).eq("is_active", true);
  const { data, error } = await q.maybeSingle();
  if (error || !data || !validateContent(data.content)) {
    throw new PublicError(503, "Prompt configuration is missing. An admin must import the private prompt set.");
  }
  const set = { id: Number(data.id), version: data.version, templates: data.content.templates };
  byId.set(set.id, set);
  return set;
}

function runWithPrompts(set, fn) {
  return storage.run(set, fn);
}

function current() {
  const set = storage.getStore();
  if (!set) throw new PublicError(503, "Prompt configuration is not loaded");
  return set;
}

function t(key, values = []) {
  const tpl = current().templates[key];
  if (typeof tpl !== "string") throw new PublicError(503, `Prompt configuration is incomplete (${key})`);
  return tpl.replace(/\{\{(\d+)\}\}/g, (_, i) => `${values[Number(i)]}`);
}

function currentVersionId() {
  const set = storage.getStore();
  return set ? set.id : null;
}

module.exports = { PROMPT_SET, loadPromptSet, runWithPrompts, t, currentVersionId, __cache: byId };
