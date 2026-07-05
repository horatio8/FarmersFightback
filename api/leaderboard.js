// GET /leaderboard (basic auth; rewritten from /leaderboard in vercel.json)
// Internal referrer leaderboard from the nightly Referral Rollup: signups,
// donations, dollars per referral code. ?json=1 for raw data.

const { listRows, findContactByReferralCode } = require("./_airtable");
const { requireBasicAuth } = require("./_util");

const ROLLUP = process.env.AIRTABLE_REFERRAL_ROLLUP_TABLE || "Referral Rollup";

module.exports = async function handler(req, res) {
  if (!requireBasicAuth(req, res)) return;
  try {
    const rows = await listRows(ROLLUP, {
      fields: ["code", "referrer_name", "signups", "donations", "dollars", "updated_at"],
    });
    const board = rows.map((r) => r.fields || {})
      .sort((a, b) => (b.dollars || 0) - (a.dollars || 0) || (b.signups || 0) - (a.signups || 0))
      .slice(0, 100);

    // Fill in up to 10 missing referrer names per view (kept cheap).
    let lookups = 0;
    for (const b of board) {
      if (b.referrer_name || lookups >= 10) continue;
      lookups++;
      // eslint-disable-next-line no-await-in-loop
      const c = await findContactByReferralCode(b.code).catch(() => null);
      if (c) b.referrer_name = `${c.fields.first_name || ""} ${c.fields.last_name || ""}`.trim();
    }

    const url = new URL(req.url, "https://x");
    if (url.searchParams.get("json")) return res.status(200).json({ board });

    const trs = board.map((b, i) =>
      `<tr><td>${i + 1}</td><td>${b.code}</td><td>${b.referrer_name || ""}</td><td>${b.signups || 0}</td><td>${b.donations || 0}</td><td>$${(b.dollars || 0).toFixed(2)}</td></tr>`).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>FF referrer leaderboard</title>
<style>body{font:14px/1.5 system-ui;margin:24px;color:#12354B}table{border-collapse:collapse;width:100%;max-width:760px}th,td{border:1px solid #ddd;padding:6px 10px;text-align:right}td:nth-child(2),td:nth-child(3){text-align:left}th{background:#12354B;color:#fff}</style>
<h2>Referrer leaderboard</h2><p>Recruited signups, donations and dollars per referral code. Updated nightly.</p>
<table><tr><th>#</th><th>Code</th><th>Referrer</th><th>Signups</th><th>Donations</th><th>Dollars</th></tr>${trs}</table>`);
  } catch (e) {
    console.error("leaderboard:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
