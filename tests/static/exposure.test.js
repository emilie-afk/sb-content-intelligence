/**
 * Confidential prompt wording, source locations and committed credentials must not
 * be in any tracked file (the public repository) or in the published site folder.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const BASE_REF = process.env.PROMPT_BASE_REF || "ddb3428";

function trackedFiles() {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter(f => fs.existsSync(path.join(ROOT, f)));
}

const FORBIDDEN = [
  /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{25,}/,              // real sheet ids
  /script\.google\.com\/macros\/s\/AKfyc[A-Za-z0-9_-]{20,}/,               // Apps Script deployments
  /1iDg61cxy6oSxb8vL2AkaivTnQJuTVJY5bKIbtNBLHAQ|1M_GUihNRFgODfQuwB6PnBrbP145Rr1fwjdtUKE6Ckd4|1AZNg8Akcucxk53ORhDrFgDP2bMqy-aeFE_SY6mT1EPs/,
  /543399107|1014332536|827394542|1941512612/,                           // monthly tab ids
  /sb-scraper-2026-[A-Za-z0-9]+/,                                         // committed submit token
  /7263b466c4fe93b3f6909373b07592783f4351e0104e90e3104b2cedd2469447/,      // token hash
  /sk-ant-[A-Za-z0-9_-]{10,}/, /sb_secret_[A-Za-z0-9_-]+/, /BEGIN PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,        // JWTs (service role keys)
];
const SELF = new Set(["tests/static/exposure.test.js"]);

test("no source locations or credentials in tracked files", () => {
  const hits = [];
  for (const f of trackedFiles()) {
    if (SELF.has(f) || f.startsWith("node_modules/") || f === "package-lock.json") continue;
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const re of FORBIDDEN) if (re.test(s)) hits.push(`${f}: ${re}`);
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
