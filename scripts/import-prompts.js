#!/usr/bin/env node
/**
 * import-prompts.js — import a PRIVATE prompt set into Supabase from a trusted machine.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> \
 *     node scripts/import-prompts.js <path/to/sb-prompts.private.json> [--activate] [--note "text"]
 *
 * - Reads the file locally and sends it straight to the database (ci_prompt_versions).
 * - Refuses sets that miss any template the current code needs.
 * - Never commit the JSON file; delete local copies when done (keep one offline backup).
 * Alternative without a key on disk: SQL editor (see docs/SECURITY-ROLLOUT.md).
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const activate = args.includes("--activate");
  const noteIdx = args.indexOf("--note");
  const note = noteIdx >= 0 ? args[noteIdx + 1] : "import";
  if (!file) throw new Error("usage: import-prompts.js <file> [--activate] [--note text]");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

  const content = JSON.parse(fs.readFileSync(file, "utf8"));
  const required = require(path.join(__dirname, "../netlify/lib/prompt-keys.json"));
  const missing = required.filter(k => typeof (content.templates || {})[k] !== "string");
  if (missing.length) throw new Error(`prompt set is missing ${missing.length} templates, e.g. ${missing.slice(0, 5).join(", ")}`);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: id, error } = await sb.rpc("ci_create_prompt_version", {
    p_set: "content", p_content: content, p_note: note, p_created_by: "import script", p_activate: activate,
  });
  if (error) throw new Error(`import failed: ${error.message}`);
  console.log(`Imported prompt version id=${id}${activate ? " (active)" : " (not active — activate it when ready)"}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
