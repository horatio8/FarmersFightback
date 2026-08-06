// GET /api/admin/social-dashboard  (basic auth; ?json=1 for raw data)
//
// The social listening read-out: how people are responding to the campaign.
//   - headline counts and sentiment mix for the window
//   - a day-by-day trend strip drawn from Social Daily
//   - stance mix (supporters vs opponents vs undecided)
//   - what people are talking about
//   - who needs a human (escalation flags)
//   - most engaged people, with their contact where we know it
//
// ?days=N to widen the window (default 30).
//
// Every interpolated value is HTML-escaped. Names and message text here come
// from the public — a commenter picks their own display name — so unescaped
// output would run in the admin's authenticated session.

const { requireBasicAuth } = require('../_util');
const { TABLES } = require('../../lib/social/config');
const { listPage, select, fesc } = require('../../lib/social/airtable');
const { zernio } = require('../../lib/social/zernio');

const DAILY_TABLE = process.env.AIRTABLE_SOCIAL_DAILY_TABLE || 'Social Daily';

// X (Twitter) is the one platform Zernio meters per API call, passed through
// at X's own rates. Analytics + inbox sync were switched on 2026-08-06, so the
// owner wants running visibility of what that costs. Best-effort: the
// dashboard must still render if the usage endpoint is down.
async function xSpend() {
  try {
    const out = await zernio('GET', '/usage', null, { range: 'cycle', granularity: 'day' });
    if (!out || out.supported === false || !Array.isArray(out.days)) return null;
    const total = (out.totals && out.totals.xApi) || 0;
    const last = out.days.length ? out.days[out.days.length - 1] : null;
    return {
      cycle_total_usd: Math.round(total * 100) / 100,
      avg_per_day_usd: out.days.length ? Math.round((total / out.days.length) * 1000) / 1000 : 0,
      latest_day_usd: last ? Math.round((last.xApi || 0) * 1000) / 1000 : 0,
      cycle_days: out.days.length,
      period_start: (out.period && out.period.start) || null,
    };
  } catch (e) {
    console.error('social-dashboard x-spend fetch failed:', e.message);
    return null;
  }
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function sel(v) { return v && v.name ? v.name : v; }

// Inline bar so the trend reads at a glance without a charting library.
function bar(value, max, colour) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="bar"><span style="width:${pct}%;background:${colour}"></span></div>`;
}

module.exports = async (req, res) => {
  if (!requireBasicAuth(req, res)) return;

  const url = new URL(req.url, 'https://x');
  const days = Math.min(Number(url.searchParams.get('days') || 30), 365);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  try {
    // Daily trend rows
    const daily = await select(
      DAILY_TABLE,
      `IS_AFTER({date}, '${fesc(sinceIso)}')`,
      ['date', 'platform', 'messages', 'positive', 'neutral', 'negative', 'sentiment_avg',
       'supporters', 'opponents', 'undecided', 'escalations', 'top_topics'],
      1000
    );

    // Totals across the window
    const tot = {
      messages: 0, positive: 0, neutral: 0, negative: 0,
      supporters: 0, opponents: 0, undecided: 0, escalations: 0,
      scoreSum: 0, scoreDays: 0,
    };
    const byDate = new Map();
    const topicTally = {};
    for (const r of daily) {
      const f = r.fields || {};
      tot.messages += f.messages || 0;
      tot.positive += f.positive || 0;
      tot.neutral += f.neutral || 0;
      tot.negative += f.negative || 0;
      tot.supporters += f.supporters || 0;
      tot.opponents += f.opponents || 0;
      tot.undecided += f.undecided || 0;
      tot.escalations += f.escalations || 0;
      if (typeof f.sentiment_avg === 'number' && f.messages) {
        tot.scoreSum += f.sentiment_avg * f.messages;
        tot.scoreDays += f.messages;
      }
      const d = f.date;
      if (d) {
        const cur = byDate.get(d) || { date: d, messages: 0, positive: 0, negative: 0, neutral: 0, escalations: 0, scoreSum: 0, scored: 0 };
        cur.messages += f.messages || 0;
        cur.positive += f.positive || 0;
        cur.negative += f.negative || 0;
        cur.neutral += f.neutral || 0;
        cur.escalations += f.escalations || 0;
        if (typeof f.sentiment_avg === 'number' && f.messages) { cur.scoreSum += f.sentiment_avg * f.messages; cur.scored += f.messages; }
        byDate.set(d, cur);
      }
      String(f.top_topics || '').split('\n').forEach((line) => {
        const m = line.match(/^(.*)\s\((\d+)\)$/);
        if (m) topicTally[m[1]] = (topicTally[m[1]] || 0) + Number(m[2]);
      });
    }
    const overallAvg = tot.scoreDays ? (tot.scoreSum / tot.scoreDays) : 0;

    // Who needs a human
    const flagged = await select(
      TABLES.IDENTITIES,
      `{needs_attention} = 1`,
      ['identity_key', 'display_name', 'platform', 'stance_dominant', 'sentiment_avg', 'engagement_score', 'contact'],
      50
    );

    // Most engaged people
    const engagedPage = await listPage(TABLES.IDENTITIES, {
      filterByFormula: `{engagement_score} > 0`,
      fields: ['identity_key', 'display_name', 'platform', 'stance_dominant', 'sentiment_avg', 'engagement_score', 'interaction_count', 'contact'],
      pageSize: 100,
      sort: [{ field: 'engagement_score', direction: 'desc' }],
    });
    const engaged = (engagedPage.records || []).slice(0, 25);

    const x = await xSpend();

    if (url.searchParams.get('json')) {
      return res.status(200).json({
        window_days: days,
        totals: tot,
        sentiment_avg: Math.round(overallAvg * 100) / 100,
        topics: topicTally,
        needs_attention: flagged.map((r) => r.fields),
        most_engaged: engaged.map((r) => r.fields),
        x_api_spend: x,
      });
    }

    const dates = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
    const maxDay = Math.max(1, ...dates.map((d) => d.messages));

    const trendRows = dates.map((d) => {
      const avg = d.scored ? d.scoreSum / d.scored : 0;
      const tone = avg > 0.15 ? '#2e7d32' : avg < -0.15 ? '#c62828' : '#8a8a8a';
      return `<tr><td>${esc(d.date)}</td><td class="n">${d.messages}</td>
        <td>${bar(d.messages, maxDay, tone)}</td>
        <td class="n" style="color:${tone}">${avg.toFixed(2)}</td>
        <td class="n pos">${d.positive}</td><td class="n">${d.neutral}</td><td class="n neg">${d.negative}</td>
        <td class="n">${d.escalations ? `<b>${d.escalations}</b>` : ''}</td></tr>`;
    }).join('');

    const topicRows = Object.entries(topicTally).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([t, n]) => `<tr><td>${esc(t)}</td><td class="n">${n}</td></tr>`).join('')
      || '<tr><td colspan="2" class="muted">No topics yet.</td></tr>';

    const flagRows = flagged.map((r) => {
      const f = r.fields || {};
      return `<tr><td>${esc(f.display_name || '(unknown)')}</td><td>${esc(sel(f.platform))}</td>
        <td>${esc(sel(f.stance_dominant) || '')}</td>
        <td class="n">${f.sentiment_avg != null ? Number(f.sentiment_avg).toFixed(2) : ''}</td>
        <td>${f.contact && f.contact.length ? 'yes' : '<span class="muted">no</span>'}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">Nothing flagged. (Flags are high-confidence only.)</td></tr>';

    const engagedRows = engaged.map((r) => {
      const f = r.fields || {};
      const st = esc(sel(f.stance_dominant) || '');
      const cls = st === 'Supporter' ? 'pos' : st === 'Opponent' ? 'neg' : '';
      return `<tr><td>${esc(f.display_name || f.identity_key || '')}</td>
        <td>${esc(sel(f.platform))}</td>
        <td class="${cls}">${st}</td>
        <td class="n">${f.interaction_count || 0}</td>
        <td class="n">${f.sentiment_avg != null ? Number(f.sentiment_avg).toFixed(2) : ''}</td>
        <td class="n"><b>${f.engagement_score || 0}</b></td>
        <td>${f.contact && f.contact.length ? 'yes' : '<span class="muted">no</span>'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No scored activity yet.</td></tr>';

    const toneColour = overallAvg > 0.15 ? '#2e7d32' : overallAvg < -0.15 ? '#c62828' : '#12354B';
    const stanceTotal = Math.max(1, tot.supporters + tot.opponents + tot.undecided);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Social listening</title>
<style>
 body{font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;color:#1a1f24;background:#fdfcf8}
 h1{font-size:20px;margin:0 0 4px;color:#12354B} h2{font-size:15px;margin:28px 0 8px;color:#12354B}
 .muted{color:#6b7580} .sub{color:#6b7580;margin:0 0 20px}
 .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
 .card{flex:1 1 150px;border:1px solid #e6e6e3;border-radius:8px;padding:12px 14px;background:#fff}
 .card .v{font-size:24px;font-weight:700;line-height:1.2} .card .l{font-size:12px;color:#6b7580;text-transform:uppercase;letter-spacing:.06em}
 .card .s{font-size:11px;color:#6b7580;margin-top:2px}
 table{border-collapse:collapse;width:100%;max-width:1000px;background:#fff;border:1px solid #e6e6e3;border-radius:8px;overflow:hidden}
 th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #f0f0ee;font-size:13px}
 th{background:#12354B;color:#fff;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
 td.n{text-align:right;font-variant-numeric:tabular-nums} .pos{color:#2e7d32} .neg{color:#c62828}
 .bar{background:#f0f0ee;border-radius:3px;height:9px;width:150px;overflow:hidden}
 .bar span{display:block;height:100%}
 .stance{display:flex;height:26px;border-radius:6px;overflow:hidden;max-width:1000px;border:1px solid #e6e6e3}
 .stance div{display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600}
 form{margin:0 0 18px} input,button{font:inherit;padding:5px 9px;border:1px solid #ccc;border-radius:5px}
</style>
<h1>Social listening</h1>
<p class="sub">How people are responding to the campaign. Last ${days} days. Labels are high-confidence only, so "Unclear" is excluded from the mixes below.</p>

<form method="get"><label>Window <input type="number" name="days" value="${days}" min="1" max="365" style="width:80px"></label>
<button>Update</button> <span class="muted">or <a href="?days=${days}&json=1">JSON</a></span></form>

<div class="cards">
  <div class="card"><div class="l">Messages</div><div class="v">${tot.messages.toLocaleString()}</div></div>
  <div class="card"><div class="l">Avg sentiment</div><div class="v" style="color:${toneColour}">${overallAvg.toFixed(2)}</div></div>
  <div class="card"><div class="l">Positive</div><div class="v pos">${tot.positive.toLocaleString()}</div></div>
  <div class="card"><div class="l">Negative</div><div class="v neg">${tot.negative.toLocaleString()}</div></div>
  <div class="card"><div class="l">Needs a human</div><div class="v">${flagged.length}</div></div>
  ${x ? `<div class="card"><div class="l">X API spend</div><div class="v">$${x.cycle_total_usd.toFixed(2)}</div>
  <div class="s">avg $${x.avg_per_day_usd.toFixed(3)}/day over ${x.cycle_days}d · latest day $${x.latest_day_usd.toFixed(3)}</div></div>` : ''}
</div>

<h2>Stance mix</h2>
<div class="stance">
  <div style="background:#2e7d32;width:${(tot.supporters / stanceTotal) * 100}%">${tot.supporters || ''}</div>
  <div style="background:#8a8a8a;width:${(tot.undecided / stanceTotal) * 100}%">${tot.undecided || ''}</div>
  <div style="background:#c62828;width:${(tot.opponents / stanceTotal) * 100}%">${tot.opponents || ''}</div>
</div>
<p class="muted" style="font-size:12px">Green supporters · grey undecided · red opponents. Stance is relative to the campaign, so an angry message about the government counts as a supporter.</p>

<h2>Day by day</h2>
<table><tr><th>Date</th><th>Msgs</th><th>Volume</th><th>Avg</th><th>Pos</th><th>Neu</th><th>Neg</th><th>Flags</th></tr>
${trendRows || '<tr><td colspan="8" class="muted">No data yet. Run the analyser and rollup.</td></tr>'}</table>

<h2>What people are talking about</h2>
<table><tr><th>Topic</th><th>Messages</th></tr>${topicRows}</table>

<h2>Needs a human</h2>
<table><tr><th>Name</th><th>Platform</th><th>Stance</th><th>Sentiment</th><th>Known contact</th></tr>${flagRows}</table>

<h2>Most engaged people</h2>
<table><tr><th>Name</th><th>Platform</th><th>Stance</th><th>Interactions</th><th>Sentiment</th><th>Score</th><th>Known contact</th></tr>${engagedRows}</table>
<p class="muted" style="font-size:12px;margin-top:10px">Engagement blends volume, recency and warmth. High score + Supporter = worth recruiting. "Known contact" means we can link them to a person in the CRM; commenters who never gave details stay identity-only by design.</p>
`);
  } catch (e) {
    console.error('social-dashboard error:', e);
    return res.status(500).send('dashboard error');
  }
};
