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

async function countSignatures(sinceIso) {
  let cursor = null, count = 0;
  do {
    const page = await listPage(T.SIGNATURES, {
      pageSize: 100,
      filterByFormula: `IS_AFTER({timestamp}, '${sinceIso}')`,
      fields: ['signature_id'],
      ...(cursor ? { offset: cursor } : {}),
    });
    count += (page.records || []).length;
    cursor = page.offset || null;
  } while (cursor);
  return count;
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

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      as_at: new Date().toISOString(),
      donations: { last_24h: d24, last_7d: d7 },
      database: {
        signature_count_raw: stats.signature_count?.num_value ?? null,
        new_signatures_24h: sigsToday,
      },
      econ: econSummary,
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
