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

// Meta's own conversion tallies for today, account level, split by action
// type. This is what makes the Ads Manager number reconcilable: "Results" is
// a SUM of distinct action types (on-Facebook lead forms, website pixel
// Leads), and the API hands them to us separately. Best-effort — the
// dashboard renders without it.
async function metaToday() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: econ.ADVERTISER_TZ });
    const qs = new URLSearchParams({
      access_token: econ.adsToken(),
      level: 'account',
      fields: 'spend,actions',
      time_range: JSON.stringify({ since: today, until: today }),
    });
    const r = await fetch(`${econ.GRAPH}/${econ.adAccountId()}/insights?${qs}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.data || !j.data.length) return null;
    const row = j.data[0];
    const actions = {};
    for (const a of row.actions || []) actions[a.action_type] = Number(a.value) || 0;
    // Ads Manager's "Results (Multiple conversions)" for this account is the
    // composite action offsite_complete_registration_add_meta_leads — website
    // CompleteRegistration pixel events PLUS on-Facebook lead forms — NOT the
    // plain 'lead' total. Verified against the Ads Manager row (340 = 286
    // registrations + 55 lead forms while 'lead' read 323). Use the same
    // metric so the panel and Ads Manager quote the same number; fall back to
    // 'lead' if the composite ever disappears.
    const composite = actions['offsite_complete_registration_add_meta_leads'];
    const resultsTotal = composite ?? actions.lead ?? null;
    const leadForms = actions.leadgen_grouped ?? actions['onsite_conversion.lead_grouped'] ?? null;
    return {
      spend: Number(row.spend) || 0,
      results_total: resultsTotal,
      results_metric: composite != null ? 'complete_registration + lead forms' : 'lead',
      on_facebook_lead_forms: leadForms,
      // Derived by subtraction so the two split rows always sum to Results.
      website_conversions:
        resultsTotal != null && leadForms != null
          ? resultsTotal - leadForms
          : actions['offsite_conversion.fb_pixel_complete_registration']
            ?? actions['offsite_conversion.fb_pixel_lead'] ?? null,
      actions,
    };
  } catch (e) {
    console.error('econ-dashboard metaToday failed:', e.message);
    return null;
  }
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
  // Today's signatures bucketed by the strongest Meta evidence each carries,
  // so the totals can be laid against Meta's own action-type split.
  const buckets = {
    lead_ad_form: 0,       // Meta lead ad (meta_ad_id from the leadgen payload)
    web_with_ad_id: 0,     // clicked an ad; link carried the ad id (utm_content)
    web_campaign_only: 0,  // clicked an ad; link carried only the campaign id
    fb_click_no_utm: 0,    // fbclid present but no ad UTMs — a Facebook click,
                           // could be an ad or an organic share
    no_meta_marker: 0,     // nothing tying it to Meta at all
  };
  do {
    const page = await listPage(T.SIGNATURES, {
      pageSize: 100,
      filterByFormula: `IS_AFTER({timestamp}, '${sinceIso < midnight ? sinceIso : midnight}')`,
      fields: ['timestamp', 'meta_ad_id', 'utm_content', 'utm_campaign', 'fbclid'],
      ...(cursor ? { offset: cursor } : {}),
    });
    for (const r of page.records || []) {
      const f = r.fields || {};
      if (f.timestamp >= sinceIso) count += 1;
      if (f.timestamp < midnight) continue;
      const adId = /^\d{15,}$/.test(f.utm_content || '');
      const campId = /^\d{15,}$/.test(f.utm_campaign || '');
      if (f.meta_ad_id) buckets.lead_ad_form += 1;
      else if (adId) buckets.web_with_ad_id += 1;
      else if (campId) buckets.web_campaign_only += 1;
      else if (f.fbclid) buckets.fb_click_no_utm += 1;
      else buckets.no_meta_marker += 1;
      if (f.meta_ad_id || adId || campId) paidToday += 1;
    }
    cursor = page.offset || null;
  } while (cursor);
  return { count, paidToday, buckets };
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'bad token' });

  try {
    const [d24, d7, sigsToday, statRows, alertRows, settings, meta] = await Promise.all([
      sumDonations(isoDaysAgo(1)),
      sumDonations(isoDaysAgo(7)),
      countSignatures(isoDaysAgo(1)),
      select(T.SITE_STATS, `OR({key} = 'signature_count', {key} = 'econ_summary')`, null, 5),
      select(T.SYNC_STATE, `AND(FIND('cpa_alert|', {key}) = 1, IS_AFTER({updated_at}, '${isoDaysAgo(2)}'))`, null, 20),
      econ.loadSettings(select),
      metaToday(),
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

    // Live topline: spend straight from Meta when reachable (real-time, and
    // what Ads Manager shows) rather than the per-ad rows, which are up to 30
    // minutes stale and visibly lag Ads Manager while spend is ramping. Paid
    // signups counted directly from today's signatures.
    const adRowSpend = Math.round(ads.reduce((s, a) => s + (a.spend || 0), 0) * 100) / 100;
    const spendToday = meta && meta.spend != null ? meta.spend : adRowSpend;
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
      // Both sides of the Ads Manager reconciliation: Meta's action-type
      // split for today vs our signatures bucketed by the evidence they carry.
      reconciliation: {
        meta,
        ours: sigsToday.buckets,
        note: 'Meta lead form counts should tie to lead_ad_form within a few. '
          + 'Meta website pixel Leads cover our web buckets PLUS view-through, '
          + 'cross-device and modelled conversions — that remainder is Meta '
          + 'crediting itself for signups our links could not label.',
      },
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
