/**
 * Confidential prompt wording, source locations and committed credentials must not
 * be in any tracked file (the public repository) or in the published site folder.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "../..");
const BASE_REF = process.env.PROMPT_BASE_REF || "ddb3428";

function trackedFiles() {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter(f => fs.existsSync(path.join(ROOT, f)));
}

const FORBIDDEN = [
  /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{25,}/,              // real sheet ids
  /script\.google\.com\/macros\/s\/AKfyc[A-Za-z0-9_-]{20,}/,               // Apps Script deployments
  /sb-scraper-2026-[A-Za-z0-9]+/,                                         // committed submit token
  /sk-ant-[A-Za-z0-9_-]{10,}/, /sb_secret_[A-Za-z0-9_-]+/, /BEGIN PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,        // JWTs (service role keys)
];

// Former sheet ids, monthly tab ids, Apps Script deployment id, submission token, token id and
// token hash, kept only as SHA-256 digests so this file does not publish them again.
const FORMER_VALUE_DIGESTS = new Set([
  "108609ab63329267f1bfcb6ca9739b1f2c9a2bccb83404029502c8acff1dc9bd",
  "911ef213e0549fc3bc1cc77821e2a42d35ff53dd5d2e85963661fa4ff18e01a7",
  "ba14c916a10dda9d8b4731c0d6ff13e5468ed653263f32121a607c8c2a3a51df",
  "a531ea9403f245532352e9176067e5cf94662284c4b1363e96bd39b151b0db7d",
  "8465bc646bd58eb1f88df6344cca89d3c5722ccae01ce4301b8f8c89a23fb829",
  "24a809a5ffb645220baec2ae04a05fc214ea70838d1ee822d9fd3999c155fa98",
  "1f7634be2c8831d7fed8c59ade923e503843190ba488cf1c2388190305b2742a",
  "8eed20d8a9457281bed147cf4300aa5cd67e5ad1402cb7a0950857b69888a588",
  "3f28bbe5013760f586604bb12428ca5e1bed8a9eb532cbb0443d7dd01b5c96b1",
  "a5f074b7e174b88307e5b00a02aaed534daa089752a1f88e2bbb8b5ca4673f89",
  "2a49db898a4b094b7371e3428651c144acb219ba4d2c3d7eb2711939cbdc586a",
]);
const CANDIDATE = /[A-Za-z0-9_-]{9,80}/g;
function formerValues(s) {
  const found = new Set();
  for (const m of s.match(CANDIDATE) || []) {
    for (const v of [m, ...m.split(/[_-]/)]) {
      if (FORMER_VALUE_DIGESTS.has(crypto.createHash("sha256").update(v).digest("hex"))) found.add("former value");
    }
  }
  return [...found];
}

const SELF = new Set(["tests/static/exposure.test.js"]);

test("no source locations or credentials in tracked files", () => {
  const hits = [];
  for (const f of trackedFiles()) {
    if (SELF.has(f) || f.startsWith("node_modules/") || f === "package-lock.json") continue;
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const re of FORBIDDEN) if (re.test(s)) hits.push(`${f}: ${re}`);
    for (const v of formerValues(s)) hits.push(`${f}: ${v}`);
  }
  assert.deepStrictEqual(hits, []);
});

function haveRef() {
  try { execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASE_REF}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
}

test("no confidential prompt wording in tracked files or the published site", { skip: !haveRef() && "base ref unavailable" }, () => {
  // Rebuild the private set from the pre-change sources in memory only.
  const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp", "exposure-"));
  const { processFile, TARGETS } = require(path.join(ROOT, "scripts/extract-prompts.js"));
  const chunks = new Set();
  for (const [file, specs] of Object.entries(TARGETS)) {
    const p = path.join(tmp, file);
    fs.writeFileSync(p, execFileSync("git", ["-C", ROOT, "show", `${BASE_REF}:netlify/functions/${file}`]));
    for (const text of Object.values(processFile(p, specs).templates)) {
      for (const part of text.split(/\{\{\d+\}\}/)) {
        // distinctive sentences only (ignore short/common fragments)
        for (const line of part.split("\n")) if (line.trim().length >= 70) chunks.add(line.trim());
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(chunks.size > 50, "expected many distinctive prompt lines");
  const hits = [];
  for (const f of trackedFiles()) {
    if (f.startsWith("tests/") || f === "package-lock.json") continue;
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const c of chunks) if (s.includes(c)) { hits.push(`${f}: "${c.slice(0, 60)}…"`); break; }
  }
  assert.deepStrictEqual(hits, []);
});

test("published site folder holds only the page (no SQL, scripts or docs)", () => {
  const files = fs.readdirSync(path.join(ROOT, "public"));
  assert.deepStrictEqual(files.sort(), ["index.html"]);
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  assert.ok(!/service_role|sb_secret_|eyJhbGciOi/.test(html));
});
