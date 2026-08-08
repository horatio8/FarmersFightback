// JSON feed for the campaign economics dashboard (/admin/econ.html).
//
// GET /api/admin/econ-dashboard?token=ADMIN_TOKEN
//
// Returns near-real-time toplines plus today's per-ad table:
//   donations: last 24h and last 7d (sum + count) straight from Donations
//   database:  total signature count (Site Stats), new signups today
//   ads:       today's daily rows from Ad Performance (spend, signups, CPA,
//              ROAS) plus the econ_summary snapshot
//   settings:  the live econ_settings thresholds
//   alerts:    cpa_alert rows from the last 48h (the pop-up feed)
//
// Reads only. Cheap enough to poll every 60s.

const econ = require('../../lib/econ/config');
const { select, listPage } = require('../../lib/social/airtable');

const T = econ.TABLES;

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400 * 1000).toISOString();
}

async function sumDonations(sinceIso) {
  let cursor = null, total = 0, count = 0;
  do {
    const page = await listPage(T.DONATIONS, {
      pageSize: 100,
      filterByFormula: `IS_AFTER({timestamp}, '${sinceIso}')`,
      fields: ['amount_cents'],
      ...(cursor ? { offset: cursor } : {}),
    });
    for (const r of page.records || []) { total += (r.fields.amount_cents || 0) / 100; count += 1; }
    cursor = page.offset || null;
  } while (cursor);
  return { total: Math.round(total * 100) / 100, count };
}

// The UTC instant of local midnight in the advertiser timezone, so "today's"
// signup counts line up with Ads Manager's "today" rather than a trailing 24h.
function tzMidnightUtcIso(tz) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  for (let m = -14 * 60; m <= 12 * 60; m += 30) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) + m * 60000);
    if (d.toLocaleString('sv-SE', { timeZone: tz }).startsWith(`${today} 00:00`)) return d.toISOString();
  }
  return `${today}T00:00:00.000Z`;
}

// One walk over recent signatures: total in the window, plus how many since
// local midnight came from a Meta ad at all. "Paid" is deliberately broad —
// lead-ad id, ad id in utm_content, or campaign id in utm_campaign — because
// the topline question is "how many signups did paid buy today", not which ad.
async function countSignatures(sinceIso) {
  const midnight = tzMidnightUtcIso(econ.ADVERTISER_TZ);
  let cursor = null, count = 0, paidToday = 0;
  do {
    const page = await listPage(T.SIGNATURES, {
      pageSize: 100,
      filterByFormula: `IS_AFTER({timestamp}, '${sinceIso < midnight ? sinceIso : midnight}')`,
      fields: ['timestamp', 'meta_ad_id', 'utm_content', 'utm_campaign'],
      ...(cursor ? { offset: cursor } : {}),
    });
    for (const r of page.records || []) {
      const f = r.fields || {};
      if (f.timestamp >= sinceIso) count += 1;
      const paid = f.meta_ad_id || /^\d{15,}$/.test(f.utm_content || '') || /^\d{15,}$/.test(f.utm_campaign || '');
      if (paid && f.timestamp >= midnight) paidToday += 1;
    }
    cursor = page.offset || null;
  } while (cursor);
  return { count, paidToday };
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'bad token' });

  try {
    const [d24, d7, sigsToday, statRows, alertRows, settings] = await Promise.all([
      sumDonations(isoDaysAgo(1)),
      sumDonations(isoDaysAgo(7)),
      countSignatures(isoDaysAgo(1)),
      select(T.SITE_STATS, `OR({key} = 'signature_count', {key} = 'econ_summary')`, null, 5),
      select(T.SYNC_STATE, `AND(FIND('cpa_alert|', {key}) = 1, IS_AFTER({updated_at}, '${isoDaysAgo(2)}'))`, null, 20),
      econ.loadSettings(select),
    ]);

    const stats = {};
    for (const r of statRows) stats[r.fields.key] = r.fields;

    let econSummary = null;
    try { econSummary = JSON.parse(stats.econ_summary?.text_value || 'null'); } catch {}

    // Today's per-ad daily rows. IS_SAME, not '=': an Airtable date FIELD
    // never string-equals 'YYYY-MM-DD', so the plain comparison silently
    // returned zero rows and the ads table rendered empty (seen live).
    const today = new Date().toLocaleDateString('en-CA', { timeZone: econ.ADVERTISER_TZ });
    const adRows = await select(
      T.AD_PERFORMANCE,
      `AND(IS_SAME({date}, '${today}', 'day'), {hour} = BLANK())`,
      ['ad_id', 'ad_name', 'campaign_name', 'spend', 'impressions', 'clicks', 'signups', 'cpa', 'revenue_attributed', 'roas']
    );
    const ads = adRows
      .map(r => r.fields)
      .sort((a, b) => (b.spend || 0) - (a.spend || 0));

    // Live topline: spend from the freshest per-ad rows (≤30 min old), paid
    // signups counted directly from today's signatures. This supersedes the
    // nightly econ_summary snapshot, which only knew per-AD attribution and
    // so undercounted web signups until utm_content data accrues.
    const spendToday = Math.round(ads.reduce((s, a) => s + (a.spend || 0), 0) * 100) / 100;
    const liveEcon = {
      ...(econSummary || {}),
      spend_today: spendToday,
      paid_signups_today: sigsToday.paidToday,
      cpa_today: sigsToday.paidToday > 0 ? Math.round((spendToday / sigsToday.paidToday) * 100) / 100 : null,
      ads_tracked: ads.length,
      as_at: new Date().toISOString(),
    };

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      as_at: new Date().toISOString(),
      donations: { last_24h: d24, last_7d: d7 },
      database: {
        signature_count_raw: stats.signature_count?.num_value ?? null,
        new_signatures_24h: sigsToday.count,
      },
      econ: liveEcon,
      ads_today: ads,
      settings,
      alerts: alertRows
        .map(r => ({ key: r.fields.key, message: r.fields.value, at: r.fields.updated_at }))
        .sort((a, b) => (b.at || '').localeCompare(a.at || '')),
    });
  } catch (e) {
    console.error('econ-dashboard error:', e);
    res.status(500).json({ error: String(e && e.message) });
  }
};
