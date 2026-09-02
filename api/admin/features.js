// GET /api/admin/features?token=ADMIN_TOKEN[&format=text][&area=SMS]
//
// The live state of every feature switch, dial and timed gate in the site,
// from the register in lib/features.js. Companion to /api/admin/env-check,
// which reports whether credentials are PRESENT; this reports what the site
// is currently DOING and exactly where each behaviour is controlled.
//
// Reads content/site.json and vercel.json from the deployment, and two
// Airtable rows (econ_settings, cn_uid_backfill) best-effort -- a failed read
// is reported as such, never as a wrong state.

const features = require("../../lib/features");
const site = require("../../content/site.json");
const vercel = require("../../vercel.json");

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

async function readAirtableState() {
  const out = { econ_settings: null, cn_uid_backfill: null };
  try {
    const { select } = require("../../lib/social/airtable");
    const { TABLES } = require("../../lib/econ/config");
    const econ = require("../../lib/econ/config");
    out.econ_settings = await econ.loadSettings(select).catch(() => null);
    const rows = await select(TABLES.SYNC_STATE, `{key} = 'cn_uid_backfill'`, null, 1).catch(() => []);
    if (rows.length && rows[0].fields && rows[0].fields.value) {
      try { out.cn_uid_backfill = JSON.parse(rows[0].fields.value); } catch { /* leave null */ }
    }
  } catch { /* wiring missing locally; every entry degrades to "not read" */ }
  return out;
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const url = new URL(req.url, "https://x");
  const area = (url.searchParams.get("area") || "").toLowerCase();
  const generated_at = new Date().toISOString();
  const env = process.env.VERCEL_ENV || "local";

  const airtable = await readAirtableState();
  let rows = features.evaluate({ now: new Date(), site, vercel, airtable });
  if (area) rows = rows.filter((r) => r.area.toLowerCase().includes(area));

  res.setHeader("Cache-Control", "no-store");
  if (url.searchParams.get("format") === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(features.renderText(rows, { env, generated_at }));
  }
  const on = rows.filter((r) => r.on === true).length;
  const off = rows.filter((r) => r.on === false).length;
  return res.status(200).json({ generated_at, env, counts: { on, off, dials: rows.length - on - off, total: rows.length }, features: rows });
};
