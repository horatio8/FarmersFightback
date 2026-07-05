// GET /api/signature-count → { count, display, raw, offset, updated_at }
//
// count = (cached Airtable Contacts count) + SIGNATURE_BASE_OFFSET.
// The raw count is recomputed every 5 minutes by /api/cron/refresh-
// signature-count and stored in the Site Stats table, so this endpoint is
// a single fast Airtable read. Edge-cached 2 minutes on top.
//
// Env (both runtime-read, changeable in Vercel without a deploy):
//   SIGNATURE_BASE_OFFSET      default 69500
//   SIGNATURE_ROUND_DOWN_TO    e.g. 500 → display "80,000+"; 0/unset = exact

const { findOne } = require("./_airtable");

const STATS_TABLE = process.env.AIRTABLE_STATS_TABLE || "Site Stats";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  try {
    const offset = Number(process.env.SIGNATURE_BASE_OFFSET ?? 69500);
    const row = await findOne(STATS_TABLE, `{key}='signature_count'`);
    const raw = Number(row?.fields?.num_value) || 0;
    const count = raw + offset;
    const roundTo = Number(process.env.SIGNATURE_ROUND_DOWN_TO) || 0;
    const display = roundTo > 0
      ? `${(Math.floor(count / roundTo) * roundTo).toLocaleString("en-AU")}+`
      : count.toLocaleString("en-AU");
    return res.status(200).json({
      count,
      display,
      raw,
      offset,
      updated_at: row?.fields?.updated_at || null,
      stale: !row,
    });
  } catch (e) {
    console.error("signature-count:", e.message);
    // Fail soft: the frontend keeps its static number if this 500s.
    return res.status(500).json({ error: "unavailable" });
  }
};
