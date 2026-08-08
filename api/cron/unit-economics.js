// Unit economics: acquisition cost per contact, lifetime value, per-ad ROAS,
// and the topline numbers the dashboard reads.
//
// GET /api/cron/unit-economics   (nightly + on demand; CRON_SECRET or ?token=)
//
// Phase A  Acquisition attribution. For contacts whose acquisition fields are
//          blank and whose signature (last 7 days) carries a Meta ad id:
//          acquisition_cost = that ad's spend that day / that ad's signups
//          that day (from Ad Performance daily rows). Organic contacts are
//          left blank, meaning $0.
// Phase B  LTV. For every donation in the last 3 days, recompute the
//          contact's lifetime_donations and net_value.
// Phase C  Per-ad rollup. revenue_attributed = sum of lifetime_donations of
//          contacts acquired by the ad; roas = revenue / all-time spend.
//          Written onto the ad's most recent daily row.
// Phase D  Topline snapshot into Site Stats key "econ_summary".
//
// Everything is idempotent and time-boxed; a re-run redoes no work it has
// already committed except cheap rollups.

const { requireCron } = require('../_util');
const econ = require('../../lib/econ/config');
const { select, create, update, upsert, listPage, fesc } = require('../../lib/social/airtable');

const T = econ.TABLES;
const BUDGET_MS = 50 * 1000;

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400 * 1000).toISOString();
}

function tzDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: econ.ADVERTISER_TZ });
}

module.exports = async (req, res) => {
  if (!authed(req) && !requireCron(req, res)) return;
  const started = Date.now();
  const stats = { attributed: 0, ltv_updates: 0, ads_rolled: 0 };

  try {
    // ---- Phase A: acquisition attribution ----
    // Daily spend/signup grid from Ad Performance.
    const grid = {}; // `${date}|${ad}` -> {spend, signups}
    const adMeta = {}; // ad -> latest daily perf_id
    let cursor = null;
    do {
      const page = await listPage(T.AD_PERFORMANCE, {
        pageSize: 100,
        filterByFormula: `{hour} = BLANK()`,
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const f = r.fields || {};
        if (!f.ad_id || !f.date) continue;
        grid[`${f.date}|${f.ad_id}`] = { spend: f.spend || 0, signups: f.signups || 0 };
        if (!adMeta[f.ad_id] || f.date > adMeta[f.ad_id].date) adMeta[f.ad_id] = { date: f.date, recId: r.id };
      }
      cursor = page.offset || null;
    } while (cursor);

    // Recent ad-attributed signatures -> their contacts.
    cursor = null;
    const contactUpdates = [];
    do {
      const page = await listPage(T.SIGNATURES, {
        pageSize: 100,
        filterByFormula: `AND(IS_AFTER({timestamp}, '${isoDaysAgo(7)}'), OR({meta_ad_id} != '', {utm_campaign} != ''))`,
        fields: ['meta_ad_id', 'utm_campaign', 'timestamp', 'contact'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const f = r.fields || {};
        const ad = f.meta_ad_id || (/^\d{15,}$/.test(f.utm_campaign || '') ? f.utm_campaign : null);
        const cid = Array.isArray(f.contact) && f.contact.length ? f.contact[0].id || f.contact[0] : null;
        if (!ad || !cid || !f.timestamp) continue;
        const day = tzDate(f.timestamp);
        const cell = grid[`${day}|${ad}`];
        const cost = cell && cell.signups > 0 ? Math.round((cell.spend / cell.signups) * 100) / 100 : undefined;
        contactUpdates.push({ cid, ad, day, cost });
      }
      cursor = page.offset || null;
    } while (cursor && Date.now() - started < BUDGET_MS * 0.4);

    // Only fill blanks: fetch in chunks and skip contacts already attributed.
    for (const u of contactUpdates) {
      if (Date.now() - started > BUDGET_MS * 0.5) break;
      const rows = await select(T.CONTACTS, `RECORD_ID() = '${u.cid}'`, ['acquisition_ad_id'], 1);
      if (!rows.length || rows[0].fields.acquisition_ad_id) continue;
      const fields = { acquisition_ad_id: u.ad };
      if (u.cost !== undefined) fields.acquisition_cost = u.cost;
      await update(T.CONTACTS, [{ id: u.cid, fields }]);
      stats.attributed += 1;
    }

    // ---- Phase B: LTV for recently active donors ----
    const recentDonors = new Map(); // contact rec id -> true
    cursor = null;
    do {
      const page = await listPage(T.DONATIONS, {
        pageSize: 100,
        filterByFormula: `IS_AFTER({timestamp}, '${isoDaysAgo(3)}')`,
        fields: ['contact'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const c = (r.fields || {}).contact;
        if (Array.isArray(c) && c.length) recentDonors.set(c[0].id || c[0], true);
      }
      cursor = page.offset || null;
    } while (cursor);

    for (const cid of recentDonors.keys()) {
      if (Date.now() - started > BUDGET_MS * 0.75) break;
      const contact = await select(T.CONTACTS, `RECORD_ID() = '${cid}'`, ['contact_id', 'acquisition_cost'], 1);
      if (!contact.length) continue;
      const uuid = contact[0].fields.contact_id;
      if (!uuid) continue;
      const gifts = await select(
        T.DONATIONS,
        `FIND('${fesc(uuid)}', ARRAYJOIN({contact})) > 0`,
        ['amount_cents']
      );
      const ltv = Math.round(gifts.reduce((s, g) => s + (g.fields.amount_cents || 0), 0)) / 100;
      const net = Math.round((ltv - (contact[0].fields.acquisition_cost || 0)) * 100) / 100;
      await update(T.CONTACTS, [{ id: cid, fields: { lifetime_donations: ltv, net_value: net } }]);
      stats.ltv_updates += 1;
    }

    // ---- Phase C: per-ad revenue + ROAS ----
    const adSpendTotal = {};
    for (const [key, cell] of Object.entries(grid)) {
      const ad = key.split('|')[1];
      adSpendTotal[ad] = (adSpendTotal[ad] || 0) + (cell.spend || 0);
    }
    for (const [ad, meta] of Object.entries(adMeta)) {
      if (Date.now() - started > BUDGET_MS * 0.95) break;
      // Paged, not select(): an ad that acquired more than 100 contacts would
      // otherwise have its revenue truncated at the first page and its ROAS
      // silently understated.
      let revenue = 0;
      let c2 = null;
      do {
        const page = await listPage(T.CONTACTS, {
          pageSize: 100,
          filterByFormula: `{acquisition_ad_id} = '${fesc(ad)}'`,
          fields: ['lifetime_donations'],
          ...(c2 ? { offset: c2 } : {}),
        });
        for (const c of page.records || []) revenue += (c.fields.lifetime_donations || 0);
        c2 = page.offset || null;
      } while (c2);
      revenue = Math.round(revenue * 100) / 100;
      const spendAll = adSpendTotal[ad] || 0;
      const roas = spendAll > 0 ? Math.round((revenue / spendAll) * 100) / 100 : 0;
      await update(T.AD_PERFORMANCE, [{ id: meta.recId, fields: { revenue_attributed: revenue, roas } }]);
      stats.ads_rolled += 1;
    }

    // ---- Phase D: topline snapshot ----
    const today = tzDate(Date.now());
    let spendToday = 0, signupsToday = 0;
    for (const [key, cell] of Object.entries(grid)) {
      if (key.startsWith(today)) { spendToday += cell.spend; signupsToday += cell.signups; }
    }
    const summary = {
      as_at: new Date().toISOString(),
      spend_today: Math.round(spendToday * 100) / 100,
      paid_signups_today: signupsToday,
      cpa_today: signupsToday > 0 ? Math.round((spendToday / signupsToday) * 100) / 100 : null,
      ads_tracked: Object.keys(adMeta).length,
    };
    const existing = await select(T.SITE_STATS, `{key} = 'econ_summary'`, null, 1);
    const fields = { key: 'econ_summary', text_value: JSON.stringify(summary), updated_at: new Date().toISOString() };
    if (existing.length) await update(T.SITE_STATS, [{ id: existing[0].id, fields }]);
    else await create(T.SITE_STATS, [fields]);

    res.status(200).json({ ok: true, ...stats, summary });
  } catch (e) {
    console.error('unit-economics error:', e);
    res.status(500).json({ ok: false, error: String(e && e.message), ...stats });
  }
};
