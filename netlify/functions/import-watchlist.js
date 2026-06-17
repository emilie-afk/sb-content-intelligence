/**
 * Netlify Function: import-watchlist
 *
 * Accepts a CSV export of the "Revenue by genus" sheet and
 * upserts rows into the plant_watchlist table.
 *
 * How to export the CSV:
 *   Google Sheet → Revenue by genus tab → File → Download → CSV
 *
 * POST /.netlify/functions/import-watchlist
 * Header: Authorization: Bearer <SUPABASE_ANON_KEY>  (must be admin/owner)
 * Body: { csv: "<raw csv string>" }
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type, Authorization",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  // Auth check
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: "Authorization header required" }) };

  const { data: { user }, error: authErr } = await createClient(
    process.env.SUPABASE_URL, token
  ).auth.getUser();

  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid token" }) };

  const { data: profile } = await supabase
    .from("users_profile").select("role").eq("id", user.id).single();
  if (!["admin","owner"].includes(profile?.role)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Admin or owner required" }) };
  }

  // Parse body
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { csv } = body;
  if (!csv) return { statusCode: 400, headers, body: JSON.stringify({ error: "csv field required" }) };

  // Parse CSV
  const rows = parseCSV(csv);
  if (rows.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: "No rows parsed from CSV" }) };

  // Map to plant_watchlist rows
  const now = new Date().toISOString();
  const plants = rows
    .map(r => mapRow(r, now))
    .filter(r => r && r.plant_name && r.plant_name.trim() !== "" && r.plant_name.toLowerCase() !== "genus");

  if (plants.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No valid plant rows found. Check CSV format." }) };
  }

  // Upsert
  const { error: upsertErr, count } = await supabase
    .from("plant_watchlist")
    .upsert(plants, { onConflict: "plant_name", count: "exact" });

  if (upsertErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: upsertErr.message }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, upserted: plants.length, message: `${plants.length} plants imported` }),
  };
};


// ── PARSE CSV ─────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Find header row (the one containing "Genus")
  let headerIdx = lines.findIndex(l => l.toLowerCase().includes("genus"));
  if (headerIdx === -1) headerIdx = 0;

  const headers = lines[headerIdx].split(",").map(h => h.replace(/"/g,"").trim().toLowerCase());
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length < 2) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || "").replace(/"/g,"").trim(); });
    rows.push(obj);
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseMoney(val) {
  if (!val) return null;
  const n = parseFloat(val.replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

function parseNum(val) {
  if (!val) return null;
  const n = parseInt(val.replace(/[,\s]/g, ""), 10);
  return isNaN(n) ? null : n;
}

function parsePct(val) {
  if (!val) return null;
  const n = parseFloat(val.replace(/[%\s]/g, ""));
  return isNaN(n) ? null : n;
}

function revenueTier(totalSales) {
  if (!totalSales) return "Watch";
  if (totalSales >= 5000) return "High";
  if (totalSales >= 1000) return "Medium";
  return "Watch";
}

function mapRow(r, now) {
  // Handle both "genus" and "plant name" header variants
  const name = r["genus"] || r["plant name"] || r["plant_name"] || "";
  if (!name || name.toLowerCase() === "genus" || name.toLowerCase() === "total") return null;

  const totalSales = parseMoney(r["total sales"] || r["total_sales"] || r["h"] || "");
  const netSales   = parseMoney(r["net sales"]   || r["net_sales"]   || r["g"] || "");
  const skus       = parseNum(r["products (skus)"] || r["products"] || r["skus"] || r["b"] || "");
  const netItems   = parseNum(r["net items sold"] || r["net_items_sold"] || r["c"] || "");
  const pct        = parsePct(r["% of total revenue"] || r["pct"] || r["i"] || "");

  return {
    plant_name:        name,
    revenue:           totalSales,
    net_sales:         netSales,
    skus:              skus,
    net_items_sold:    netItems,
    pct_total_revenue: pct,
    revenue_tier:      revenueTier(totalSales),
    search_keywords:   name.toLowerCase(),
    last_imported_at:  now,
    updated_at:        now,
  };
}
