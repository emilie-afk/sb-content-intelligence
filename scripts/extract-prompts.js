#!/usr/bin/env node
/**
 * extract-prompts.js — one-time refactoring tool (kept for transparency).
 *
 * Moves confidential prompt WORDING out of the Netlify Function sources into a
 * private JSON prompt set, replacing each piece with prompts.t("<key>", [values]).
 * The dynamic values (the ${...} expressions) stay in the public code, in order, so
 * rendering the private template reproduces the original string exactly.
 *
 *   node scripts/extract-prompts.js <functionsDir> <outPrivateJson> [--write]
 *
 * Without --write it only reports. The output JSON must NEVER be committed:
 * import it privately (see docs/SECURITY-ROLLOUT.md) and delete local copies.
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");

// file → named regions (function / variable / constant names) whose wording is private
const TARGETS = {
  "ai-analyze.js": ["buildSignalPrompt", "buildOpportunityPrompt", "buildBriefPrompt", "BRIEF_PREFLIGHT_CHECKLIST",
    "briefLessonsBlock", "buildGenerateBriefPrompt", "buildBriefRevisionPrompt", "SCRIPT_PREFLIGHT_CHECKLIST",
    "lessonsBlock", "buildScriptGenPrompt", "buildScriptRevisionPrompt", "buildScriptPrompt",
    "buildExtractionPrompt", "buildClusterMatchPrompt", "buildCandidatePrompt"],
  "ai-briefing.js": ["buildSummaryPrompt", "buildTopicsPrompt", "buildActionsPrompt"],
  "generate-learning.js": ["buildBatchSummary>prompt", "generateRecommendation"],
  "ai-cleanup-batch.js": ["handler>prompt"],
  "merge-clusters.js": ["mergePrompt"],
  "run-agent.js": ["SYSTEM_PROMPT"],
};
// Query-builder calls whose string arguments are column lists / filters, never prompts.
const QUERY_CALLS = new Set(["select", "or", "not", "in", "eq", "neq", "ilike", "like", "order", "filter", "match"]);
const MIN_TEMPLATE = 20, MIN_LITERAL = 40;

function regionNames(anc) {
  const names = [];
  for (const a of anc) {
    if (a.type === "FunctionDeclaration" && a.id) names.push(a.id.name);
    else if (a.type === "VariableDeclarator" && a.id.type === "Identifier") names.push(a.id.name);
    else if (a.type === "AssignmentExpression" && a.left.type === "MemberExpression" && a.left.property.name === "handler") names.push("handler");
  }
  return names;
}

function matches(spec, names) {
  const parts = spec.split(">");
  // all parts must appear in order among the ancestor names
  let i = 0;
  for (const n of names) if (n === parts[i]) i++;
  return i === parts.length;
}

function processFile(file, specs) {
  const src = fs.readFileSync(file, "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest", locations: true, ranges: true });
  const base = path.basename(file, ".js");
  const targets = [];
  walk.fullAncestor(ast, (node, anc) => {
    let ok = false;
    if (node.type === "TemplateLiteral") ok = node.quasis.reduce((a, q) => a + q.value.cooked.length, 0) >= MIN_TEMPLATE;
    else if (node.type === "Literal" && typeof node.value === "string") ok = node.value.length >= MIN_LITERAL;
    if (!ok) return;
    const parent = anc[anc.length - 2];
    if (parent && parent.type === "TaggedTemplateExpression") return;
    if (parent && parent.type === "CallExpression" && parent.callee.type === "MemberExpression" &&
        QUERY_CALLS.has(parent.callee.property.name)) return;
    if (parent && parent.type === "Property" && parent.key === node) return;
    const names = regionNames(anc);
    const spec = specs.find(s => matches(s, names));
    if (!spec) return;
    targets.push({ node, region: spec.replace(/>/g, ".") });
  });
  targets.sort((a, b) => a.node.start - b.node.start);
  const counters = {};
  for (const t of targets) { counters[t.region] = (counters[t.region] || 0) + 1; t.key = `${base}.${t.region}.${counters[t.region]}`; }
  const byNode = new Map(targets.map(t => [t.node, t]));
  const templates = {};

  // Rewrite [start,end) of src, replacing any target nodes inside it.
  function rewrite(start, end, skipNode) {
    const inner = targets.filter(t => t.node !== skipNode && t.node.start >= start && t.node.end <= end);
    // keep only outermost
    const outer = inner.filter(t => !inner.some(o => o !== t && o.node.start <= t.node.start && o.node.end >= t.node.end));
    let out = "", pos = start;
    for (const t of outer) { out += src.slice(pos, t.node.start) + emit(t); pos = t.node.end; }
    return out + src.slice(pos, end);
  }
  function emit(t) {
    const n = t.node;
    if (n.type === "Literal") {
      if (/\{\{\d+\}\}/.test(n.value)) throw new Error(`placeholder collision in ${t.key}`);
      templates[t.key] = n.value;
      return `prompts.t(${JSON.stringify(t.key)})`;
    }
    let text = "";
    n.quasis.forEach((q, i) => {
      if (/\{\{\d+\}\}/.test(q.value.cooked)) throw new Error(`placeholder collision in ${t.key}`);
      text += q.value.cooked;
      if (i < n.expressions.length) text += `{{${i}}}`;
    });
    templates[t.key] = text;
    const args = n.expressions.map(e => rewrite(e.start, e.end, null));
    return args.length ? `prompts.t(${JSON.stringify(t.key)}, [${args.join(", ")}])` : `prompts.t(${JSON.stringify(t.key)})`;
  }
  let out = rewrite(0, src.length, null);
  if (targets.length && !/require\("\.\.\/lib\/prompts"\)/.test(out)) {
    // insert after the leading comment block / first require
    const idx = out.indexOf("\nconst ");
    out = out.slice(0, idx) + `\nconst prompts = require("../lib/prompts");` + out.slice(idx);
  }
  return { out, templates, count: targets.length };
}

function main() {
  const [dir, outJson, flag] = process.argv.slice(2);
  if (!dir || !outJson) { console.error("usage: extract-prompts.js <functionsDir> <outPrivateJson> [--write]"); process.exit(2); }
  const all = {};
  for (const [file, specs] of Object.entries(TARGETS)) {
    const p = path.join(dir, file);
    const { out, templates, count } = processFile(p, specs);
    Object.assign(all, templates);
    console.log(`${file}: ${count} prompt pieces`);
    if (flag === "--write") fs.writeFileSync(p, out);
  }
  fs.writeFileSync(outJson, JSON.stringify({ format: 1, templates: all }, null, 2), { mode: 0o600 });
  console.log(`${Object.keys(all).length} templates → ${outJson}`);
}

if (require.main === module) main();
module.exports = { processFile, TARGETS };
