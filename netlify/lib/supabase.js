/**
 * supabase.js — server-side Supabase client (service role). Never sent to the browser.
 * Fails closed: if configuration is missing, callers get a 503 instead of an
 * unauthenticated or half-configured client.
 */
const { createClient } = require("@supabase/supabase-js");
const { PublicError } = require("./http");

let cached = null;
let factory = (url, key) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const MIN_NODE_MAJOR = 22; // the locked Supabase client needs Node >= 22 (native WebSocket)

function serviceClient() {
  if (cached) return cached;
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`[supabase] unsupported Node.js ${process.version}; Node ${MIN_NODE_MAJOR}+ is required`);
    throw new PublicError(503, "Server runtime is misconfigured");
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new PublicError(503, "Server configuration is incomplete");
  cached = factory(url, key);
  return cached;
}

/**
 * Drop-in for the old module-level `const supabase = createClient(...)`: resolves
 * the service client on first use (inside the handler, after configuration checks).
 */
const lazyService = new Proxy({}, {
  get(_, prop) {
    const c = serviceClient();
    const v = c[prop];
    return typeof v === "function" ? v.bind(c) : v;
  },
});

/**
 * A client whose every request is cancelled when `signal` aborts (used to bound all
 * database work of a run by its deadline). Not cached.
 */
function boundClient(signal) {
  serviceClient(); // same configuration / runtime checks
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (factoryIsCustom) return factory(url, key, { signal });
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init = {}) =>
        fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    },
  });
}

/** Tests only: inject a fake client factory. */
let factoryIsCustom = false;
function __setFactory(f) { factory = f; factoryIsCustom = true; cached = null; }
function __reset() { cached = null; }

module.exports = { serviceClient, boundClient, lazyService, __setFactory, __reset, MIN_NODE_MAJOR };
