// Vercel serverless function: a visitor landed on a 404 and pressed
// "Let us know" on the error page. Records which URL failed and where they
// came from, so a dead link in an email, a post or a printed flyer surfaces
// as a report instead of silently costing us the supporter.
//
// Auto-redirecting 404s hides broken links — nobody reports a page that
// quietly forwards. This route is what buys that signal back.
//
// POST /api/report-broken-link
// Body: { path, referrer? }
// Response: { ok } | { error }
//
// Always writes a REPORT line to the runtime log, which is the durable record
// and needs no schema. The Airtable row is best-effort on top of that: if the
// table is absent or the base is rate limited, the report is still captured
// and the visitor still sees a success state.
//
// Env:
//   AIRTABLE_BROKEN_LINKS_TABLE — optional; defaults to "Broken Links".
//                                 Skipped entirely if the table is missing.

const { createRow, nowIso } = require("./_airtable");

const TABLE = process.env.AIRTABLE_BROKEN_LINKS_TABLE || "Broken Links";

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
  "https://farmersfightback-tellerconsulting.vercel.app",
]);
function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

// The path is visitor-controlled and ends up in logs and an Airtable cell.
// Cap the length so a multi-kilobyte URL can't bloat either, and strip control
// characters so it can't forge extra lines in the log output.
function clean(v, max) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const path = clean(body.path, 512);
  if (!path) return res.status(400).json({ error: "path required" });

  const report = {
    path,
    referrer: clean(body.referrer, 512) || null,
    user_agent: clean(req.headers["user-agent"], 256) || null,
    reported_at: nowIso(),
  };

  // The durable record. Greppable in Vercel runtime logs by the prefix.
  console.log("BROKEN_LINK_REPORT " + JSON.stringify(report));

  try {
    await createRow(TABLE, report);
  } catch (e) {
    // A missing table or a rate-limited base must not read to the visitor as
    // "your report failed" — the log line above already captured it.
    console.log("BROKEN_LINK_REPORT airtable write skipped: " + (e && e.message));
  }

  return res.status(200).json({ ok: true });
};
