// GET /api/ab-report (basic auth) — every A/B test's daily rollups plus
// per-variant totals with the primary metric: revenue per 1,000 sends.
// JSON by default; ?html=1 for a scannable table.
// Data written nightly by /api/cron/nightly-rollup into "AB Daily".

const { listRows } = require("./_airtable");
const { requireBasicAuth } = require("./_util");

const AB_DAILY = process.env.AIRTABLE_AB_DAILY_TABLE || "AB Daily";

module.exports = async function handler(req, res) {
  if (!requireBasicAuth(req, res)) return;
  try {
    const rows = await listRows(AB_DAILY, {
      fields: ["row_id", "date", "test", "variant", "sends", "clicks", "gifts", "revenue", "optouts"],
      sort: [{ field: "date", direction: "desc" }],
    });
    const daily = rows.map((r) => {
      const f = r.fields || {};
      return {
        date: f.date, test: f.test?.name || f.test, variant: f.variant?.name || f.variant,
        sends: f.sends || 0, clicks: f.clicks || 0, gifts: f.gifts || 0,
        revenue: f.revenue || 0, optouts: f.optouts || 0,
      };
    });
    const totals = {};
    for (const d of daily) {
      const k = `${d.test}|${d.variant}`;
      const t = (totals[k] = totals[k] || { test: d.test, variant: d.variant, sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 });
      t.sends += d.sends; t.clicks += d.clicks; t.gifts += d.gifts; t.revenue += d.revenue; t.optouts += d.optouts;
    }
    const summary = Object.values(totals).map((t) => ({
      ...t,
      revenue_per_1000_sends: t.sends ? Math.round((t.revenue / t.sends) * 1000 * 100) / 100 : null,
      ctr: t.sends ? Math.round((t.clicks / t.sends) * 10000) / 100 : null,
      conversion_pct: t.clicks ? Math.round((t.gifts / t.clicks) * 10000) / 100 : null,
      avg_gift: t.gifts ? Math.round((t.revenue / t.gifts) * 100) / 100 : null,
      optout_pct: t.sends ? Math.round((t.optouts / t.sends) * 10000) / 100 : null,
    })).sort((a, b) => (a.test + a.variant).localeCompare(b.test + b.variant));

    const url = new URL(req.url, "https://x");
    if (url.searchParams.get("html")) {
      const cell = (v) => (v === null || v === undefined ? "—" : v);
      const trs = summary.map((s) =>
        `<tr><td>${s.test}</td><td><b>${s.variant}</b></td><td>${s.sends}</td><td>${s.clicks}</td><td>${s.gifts}</td><td>$${s.revenue.toFixed(2)}</td><td><b>${cell(s.revenue_per_1000_sends)}</b></td><td>${cell(s.ctr)}%</td><td>${cell(s.optout_pct)}%</td></tr>`).join("");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>FF A/B report</title>
<style>body{font:14px/1.5 system-ui;margin:24px;color:#12354B}table{border-collapse:collapse;width:100%;max-width:960px}th,td{border:1px solid #ddd;padding:6px 10px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{background:#12354B;color:#fff}</style>
<h2>A/B summary (all time)</h2><p>Primary metric: <b>revenue per 1,000 sends</b>. Decision gate: 2,000 sends per cell or 14 days.</p>
<table><tr><th>Test</th><th>Var</th><th>Sends</th><th>Clicks</th><th>Gifts</th><th>Revenue</th><th>$/1k sends</th><th>CTR</th><th>Opt-out</th></tr>${trs}</table>
<p>${daily.length} daily rows. JSON: remove ?html=1.</p>`);
    }
    return res.status(200).json({ summary, daily });
  } catch (e) {
    console.error("ab-report:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
