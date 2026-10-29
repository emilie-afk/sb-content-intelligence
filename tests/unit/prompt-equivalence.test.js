/**
 * Proves the prompt move preserved behaviour: for every prompt builder, the
 * pre-change source (BASE_REF) and the current source rendered with the private
 * template set produce byte-identical prompts for rich and empty inputs.
 *
 * The private set is regenerated in a temp dir from BASE_REF, so no confidential
 * file is needed in the repository. Skips when BASE_REF isn't in the clone.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Module = require("module");

const ROOT = path.resolve(__dirname, "../..");
const BASE_REF = process.env.PROMPT_BASE_REF || "ddb3428";
const FILES = ["ai-analyze.js", "ai-briefing.js", "generate-learning.js", "ai-cleanup-batch.js", "merge-clusters.js", "run-agent.js"];

function haveRef() {
  try { execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASE_REF}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
}

function loadInternals(file, src, names) {
  const exportLine = `\n;module.exports.__fns = {${names.map(n => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(",")}};\n`;
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src + exportLine, file);
  return m.exports.__fns;
}

const BUILDERS = {
  "ai-analyze.js": ["buildSignalPrompt", "buildOpportunityPrompt", "buildBriefPrompt", "buildGenerateBriefPrompt",
    "buildBriefRevisionPrompt", "buildScriptGenPrompt", "buildScriptRevisionPrompt", "buildScriptPrompt",
    "buildExtractionPrompt", "buildClusterMatchPrompt", "buildCandidatePrompt", "briefLessonsBlock", "lessonsBlock"],
  "ai-briefing.js": ["buildSummaryPrompt", "buildTopicsPrompt", "buildActionsPrompt"],
};

// Rich object: every property access returns a deterministic value; arrays where useful.
function rich(tag) {
  const arrKeys = new Set(["representative_wording", "audience_wording", "possible_directions", "gaps", "suggested_angles",
    "brand_violations", "hook_ideas", "improvements", "problems_mentioned", "tips_mentioned", "platforms", "evidence_types",
    "ideas", "topTopics", "topPerformanceNotes", "clusters", "changedClusters", "competitorItems", "marketWatchItems",
    "recentSignals", "audience_followup_questions", "contradictions", "examples", "hook_suggestions", "problems", "tips",
    "claims", "questions", "wording", "sources"]);
  return new Proxy({}, {
    get(_, k) {
      if (typeof k === "symbol") return undefined;
      if (k === "toJSON") return undefined;
      if (k === "cluster") return rich(tag + ".cluster");
      if (["score", "signal_count", "question_count", "distinct_source_count", "count", "views", "estimated_duration_seconds",
           "totalClusters", "newSignalCount", "changedCount", "competitorCount", "marketWatchCount", "days_since_similar"].includes(k)) return 7;
      if (arrKeys.has(k)) return [`${tag}.${k}.a`, `${tag}.${k}.b`];
      if (k === "periodStart" || k === "periodEnd") return "2026-10-01T00:00:00.000Z";
      return `${tag}.${k}`;
    },
    has() { return true; },
  });
}
const rules = [{ severity: "Required", category: "Voice", rule_name: "R1", rule_text: "T1" }, { severity: "Forbidden", category: "Style", rule_name: "R2", rule_text: "T2" }];
const lessons = [{ issue: "gap one", count: 3, rule: "r", fix: "f" }, { issue: "gap two", count: 1, rule: "r2", fix: "f2" }];
const sheet = [{ month: "May", title: "T", style: "S", script: "script text here", note: "n", status: "Done" }];
const pubs = [{ video_title: "V", topic: "t", plant_or_product: "p", hook_used: "h", angle_used: "a", platform: "TikTok", publish_date: "2026-05-01", performance_summary: "ok", audience_followup_questions: "q" }];
const clusters = [{ id: "c1", title: "Cluster", summary: "s", plant_or_product: "p", primary_question: "q", signal_count: 3, audience_wording: ["w"] }];

function argSets(name) {
  const r = rich(name);
  switch (name) {
    case "buildSignalPrompt": case "buildBriefPrompt": return [[r, "watch"], [{}, ""]];
    case "buildCandidatePrompt": return [[r, sheet, pubs, "watch"], [{}, [], [], ""], [r, [], pubs, "w"]];
    case "buildOpportunityPrompt": return [[r, "watch", sheet, pubs], [{}, "", [], []], [r, "w", sheet, pubs].slice(0, 2).concat([[], pubs])];
    case "buildGenerateBriefPrompt": return [[r, rules, lessons, "notes", "memory"], [{}, [], [], null, null]];
    case "buildBriefRevisionPrompt": return [[r, rich("fb"), rules, lessons, "notes"], [{}, {}, [], [], null]];
    case "buildScriptGenPrompt": return [[r, rules, 30, lessons, "memory", ["hook a", "hook b"], [{ script_title: "s", created_at: "2026-10-01", opening_hook: "h" }]], [{}, [], 20, [], null]];
    case "buildScriptRevisionPrompt": return [
      [r, rich("fb"), rules, 25, lessons, "notes", "question", false, ["h1"]],
      [r, rich("fb"), rules, 25, lessons, "notes", "question", true, ["h1"]],
      [{}, {}, [], 20, [], null, null, false, []], [{}, {}, [], 20, [], null, null, true]];
    case "buildScriptPrompt": return [[r, rules], [{}, []]];
    case "buildExtractionPrompt": return [[r], [{}]];
    case "buildClusterMatchPrompt": return [[{ ideas: [{ idea: "i", evidence_type: "Question" }], ...{} }, clusters], [{}, []], [rich("x"), clusters]];
    case "briefLessonsBlock": case "lessonsBlock": return [[lessons], [[]]];
    case "buildSummaryPrompt": return [[r], [{ topTopics: [], totalClusters: 0 }]];
    case "buildTopicsPrompt": return [[r]];
    case "buildActionsPrompt": return [[r, ["topic 1", "topic 2"]]];
    default: return [[r]];
  }
}

// Freeze "now" so prompts that embed the current time compare deterministically.
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(1793232000000); else super(...a); }
  static now() { return 1793232000000; }
}
function safeCall(fn, args) {
  globalThis.Date = FixedDate;
  try { return safeCallInner(fn, args); } finally { globalThis.Date = RealDate; }
}
function safeCallInner(fn, args) {
  try { return { ok: fn(...args) }; } catch (e) { return { err: String(e && e.message) }; }
}

test("prompt builders render identical text after moving wording out of the repo", { skip: !haveRef() && `base ref ${BASE_REF} not available` }, async () => {
  fs.mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp", "prompt-eq-"));
  const baseFns = path.join(tmp, "base/netlify/functions");
  fs.mkdirSync(baseFns, { recursive: true });
  fs.mkdirSync(path.join(tmp, "base/netlify/lib"), { recursive: true });
  for (const f of [...FILES, "_auth.js", "_agent-tools.js"]) {
    fs.writeFileSync(path.join(baseFns, f), execFileSync("git", ["-C", ROOT, "show", `${BASE_REF}:netlify/functions/${f}`]));
  }
  // Generate the private set from the base sources (into tmp only).
  const { processFile, TARGETS } = require(path.join(ROOT, "scripts/extract-prompts.js"));
  const templates = {};
  for (const [f, specs] of Object.entries(TARGETS)) Object.assign(templates, processFile(path.join(baseFns, f), specs).templates);

  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
  const prompts = require(path.join(ROOT, "netlify/lib/prompts.js"));
  const set = { id: 1, version: 1, templates };

  let compared = 0, okCount = 0;
  for (const [file, names] of Object.entries(BUILDERS)) {
    const oldFns = loadInternals(path.join(baseFns, file), fs.readFileSync(path.join(baseFns, file), "utf8"), names);
    const newPath = path.join(ROOT, "netlify/functions", file);
    const newFns = loadInternals(newPath, fs.readFileSync(newPath, "utf8"), names);
    for (const name of names) {
      assert.ok(oldFns[name], `${file}:${name} missing in base`);
      assert.ok(newFns[name], `${file}:${name} missing in new code`);
      for (const args of argSets(name)) {
        const a = safeCall(oldFns[name], args);
        const b = await prompts.runWithPrompts(set, async () => safeCall(newFns[name], args));
        assert.deepStrictEqual(b, a, `${file}:${name} differs`);
        if (process.env.EQ_DEBUG) console.log(name, a.ok !== undefined ? "ok len=" + String(a.ok).length : "ERR " + a.err);
        if (a.ok !== undefined) okCount++;
        compared++;
      }
    }
  }
  assert.ok(okCount >= 30, `only ${okCount} successful comparisons ran`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("generate-learning prompts (sent to the model) are unchanged", { skip: !haveRef() && `base ref ${BASE_REF} not available` }, async () => {
  fs.mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp", "prompt-eq-gl-"));
  const baseFns = path.join(tmp, "base/netlify/functions");
  fs.mkdirSync(baseFns, { recursive: true });
  for (const f of ["generate-learning.js", "_auth.js"]) {
    fs.writeFileSync(path.join(baseFns, f), execFileSync("git", ["-C", ROOT, "show", `${BASE_REF}:netlify/functions/${f}`]));
  }
  const { processFile, TARGETS } = require(path.join(ROOT, "scripts/extract-prompts.js"));
  const { templates } = processFile(path.join(baseFns, "generate-learning.js"), TARGETS["generate-learning.js"]);
  const prompts = require(path.join(ROOT, "netlify/lib/prompts.js"));
  const set = { id: 2, version: 1, templates };

  process.env.CLAUDE_API_KEY = "test-key";
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    sent.push(JSON.parse(opts.body).messages[0].content);
    return { ok: true, json: async () => ({ content: [{ text: "ok" }] }) };
  };
  const names = ["buildBatchSummary", "generateRecommendation"];
  const oldFns = loadInternals(path.join(baseFns, "generate-learning.js"), fs.readFileSync(path.join(baseFns, "generate-learning.js"), "utf8"), names);
  const newPath = path.join(ROOT, "netlify/functions/generate-learning.js");
  const newFns = loadInternals(newPath, fs.readFileSync(newPath, "utf8"), names);

  const batchStats = { count: 3, avgViews: 1234, avgSaveRate: "1.2", avgLikeRate: "3.4", avgFollows: 2, avgComments: 5,
    tierCounts: { Normal: 2, Unacceptable: 1 }, platforms: { TikTok: { count: 2, avgViews: 1500, avgSaveRate: "1.1" }, Instagram: { count: 1, avgViews: 700, avgSaveRate: "0.4" } } };
  const batch = [
    { topic: "Root rot #fix", platform: "TikTok", views_count: 2000, saves_count: 20 },
    { topic: "Etiolation", platform: "Instagram", views_count: 700, saves_count: 0 },
    { topic: "Watering", platform: "TikTok", views_count: 1000, saves_count: 3 }];
  const recArgs = (views, extra = {}) => ({ cleanTopic: "Root rot", hook: "Your plant is mushy?", views, day: 3,
    video: { saves_count: 4, comments_count: 2, shares_count: 1, follows_count: 1, likes_count: 30 },
    whatWorked: "close-up", improve: "shorter", scriptTitle: "Fix root rot", scriptDuration: 22, scriptWordCount: 55,
    rank: { compLabel: "TikTok", viewsVsAvg: 12, compAvgViews: 1800, saveRateVsAvg: -5, compAvgSave: "1.3" },
    batchStats, crossPlatform: [{ platform: "Instagram", views_count: 500 }], ...extra });

  const cases = [
    ["buildBatchSummary", [batch, batchStats]],
    ["generateRecommendation", [recArgs(120)]],
    ["generateRecommendation", [recArgs(2500)]],
    ["generateRecommendation", [recArgs(25000)]],
    ["generateRecommendation", [recArgs(25000, { rank: null, whatWorked: null, improve: null, scriptDuration: null, crossPlatform: [] })]],
  ];
  try {
    for (const [name, args] of cases) {
      sent.length = 0;
      await oldFns[name](...args);
      const before = sent.slice();
      sent.length = 0;
      await prompts.runWithPrompts(set, () => newFns[name](...args));
      assert.ok(before.length === 1, `${name}: base made no model call`);
      assert.deepStrictEqual(sent, before, `${name} prompt differs`);
    }
  } finally {
    global.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
