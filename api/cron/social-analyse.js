// Social listening analyser.
//
// GET/POST /api/cron/social-analyse
//   Auth: Vercel cron bearer (CRON_SECRET) or ?token=ADMIN_TOKEN for manual runs.
//   Scores every Social Comment / Social DM Event that has no analysed_at yet,
//   then rolls the result up onto the person's Identity.
//
// Resumable and idempotent: work is found by "analysed_at is blank", so it can
// be called repeatedly, survives timeouts, and never rescores a message. That
// also makes the historical backfill and the nightly pass the SAME code path —
// the backfill is just the first few runs, when the unscored pile is large.
//
// Time-boxed like the other long runners so a big backlog spreads over calls
// instead of dying at the function limit.
//
// A message whose model call fails is simply left unscored: the next run picks
// it up. Better a gap than a wrong label.

const { requireCron } = require('../_util');
const { TABLES } = require('../../lib/social/config');
const { listPage, select, update, create, fesc, sleep } = require('../../lib/social/airtable');
const {
  analyseMessage,
  textFromPayload,
  identityKeyFromPayload,
} = require('../../lib/social/analyse');

const TIME_BUDGET_MS = 50 * 1000;
const USAGE_TABLE = process.env.AIRTABLE_AI_USAGE_TABLE || 'AI Usage';
const ANALYSED_TYPES = ['Social Comment', 'Social DM'];

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

// Recompute a person's rollup from all their scored messages. Reading back
// rather than incrementing keeps it correct even if runs overlap or a message
// is rescored later.
async function rollupIdentity(identityKey) {
  if (!identityKey) return;
  const idRows = await select(TABLES.IDENTITIES, `{identity_key} = '${fesc(identityKey)}'`, null, 1);
  if (!idRows.length) return;
  const idRec = idRows[0];

  const events = await select(
    TABLES.EVENTS,
    `AND(FIND('"identity_key":"${fesc(identityKey)}"', {payload}) > 0, {analysed_at} != '')`,
    ['sentiment_score', 'sentiment_label', 'stance', 'escalation_flags'],
    200
  );
  if (!events.length) return;

  let sum = 0;
  let scored = 0;
  let flagged = false;
  const stanceCount = {};
  for (const e of events) {
    const f = e.fields || {};
    if (typeof f.sentiment_score === 'number') { sum += f.sentiment_score; scored += 1; }
    const st = f.stance && f.stance.name ? f.stance.name : f.stance;
    if (st && st !== 'Unclear') stanceCount[st] = (stanceCount[st] || 0) + 1;
    const flags = f.escalation_flags || [];
    if (flags.length) flagged = true;
  }

  const dominant = Object.keys(stanceCount).sort((a, b) => stanceCount[b] - stanceCount[a])[0] || null;
  const avg = scored ? Math.round((sum / scored) * 100) / 100 : null;

  // Engagement score, 0-100: how much they interact, how recently, and how
  // warmly. Volume is capped so one prolific commenter can't dominate, and
  // recency decays over ~90 days so the list reflects who is active NOW.
  const idf = idRec.fields || {};
  const count = Number(idf.interaction_count || 0);
  const volume = Math.min(1, count / 10);
  const lastSeen = idf.last_seen ? Date.parse(idf.last_seen) : 0;
  const days = lastSeen ? (Date.now() - lastSeen) / 86400000 : 999;
  const recency = Math.max(0, 1 - days / 90);
  const warmth = avg === null ? 0.5 : (avg + 1) / 2;
  const engagement = Math.round(100 * (0.45 * volume + 0.35 * recency + 0.20 * warmth));

  const patch = {
    engagement_score: engagement,
    needs_attention: flagged,
  };
  if (avg !== null) patch.sentiment_avg = avg;
  if (dominant) patch.stance_dominant = dominant;

  await update(TABLES.IDENTITIES, [{ id: idRec.id, fields: patch }]);
}

async function logUsage(rows) {
  if (!rows.length) return;
  try { await create(USAGE_TABLE, rows); } catch (e) {
    console.error('social-analyse usage log failed:', e.message);
  }
}

module.exports = async (req, res) => {
  if (!authed(req) && !requireCron(req, res)) return;

  const started = Date.now();
  const limit = Math.min(Number((req.query && req.query.limit) || 0) || 500, 2000);

  let analysed = 0;
  let failed = 0;
  let skipped = 0;
  let costUsd = 0;
  const touchedIdentities = new Set();
  const usageRows = [];

  try {
    let offset;
    do {
      const typeFilter = ANALYSED_TYPES.map((t) => `{event_type} = '${fesc(t)}'`).join(',');
      const page = await listPage(TABLES.EVENTS, {
        filterByFormula: `AND(OR(${typeFilter}), {analysed_at} = '')`,
        fields: ['event_id', 'event_type', 'payload', 'timestamp'],
        pageSize: 50,
        ...(offset ? { offset } : {}),
      });
      const records = page.records || [];
      offset = page.offset;

      for (const rec of records) {
        if (Date.now() - started > TIME_BUDGET_MS) { offset = null; break; }
        if (analysed >= limit) { offset = null; break; }

        const f = rec.fields || {};
        const text = textFromPayload(f.payload);
        const identityKey = identityKeyFromPayload(f.payload);

        // No text to judge (an attachment-only DM, say). Stamp it so it stops
        // coming back as work, but leave every signal blank.
        if (!text) {
          await update(TABLES.EVENTS, [{ id: rec.id, fields: { analysed_at: new Date().toISOString() } }]);
          skipped += 1;
          continue;
        }

        let out;
        try {
          out = await analyseMessage(text);
        } catch (e) {
          console.error('social-analyse model call failed:', e.message);
          failed += 1;
          continue; // leave unscored; next run retries
        }
        if (!out) { skipped += 1; continue; }

        const r = out.result;
        const fields = {
          sentiment_label: r.sentiment_label,
          stance: r.stance,
          topic: r.topic || undefined,
          escalation_flags: r.escalation_flags.length ? r.escalation_flags : undefined,
          analysed_at: new Date().toISOString(),
        };
        if (r.sentiment_score !== null) fields.sentiment_score = r.sentiment_score;
        Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);

        await update(TABLES.EVENTS, [{ id: rec.id, fields }]);
        analysed += 1;
        costUsd += out.usage.cost_usd;
        if (identityKey) touchedIdentities.add(identityKey);

        usageRows.push({
          timestamp: new Date().toISOString(),
          session_id: `social:${f.event_id || rec.id}`,
          model: out.usage.model,
          input_tokens: out.usage.input_tokens,
          output_tokens: out.usage.output_tokens,
          estimated_cost_usd: Number(out.usage.cost_usd.toFixed(6)),
        });

        await sleep(120); // stay well under Airtable's 5 req/s
      }
    } while (offset && Date.now() - started < TIME_BUDGET_MS && analysed < limit);

    // Roll up each person we touched, budget permitting. Anything missed is
    // picked up on the next run because rollups recompute from scratch.
    let rolled = 0;
    for (const key of touchedIdentities) {
      if (Date.now() - started > TIME_BUDGET_MS + 8000) break;
      try { await rollupIdentity(key); rolled += 1; } catch (e) {
        console.error('rollup failed', key, e.message);
      }
    }

    await logUsage(usageRows);

    return res.status(200).json({
      ok: true,
      analysed,
      skipped,
      failed,
      identities_rolled: rolled,
      estimated_cost_usd: Number(costUsd.toFixed(4)),
      more: !!offset || analysed >= limit,
    });
  } catch (e) {
    console.error('social-analyse error:', e);
    await logUsage(usageRows);
    return res.status(500).json({ ok: false, error: String(e && e.message), analysed, failed });
  }
};
