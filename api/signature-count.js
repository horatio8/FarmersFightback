// GET /api/signature-count → { count, display, raw, offset, updated_at }
//
// count = (cached Airtable Contacts count) + SIGNATURE_BASE_OFFSET.
// The raw count is incremented at contact creation (event-driven) and
// reconciled by the nightly rollup's full recount, so this endpoint is a
// single fast Airtable read. Edge-cached 2 minutes on top.
//
// Env (both runtime-read, changeable in Vercel without a deploy):
//   SIGNATURE_BASE_OFFSET      default 69500
//   SIGNATURE_ROUND_DOWN_TO    e.g. 500 → display "80,000+"; 0/unset = exact

const { findOne } = require("./_airtable");
const { dispatchDueSMS } = require("./_cellcast");

const STATS_TABLE = process.env.AIRTABLE_STATS_TABLE || "Site Stats";

// Traffic-triggered SMS drain: this is the busiest endpoint (every page load,
// behind a 2-min CDN cache), so at most once per 5 min per warm lambda we
// piggyback a small dispatch of due queue rows — no cron needed. The
// in-memory throttle costs nothing between kicks; a cold start kicks once.
let lastSmsKick = 0;
const SMS_KICK_INTERVAL_MS = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  if (Date.now() - lastSmsKick > SMS_KICK_INTERVAL_MS) {
    lastSmsKick = Date.now();
    // Awaited (a frozen lambda kills floating promises) but bounded small so
    // the counter response stays fast on the one request per window that pays.
    await dispatchDueSMS({ maxRows: 5, deadlineMs: 8000 }).catch((e) =>
      console.error("signature-count sms kick:", e.message)
    );
  }
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
