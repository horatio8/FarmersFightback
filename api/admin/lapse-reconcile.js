// One-off / on-demand retroactive reconcile for the donation-lapse bug.
//
// The lapse system enrolled donors into the CN donation-lapse automation
// whenever the single checkout session it logged wasn't paid — even though
// the donor had paid on a *different* session / Payment Link, or completed
// after the 30-min sweep. Those rows are already "triggered"/"error" and the
// sweep never revisits them, so the donor stays in the drip.
//
// This endpoint walks every triggered/error donation lapse row, checks the
// Donations projection by identity (email/mobile), and for anyone who
// actually donated: applies the CN `donation_completed` tag (the same tag
// the completion beacon uses to exit the automation) and marks the row
// completed. Idempotent — safe to run repeatedly.
//
// Auth: ADMIN_BASIC_AUTH (same as the other admin endpoints).
// Dry-run by default; pass ?commit=yes to actually write.
//   GET /api/admin/lapse-reconcile            → preview (no writes)
//   GET /api/admin/lapse-reconcile?commit=yes → tag + close matched rows

const { listRows, updateRow, findOne } = require("../_airtable");
const { requireBasicAuth } = require("../_util");
const { cnProfileMatch } = require("../_cn");

const LAPSE_TABLE = process.env.AIRTABLE_LAPSE_TABLE || "Lapse Queue";
const DONATIONS_TABLE = process.env.AIRTABLE_DONATIONS_TABLE || "Donations";

function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

// Did this identity actually donate? Match the Donations projection by
// email/mobile, with a 15-min lookback before the abandon row's created_at
// to catch the paid session landing just either side of the abandon.
async function donationCompleted(f) {
  const clauses = [];
  if (f.email) clauses.push(`LOWER({email})='${esc(String(f.email).toLowerCase())}'`);
  if (f.mobile) clauses.push(`{phone}='${esc(f.mobile)}'`);
  if (!clauses.length) return false;
  let cutoff = f.created_at;
  try {
    const t = new Date(f.created_at).getTime();
    if (Number.isFinite(t)) cutoff = new Date(t - 15 * 60 * 1000).toISOString();
  } catch (e) {}
  const hit = await findOne(
    DONATIONS_TABLE,
    `AND(OR(${clauses.join(",")}), IS_AFTER({timestamp}, '${cutoff}'))`
  ).catch(() => null);
  return !!hit;
}

module.exports = async function handler(req, res) {
  if (!requireBasicAuth(req, res)) return;

  const url = new URL(req.url, "http://x");
  const commit = url.searchParams.get("commit") === "yes";

  try {
    const rows = await listRows(LAPSE_TABLE, {
      formula: `AND({form}='donation', OR({status}='triggered',{status}='error'))`,
      sort: [{ field: "created_at", direction: "asc" }],
    });

    const matched = [];
    let checked = 0;
    for (const row of rows) {
      const f = row.fields || {};
      if (!f.email && !f.mobile) continue;
      checked++;
      // eslint-disable-next-line no-await-in-loop
      const donated = await donationCompleted(f);
      if (!donated) continue;
      matched.push({ id: row.id, email: f.email || "", mobile: f.mobile || "" });
      if (commit) {
        // eslint-disable-next-line no-await-in-loop
        await cnProfileMatch({
          email: f.email || undefined,
          mobile: f.mobile || undefined,
          tags: ["donation_completed"],
        }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await updateRow(LAPSE_TABLE, row.id, {
          status: "completed",
          note: "retroactive donation reconcile",
        }).catch(() => {});
      }
    }

    return res.status(200).json({
      ok: true,
      mode: commit ? "committed" : "dry-run",
      total_triggered_or_error: rows.length,
      checked,
      matched: matched.length,
      emails: matched.map((m) => m.email).filter(Boolean),
    });
  } catch (e) {
    console.error("lapse-reconcile:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
