// Social listening: daily trend rollup.
//
// GET/POST /api/cron/social-rollup
//   Auth: Vercel cron bearer (CRON_SECRET) or ?token=ADMIN_TOKEN.
//   Aggregates scored Events into one Social Daily row per day per platform.
//   ?days=N to rebuild the last N days (default 3, so late-arriving analysis
//   and Zernio's ~51h retry window are always folded back in).
//
// Per-message rows answer "what did this person say". This answers "how is
// response to the campaign moving" — which is the actual listening question.
// Recomputed from source each run rather than incremented, so a rerun is
// always safe and always correct.

const { requireCron } = require('../_util');
const { TABLES } = require('../../lib/social/config');
const { listPage, select, update, create, fesc } = require('../../lib/social/airtable');
const { platformFromPayload } = require('../../lib/social/analyse');

const DAILY_TABLE = process.env.AIRTABLE_SOCIAL_DAILY_TABLE || 'Social Daily';
const ANALYSED_TYPES = ['Social Comment', 'Social DM'];

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

module.exports = async (req, res) => {
  if (!authed(req) && !requireCron(req, res)) return;

  const days = Math.min(Number((req.query && req.query.days) || 0) || 3, 400);
  const sinceMs = Date.now() - days * 86400000;
  const sinceIso = new Date(sinceMs).toISOString();

  try {
    // Gather every scored message in the window.
    const buckets = new Map(); // "date|platform" -> tallies
    let offset;
    do {
      const typeFilter = ANALYSED_TYPES.map((t) => `{event_type} = '${fesc(t)}'`).join(',');
      const page = await listPage(TABLES.EVENTS, {
        filterByFormula: `AND(OR(${typeFilter}), {analysed_at} != '', IS_AFTER({timestamp}, '${sinceIso}'))`,
        fields: ['timestamp', 'payload', 'sentiment_label', 'sentiment_score', 'stance', 'topic', 'escalation_flags'],
        pageSize: 100,
        ...(offset ? { offset } : {}),
      });
      const records = page.records || [];
      offset = page.offset;

      for (const rec of records) {
        const f = rec.fields || {};
        const d = dayKey(f.timestamp);
        if (!d) continue;
        const platform = platformFromPayload(f.payload);
        const key = `${d}|${platform}`;
        const b = buckets.get(key) || {
          date: d, platform,
          messages: 0, positive: 0, neutral: 0, negative: 0,
          scoreSum: 0, scored: 0,
          supporters: 0, opponents: 0, undecided: 0,
          escalations: 0, topics: {},
        };

        b.messages += 1;
        const lab = f.sentiment_label && f.sentiment_label.name ? f.sentiment_label.name : f.sentiment_label;
        if (lab === 'Positive') b.positive += 1;
        else if (lab === 'Neutral') b.neutral += 1;
        else if (lab === 'Negative') b.negative += 1;
        if (typeof f.sentiment_score === 'number') { b.scoreSum += f.sentiment_score; b.scored += 1; }

        const st = f.stance && f.stance.name ? f.stance.name : f.stance;
        if (st === 'Supporter') b.supporters += 1;
        else if (st === 'Opponent') b.opponents += 1;
        else if (st === 'Undecided') b.undecided += 1;

        if ((f.escalation_flags || []).length) b.escalations += 1;
        const topic = (f.topic || '').trim().toLowerCase();
        if (topic) b.topics[topic] = (b.topics[topic] || 0) + 1;

        buckets.set(key, b);
      }
    } while (offset);

    // Upsert one row per bucket.
    let written = 0;
    for (const [key, b] of buckets) {
      const topTopics = Object.entries(b.topics)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 8)
        .map(([t, n]) => `${t} (${n})`)
        .join('\n');

      const fields = {
        row_id: key,
        date: b.date,
        platform: b.platform,
        messages: b.messages,
        positive: b.positive,
        neutral: b.neutral,
        negative: b.negative,
        sentiment_avg: b.scored ? Math.round((b.scoreSum / b.scored) * 100) / 100 : 0,
        supporters: b.supporters,
        opponents: b.opponents,
        undecided: b.undecided,
        escalations: b.escalations,
        top_topics: topTopics,
        updated_at: new Date().toISOString(),
      };

      const existing = await select(DAILY_TABLE, `{row_id} = '${fesc(key)}'`, ['row_id'], 1);
      if (existing.length) await update(DAILY_TABLE, [{ id: existing[0].id, fields }]);
      else await create(DAILY_TABLE, [fields]);
      written += 1;
    }

    return res.status(200).json({ ok: true, days, buckets: written });
  } catch (e) {
    console.error('social-rollup error:', e);
    return res.status(500).json({ ok: false, error: String(e && e.message) });
  }
};
