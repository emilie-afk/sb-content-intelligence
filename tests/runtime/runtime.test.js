/**
 * R1: the configured runtime can initialise the REAL (uninjected) Supabase client,
 * and every Node version setting agrees with the locked dependencies.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");

function minMajor(range) {
  const m = /^>=\s*(\d+)/.exec(String(range || "").trim());
  return m ? Number(m[1]) : null;
}

test("netlify.toml NODE_VERSION satisfies every locked package's engines", () => {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const nodeVersion = Number((/NODE_VERSION\s*=\s*"(\d+)/.exec(toml) || [])[1]);
  assert.ok(nodeVersion, "NODE_VERSION missing");
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const tooNew = [];
  for (const [name, pkg] of Object.entries(lock.packages || {})) {
    if (!name || !pkg.engines || pkg.dev) continue;
    const need = minMajor(pkg.engines.node);
    if (need && need > nodeVersion) tooNew.push(`${name} needs node ${pkg.engines.node}`);
  }
  assert.deepStrictEqual(tooNew, []);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.strictEqual(minMajor(pkgJson.engines.node), nodeVersion, "package.json engines must match NODE_VERSION");
  assert.strictEqual(require(path.join(ROOT, "netlify/lib/supabase.js")).MIN_NODE_MAJOR, nodeVersion);
});

test("the real service client initialises on this runtime (no injected factory)", () => {
  for (const k of Object.keys(require.cache)) if (k.includes("/netlify/")) delete require.cache[k];
  process.env.SUPABASE_URL = "https://example-ref.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-real";
  const { serviceClient } = require(path.join(ROOT, "netlify/lib/supabase.js"));
  const c = serviceClient();
  assert.strictEqual(typeof c.from, "function");
  assert.strictEqual(typeof c.rpc, "function");
  assert.strictEqual(typeof c.auth.getUser, "function");
});

test("every function module loads on this runtime", () => {
  const dir = path.join(ROOT, "netlify/functions");
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
    const mod = require(path.join(dir, f));
    assert.strictEqual(typeof mod.handler, "function", f);
  }
});
