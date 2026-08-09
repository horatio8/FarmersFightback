// Unit economics: acquisition cost per contact, lifetime value, per-ad ROAS,
// and the topline numbers the dashboard reads.
//
// GET /api/cron/unit-economics            (nightly + on demand)
//     ?days=N     Phase A attribution lookback (default 7; use a large value
//                 to backfill historical lead-ad signatures, which carry
//                 meta_ad_id all the way back)
//   Auth: CRON_SECRET or ?token=ADMIN_TOKEN.
//
// Phase A  Acquisition attribution. Contacts whose signature carries a Meta
//          AD id (meta_ad_id from lead ads, or utm_content on web signups)
//          get acquisition_ad_id + acquisition_cost. Only blanks are filled;
//          already-attributed contacts are skipped via one cheap prefetch, so
//          repeated runs converge on a big backfill without cursors.
// Phase B  LTV contact fields. For donors active in the last 3 days,
//          recompute lifetime_donations and net_value on the contact.
// Phase C  Per-ad revenue + ROAS, derived FROM SOURCE each run: one pass over
//          all Donations aggregated by contact, joined to attributed
//          contacts. Deliberately does NOT read lifetime_donations — that
//          field is only maintained incrementally, and revenue must not
//          depend on a backfill having happened.
// Phase D  Topline snapshot into Site Stats key "econ_summary".

const { requireCron } = require('../_util');
const econ = require('../../lib/econ/config');
const { select, create, update, listPage, fesc } = require('../../lib/social/airtable');

const T = econ.TABLES;
const BUDGET_MS = 280 * 1000; // maxDuration 300 in vercel.json

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

function contactRecId(f) {
  const c = f.contact;
  return Array.isArray(c) && c.length ? (c[0].id || c[0]) : null;
}

// Acquisition channel for a donation-only contact, from their earliest
// donation's Stripe payload — checkout has always carried the landing UTMs in
// metadata, so this reaches the ~2,000 donors who never signed a petition and
// therefore have no signature to classify from.
function channelFromDonationPayload(str) {
  try {
    const p = JSON.parse(str || '{}');
    const md = (p.raw && p.raw.metadata) || {};
    const paid = /^\d{15,}$/.test(String(md.utm_content || ''))
      || /^\d{15,}$/.test(String(md.utm_campaign || ''))
      || String(md.utm_source || '').toLowerCase() === 'fb_ads';
    if (paid) return 'Meta ad';
    if (p.fbclid || md.fbclid) return 'Meta organic';
    if (md.ref || p.ref) return 'Referral';
    if (md.utm_source) return 'Other';
    return 'Direct';
  } catch { return 'Direct'; }
}

// First-touch acquisition channel from a signature's markers, strongest
// evidence first. "Meta ad" is any PAID marker; a Facebook click without one
// is organic reach (a share, a page post), which is exactly the split the
// campaign wants to see.
const META_ORGANIC_SOURCES = new Set(['ig', 'fb', 'facebook', 'instagram', 'meta', 'social']);
function channelOf(f) {
  const paid = f.meta_ad_id
    || /^\d{15,}$/.test(f.utm_content || '')
    || /^\d{15,}$/.test(f.utm_campaign || '')
    || String(f.utm_source || '').toLowerCase() === 'fb_ads';
  if (paid) return 'Meta ad';
  if (f.fbclid || META_ORGANIC_SOURCES.has(String(f.utm_source || '').toLowerCase())) return 'Meta organic';
  if (f.ref_used) return 'Referral';
  if (f.utm_source) return 'Other';
  return 'Direct';
}

module.exports = async (req, res) => {
  if (!authed(req) && !requireCron(req, res)) return;
  const started = Date.now();
  const days = Math.min(Number((req.query && req.query.days) || 0) || 7, 1000);
  // ?boost=classify devotes nearly the whole run to channel classification
  // and returns after it — for driving the historical backfill at ~10x the
  // nightly pace. The cron runs the full pipeline (no boost).
  const boost = ((req.query && req.query.boost) || '') === 'classify';
  const CB = boost ? [0.45, 0.6, 0.96] : [0.6, 0.65, 0.7];
  const stats = { attributed: 0, skipped_attributed: 0, ltv_updates: 0, ads_rolled: 0 };

  try {
    // ---- Ad Performance daily grid (spend + signups per ad per day) ----
    const grid = {}; // `${date}|${ad}` -> {spend, signups}
    const adMeta = {}; // ad -> latest daily row
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
    } while (cursor && !boost);

    // ---- Who is already attributed (also reused by Phase C) ----
    const acquiredBy = new Map(); // contact rec id -> ad id
    cursor = null;
    do {
      const page = await listPage(T.CONTACTS, {
        pageSize: 100,
        filterByFormula: `{acquisition_ad_id} != ''`,
        fields: ['acquisition_ad_id'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) acquiredBy.set(r.id, (r.fields || {}).acquisition_ad_id);
      cursor = page.offset || null;
    } while (cursor && !boost && Date.now() - started < BUDGET_MS * 0.2);

    // ---- Phase A: attribute un-attributed contacts from their signatures ----
    cursor = null;
    const pending = new Map(); // contact rec id -> {ad, cost}
    do {
      const page = await listPage(T.SIGNATURES, {
        pageSize: 100,
        filterByFormula: `AND(IS_AFTER({timestamp}, '${isoDaysAgo(days)}'), OR({meta_ad_id} != '', {utm_content} != ''))`,
        fields: ['meta_ad_id', 'utm_content', 'timestamp', 'contact'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const f = r.fields || {};
        // AD id only: meta_ad_id (lead ads) or a numeric utm_content (web).
        // utm_campaign holds the CAMPAIGN id and must never land here.
        const ad = f.meta_ad_id || (/^\d{15,}$/.test(f.utm_content || '') ? f.utm_content : null);
        const cid = contactRecId(f);
        if (!ad || !cid || !f.timestamp) continue;
        if (acquiredBy.has(cid)) { stats.skipped_attributed += 1; continue; }
        if (pending.has(cid)) continue; // first signature seen wins
        const cell = grid[`${tzDate(f.timestamp)}|${ad}`];
        const cost = cell && cell.signups > 0 ? Math.round((cell.spend / cell.signups) * 100) / 100 : undefined;
        pending.set(cid, { ad, cost });
      }
      cursor = page.offset || null;
    } while (cursor && !boost && Date.now() - started < BUDGET_MS * 0.35);

    // Batched writes (update() batches 10 per request internally). Budgeted:
    // whatever doesn't fit is picked up by the next run, because the
    // attributed prefetch will skip everything written here.
    const items = Array.from(pending.entries()).map(([id, u]) => ({
      id,
      fields: { acquisition_ad_id: u.ad, ...(u.cost !== undefined ? { acquisition_cost: u.cost } : {}) },
    }));
    for (let i = 0; i < items.length; i += 10) {
      if (Date.now() - started > BUDGET_MS * 0.55) break;
      const batch = items.slice(i, i + 10);
      await update(T.CONTACTS, batch);
      for (const b of batch) acquiredBy.set(b.id, b.fields.acquisition_ad_id);
      stats.attributed += batch.length;
    }

    // ---- Channel classification: first-touch, watermark-resumable ----
    // Walks signatures oldest-first from a Sync State watermark, classifying
    // each contact's channel from the FIRST signature seen for them. Only
    // blanks are written (checked in batched reads), so re-runs converge as a
    // backfill and the nightly run just processes the day's new signatures.
    stats.classified = 0;
    const wmKey = 'contact_channel_watermark';
    const wmRows = await select(T.SYNC_STATE, `{key} = '${wmKey}'`, null, 1);
    let watermark = wmRows.length ? (wmRows[0].fields.value || '2000-01-01T00:00:00.000Z') : '2000-01-01T00:00:00.000Z';
    const chanPending = new Map(); // contact rec id -> channel
    cursor = null;
    let lastTs = watermark;
    do {
      const page = await listPage(T.SIGNATURES, {
        pageSize: 100,
        filterByFormula: `IS_AFTER({timestamp}, '${watermark}')`,
        fields: ['timestamp', 'contact', 'meta_ad_id', 'utm_content', 'utm_campaign', 'utm_source', 'fbclid', 'ref_used'],
        'sort[0][field]': 'timestamp',
        'sort[0][direction]': 'asc',
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const f = r.fields || {};
        const cid = contactRecId(f);
        if (f.timestamp) lastTs = f.timestamp;
        if (!cid || chanPending.has(cid)) continue;
        chanPending.set(cid, channelOf(f));
      }
      cursor = page.offset || null;
    } while (cursor && Date.now() - started < BUDGET_MS * CB[0]);

    // Write blanks only: read current channel in batches of 50, then batch
    // update the ones still empty.
    const chanIds = Array.from(chanPending.keys());
    const chanItems = [];
    let checkedAll = true;
    for (let i = 0; i < chanIds.length; i += 50) {
      if (Date.now() - started > BUDGET_MS * CB[1]) { checkedAll = false; break; }
      const slice = chanIds.slice(i, i + 50);
      const formula = `OR(${slice.map((id) => `RECORD_ID() = '${id}'`).join(',')})`;
      const rows = await select(T.CONTACTS, formula, ['acquisition_channel'], 50);
      const have = new Map(rows.map((r) => [r.id, (r.fields || {}).acquisition_channel]));
      for (const id of slice) {
        const cur = have.get(id);
        if (!cur) chanItems.push({ id, fields: { acquisition_channel: chanPending.get(id) } });
      }
    }
    let chanWritten = 0;
    for (let i = 0; i < chanItems.length; i += 10) {
      if (Date.now() - started > BUDGET_MS * CB[2]) break;
      await update(T.CONTACTS, chanItems.slice(i, i + 10));
      chanWritten += Math.min(10, chanItems.length - i);
    }
    stats.classified = chanWritten;
    // Advance the watermark only when this run drained everything it walked —
    // including having CHECKED every pending contact, not just written the
    // checked ones. Without the checkedAll guard, a run that walked to the end
    // but ran out of check budget advanced the watermark past tens of
    // thousands of contacts, permanently skipping them (seen on the first
    // live backfill). Rewrites are blanks-only, so reprocessing is safe.
    const drained = !cursor && checkedAll && chanWritten >= chanItems.length;
    if (drained && lastTs > watermark) {
      const fieldsWm = { key: wmKey, value: lastTs, updated_at: new Date().toISOString() };
      if (wmRows.length) await update(T.SYNC_STATE, [{ id: wmRows[0].id, fields: fieldsWm }]);
      else await create(T.SYNC_STATE, [fieldsWm]);
    }
    stats.classify_done = drained;

    if (boost) {
      return res.status(200).json({
        ok: true,
        boost: 'classify',
        classified: stats.classified,
        classify_done: drained,
        walked_to: lastTs,
      });
    }

    // ---- One pass over ALL donations, aggregated by contact ----
    // Also keeps each donor's EARLIEST donation payload, so donation-only
    // contacts (no signature) can still be channel-classified below.
    const donationsByContact = new Map(); // contact rec id -> cents
    const earliestDonation = new Map(); // contact rec id -> {ts, payload}
    cursor = null;
    do {
      const page = await listPage(T.DONATIONS, {
        pageSize: 100,
        fields: ['contact', 'amount_cents', 'timestamp', 'payload'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const f = r.fields || {};
        const cid = contactRecId(f);
        if (!cid) continue;
        donationsByContact.set(cid, (donationsByContact.get(cid) || 0) + (f.amount_cents || 0));
        const prev = earliestDonation.get(cid);
        if (!prev || String(f.timestamp || '') < prev.ts) {
          earliestDonation.set(cid, { ts: String(f.timestamp || ''), payload: f.payload });
        }
      }
      cursor = page.offset || null;
    } while (cursor && Date.now() - started < BUDGET_MS * 0.8);

    // ---- Phase B: refresh contact LTV fields for recently active donors ----
    const recent = new Set();
    cursor = null;
    do {
      const page = await listPage(T.DONATIONS, {
        pageSize: 100,
        filterByFormula: `IS_AFTER({timestamp}, '${isoDaysAgo(3)}')`,
        fields: ['contact'],
        ...(cursor ? { offset: cursor } : {}),
      });
      for (const r of page.records || []) {
        const cid = contactRecId(r.fields || {});
        if (cid) recent.add(cid);
      }
      cursor = page.offset || null;
    } while (cursor);

    const ltvItems = [];
    for (const cid of recent) {
      const ltv = Math.round(donationsByContact.get(cid) || 0) / 100;
      ltvItems.push({ id: cid, fields: { lifetime_donations: ltv } });
    }
    for (let i = 0; i < ltvItems.length; i += 10) {
      if (Date.now() - started > BUDGET_MS * 0.85) break;
      await update(T.CONTACTS, ltvItems.slice(i, i + 10));
      stats.ltv_updates += Math.min(10, ltvItems.length - i);
    }

    // ---- Phase C: per-ad revenue + ROAS, from source ----
    const revenueByAd = {};
    for (const [cid, ad] of acquiredBy) {
      const cents = donationsByContact.get(cid);
      if (cents) revenueByAd[ad] = (revenueByAd[ad] || 0) + cents;
    }
    const adSpendTotal = {};
    for (const [key, cell] of Object.entries(grid)) {
      const ad = key.split('|')[1];
      adSpendTotal[ad] = (adSpendTotal[ad] || 0) + (cell.spend || 0);
    }
    for (const [ad, meta] of Object.entries(adMeta)) {
      if (Date.now() - started > BUDGET_MS * 0.95) break;
      const revenue = Math.round(revenueByAd[ad] || 0) / 100;
      const spendAll = adSpendTotal[ad] || 0;
      const roas = spendAll > 0 ? Math.round((revenue / spendAll) * 100) / 100 : 0;
      await update(T.AD_PERFORMANCE, [{ id: meta.recId, fields: { revenue_attributed: revenue, roas } }]);
      stats.ads_rolled += 1;
    }

    // ---- Revenue by acquisition channel: every donor's all-time giving,
    // grouped by how we first acquired them. Donor channels read in batches
    // of 50, so cost scales with donors, not the whole contact base. ----
    const revByChannel = {}; // channel -> {donors, cents}
    const donorChanWrites = [];
    const donorIds = Array.from(donationsByContact.keys());
    for (let i = 0; i < donorIds.length; i += 50) {
      if (Date.now() - started > BUDGET_MS * 0.92) break;
      const slice = donorIds.slice(i, i + 50);
      const formula = `OR(${slice.map((id) => `RECORD_ID() = '${id}'`).join(',')})`;
      const rows = await select(T.CONTACTS, formula, ['acquisition_channel'], 50);
      const chanById = new Map(rows.map((r) => {
        const c = (r.fields || {}).acquisition_channel;
        return [r.id, (c && c.name) || c || null];
      }));
      for (const id of slice) {
        let ch = chanById.get(id) || null;
        // Donation-only contact: no signature ever classified them. Take the
        // channel from their earliest donation's checkout payload and persist
        // it, so this lane also converges to zero over time.
        if (!ch) {
          const ed = earliestDonation.get(id);
          ch = ed ? channelFromDonationPayload(ed.payload) : 'Unclassified';
          if (ed) donorChanWrites.push({ id, fields: { acquisition_channel: ch } });
        }
        const b = revByChannel[ch] || { donors: 0, total: 0 };
        b.donors += 1;
        b.total += (donationsByContact.get(id) || 0);
        revByChannel[ch] = b;
      }
    }
    for (const b of Object.values(revByChannel)) b.total = Math.round(b.total) / 100;
    for (let i = 0; i < donorChanWrites.length; i += 10) {
      if (Date.now() - started > BUDGET_MS * 0.94) break;
      await update(T.CONTACTS, donorChanWrites.slice(i, i + 10));
      stats.classified += Math.min(10, donorChanWrites.length - i);
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
      attributed_contacts: acquiredBy.size,
      revenue_by_channel: revByChannel,
    };
    const existing = await select(T.SITE_STATS, `{key} = 'econ_summary'`, null, 1);
    const fields = { key: 'econ_summary', text_value: JSON.stringify(summary), updated_at: new Date().toISOString() };
    if (existing.length) await update(T.SITE_STATS, [{ id: existing[0].id, fields }]);
    else await create(T.SITE_STATS, [fields]);

    res.status(200).json({ ok: true, ...stats, pending_unwritten: Math.max(0, items.length - stats.attributed), summary });
  } catch (e) {
    console.error('unit-economics error:', e);
    res.status(500).json({ ok: false, error: String(e && e.message), ...stats });
  }
};
