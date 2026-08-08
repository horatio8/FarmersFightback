// Meta ad spend poller + CPA guardrail.
//
// GET /api/cron/ad-insights   (every 30 min; CRON_SECRET or ?token=ADMIN_TOKEN)
//
// 1. Pulls per-ad insights for yesterday + today (daily rows) and per-hour
//    for today (hourly rows) from the Marketing API.
// 2. Counts OUR signups per ad per day from Petition Signatures
//    (meta_ad_id, or utm_campaign carrying the ad id) and computes CPA.
// 3. Upserts everything into the Ad Performance table.
// 4. Guardrail: if an ad's trailing-window spend clears min_spend with no
//    signups or a day CPA above cpa_threshold, records ONE alert per ad per
//    day in Sync State (the dashboard's pop-up feed) and optionally texts.
//    Thresholds live in the Site Stats "econ_settings" row, editable in
//    Airtable with no redeploy. Observability only: nothing pauses ads.
//
// Env: META_AD_ACCOUNT_ID, META_ADS_TOKEN (ads_read).

const { requireCron } = require('../_util');
const econ = require('../../lib/econ/config');
const { select, create, update, upsert, listPage, fesc, sleep } = require('../../lib/social/airtable');

const T = econ.TABLES;

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

async function graph(path, params) {
  const qs = new URLSearchParams({ access_token: econ.adsToken(), ...params });
  const res = await fetch(`${econ.GRAPH}/${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${path}: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  return json;
}

// Melbourne "today"/"yesterday" as YYYY-MM-DD.
function localDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400 * 1000);
  return now.toLocaleDateString('en-CA', { timeZone: econ.ADVERTISER_TZ });
}

function num(v) { return Number(v || 0) || 0; }

function rowFromInsight(i) {
  return {
    ad_id: i.ad_id,
    ad_name: i.ad_name,
    adset_id: i.adset_id,
    campaign_id: i.campaign_id,
    campaign_name: i.campaign_name,
    spend: num(i.spend),
    impressions: num(i.impressions),
    clicks: num(i.clicks),
    meta_leads: num((i.actions || []).find(a => /lead|complete_registration/.test(a.action_type || ''))?.value),
  };
}

// The AD id for a signature. Lead ads carry it directly as meta_ad_id; web
// signups carry it in utm_content — this account's ad links put {{ad.id}} in
// utm_content, the ADSET id in utm_medium and the CAMPAIGN id in utm_campaign.
// utm_campaign is deliberately NOT used here: matching a campaign id against
// ad ids is how the first live run counted only the 93 lead-ad signups and
// reported CPA $8.14 on a day Ads Manager showed $1.22.
function adIdOf(f) {
  if (f.meta_ad_id) return f.meta_ad_id;
  if (/^\d{15,}$/.test(f.utm_content || '')) return f.utm_content;
  return null;
}

// Count signups per (ad_id, date) from Petition Signatures over the window.
async function signupCounts(sinceDate) {
  const counts = {}; // `${date}|${ad}` -> n
  let cursor = null;
  do {
    const page = await listPage(T.SIGNATURES, {
      pageSize: 100,
      filterByFormula: `IS_AFTER({timestamp}, '${sinceDate}T00:00:00.000Z')`,
      fields: ['meta_ad_id', 'utm_content', 'timestamp'],
      ...(cursor ? { offset: cursor } : {}),
    });
    for (const r of page.records || []) {
      const f = r.fields || {};
      const ad = adIdOf(f);
      if (!ad || !f.timestamp) continue;
      const d = new Date(f.timestamp).toLocaleDateString('en-CA', { timeZone: econ.ADVERTISER_TZ });
      counts[`${d}|${ad}`] = (counts[`${d}|${ad}`] || 0) + 1;
    }
    cursor = page.offset || null;
  } while (cursor);
  return counts;
}

async function alreadyAlerted(key) {
  const rows = await select(T.SYNC_STATE, `{key} = '${fesc(key)}'`, null, 1);
  return rows.length > 0;
}

async function markAlerted(key, detail) {
  await create(T.SYNC_STATE, [{ key, value: detail, updated_at: new Date().toISOString() }]);
}

async function sendAlert(message, mobile) {
  if (!mobile) return;
  try {
    const { sendViaCellcast } = require('../_cellcast');
    await sendViaCellcast({ phone: mobile, message });
  } catch (e) {
    console.error('cpa alert sms failed:', e.message);
  }
}

module.exports = async (req, res) => {
  if (!authed(req) && !requireCron(req, res)) return;

  const today = localDate(0);
  const yesterday = localDate(-1);
  const settings = await econ.loadSettings(select);
  const stats = { daily_rows: 0, hourly_rows: 0, alerts: 0 };

  try {
    // ---- 1. Daily insights, yesterday + today ----
    const daily = await graph(`${econ.adAccountId()}/insights`, {
      level: 'ad',
      fields: 'ad_id,ad_name,adset_id,campaign_id,campaign_name,spend,impressions,clicks,actions',
      time_range: JSON.stringify({ since: yesterday, until: today }),
      time_increment: 1,
      limit: 200,
    });

    const signups = await signupCounts(yesterday);

    const dailyRows = (daily.data || []).map(i => {
      const base = rowFromInsight(i);
      const date = i.date_start;
      const n = signups[`${date}|${base.ad_id}`] || 0;
      return {
        perf_id: `${date}|day|${base.ad_id}`,
        date,
        ...base,
        signups: n,
        cpa: n > 0 ? Math.round((base.spend / n) * 100) / 100 : undefined,
        updated_at: new Date().toISOString(),
      };
    });
    for (const r of dailyRows) Object.keys(r).forEach(k => r[k] === undefined && delete r[k]);
    if (dailyRows.length) await upsert(T.AD_PERFORMANCE, dailyRows, ['perf_id']);
    stats.daily_rows = dailyRows.length;

    // ---- 2. Hourly insights, today only ----
    const hourly = await graph(`${econ.adAccountId()}/insights`, {
      level: 'ad',
      fields: 'ad_id,ad_name,adset_id,campaign_id,campaign_name,spend,impressions,clicks,actions',
      breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
      time_range: JSON.stringify({ since: today, until: today }),
      limit: 500,
    });

    const hourlyRows = [];
    const byAd = {}; // ad_id -> [{hour, spend}]
    for (const i of hourly.data || []) {
      const base = rowFromInsight(i);
      const hh = parseInt(String(i.hourly_stats_aggregated_by_advertiser_time_zone || '').slice(0, 2), 10);
      if (Number.isNaN(hh)) continue;
      hourlyRows.push({
        perf_id: `${today}|${hh}|${base.ad_id}`,
        date: today,
        hour: hh,
        ...base,
        updated_at: new Date().toISOString(),
      });
      (byAd[base.ad_id] = byAd[base.ad_id] || []).push({ hour: hh, spend: base.spend, name: base.ad_name });
    }
    if (hourlyRows.length) await upsert(T.AD_PERFORMANCE, hourlyRows, ['perf_id']);
    stats.hourly_rows = hourlyRows.length;

    // ---- 3. Guardrail: trailing-window CPA per ad ----
    const nowHour = parseInt(new Date().toLocaleTimeString('en-GB', { timeZone: econ.ADVERTISER_TZ, hour12: false }).slice(0, 2), 10);
    const winStart = nowHour - settings.window_hours + 1;
    for (const [adId, rows] of Object.entries(byAd)) {
      const windowSpend = rows.filter(r => r.hour >= winStart && r.hour <= nowHour).reduce((s, r) => s + r.spend, 0);
      if (windowSpend < settings.min_spend) continue;
      const todaySignups = signups[`${today}|${adId}`] || 0;
      const daySpend = rows.reduce((s, r) => s + r.spend, 0);
      const dayCpa = todaySignups > 0 ? daySpend / todaySignups : Infinity;
      if (dayCpa <= settings.cpa_threshold) continue;

      const alertKey = `cpa_alert|${today}|${adId}`;
      if (await alreadyAlerted(alertKey)) continue;
      const name = (rows[0].name || adId).slice(0, 40);
      const cpaTxt = todaySignups > 0 ? `$${dayCpa.toFixed(2)}` : 'no signups yet';
      const msg = `Ad too expensive: "${name}" spent $${windowSpend.toFixed(0)} in ${settings.window_hours}h, today CPA ${cpaTxt} (threshold $${settings.cpa_threshold}). Ad id ${adId}.`;
      if (settings.sms_mobile) await sendAlert(msg, settings.sms_mobile);
      await markAlerted(alertKey, msg);
      stats.alerts += 1;
      await sleep(250);
    }

    res.status(200).json({ ok: true, ...stats });
  } catch (e) {
    console.error('ad-insights error:', e);
    res.status(500).json({ ok: false, error: String(e && e.message), ...stats });
  }
};
