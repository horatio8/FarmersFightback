// Cron (nightly ~04:15 AEST): two rollups.
//
// 1. Referral Rollup (WS6): per referral code — signups, donations,
//    dollars — aggregated from Events (referral_code_used). Serves
//    /leaderboard.
// 2. AB Daily: yesterday's per-variant sends / clicks / gifts / revenue /
//    opt-outs for each live test. Serves /api/ab-report.
//    Variant↔link mapping for sms_signup: A→/fund(ben), B→/fight(issue).

const { listRows, createRow, updateRow, nowIso } = require("../_airtable");
const { requireCron, melbourneParts } = require("../_util");
const { recomputeSignatureCount } = require("./refresh-signature-count");

const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";
const SMS_SENDS = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const LAPSE = process.env.AIRTABLE_LAPSE_TABLE || "Lapse Queue";
const ROLLUP = process.env.AIRTABLE_REFERRAL_ROLLUP_TABLE || "Referral Rollup";
const AB_DAILY = process.env.AIRTABLE_AB_DAILY_TABLE || "AB Daily";

function parsePayload(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

// Yesterday's Melbourne calendar date, plus its UTC window.
function yesterdayWindow() {
  const now = new Date();
  const p = melbourneParts(now);
  const startUTC = Date.UTC(p.y, p.m, p.d - 1, 0, 0) - p.offset * 60000;
  const endUTC = Date.UTC(p.y, p.m, p.d, 0, 0) - p.offset * 60000;
  const label = new Date(Date.UTC(p.y, p.m, p.d - 1)).toISOString().slice(0, 10);
  return { start: new Date(startUTC), end: new Date(endUTC), label };
}

async function upsert(table, keyField, keyValue, fields, cache) {
  const existing = cache.find((r) => (r.fields || {})[keyField] === keyValue);
  if (existing) return updateRow(table, existing.id, fields);
  return createRow(table, { [keyField]: keyValue, ...fields });
}

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  const out = { referrers: 0, ab_rows: 0 };
  try {
    // ---------- 1. Referral rollup (all-time, recomputed nightly) ----------
    const refEvents = await listRows(EVENTS, {
      formula: `{referral_code_used}!=''`,
      fields: ["event_type", "referral_code_used", "payload", "timestamp"],
    });
    const byCode = {};
    for (const r of refEvents) {
      const f = r.fields || {};
      const code = String(f.referral_code_used || "").toUpperCase();
      if (!code) continue;
      const type = f.event_type?.name || f.event_type;
      const agg = (byCode[code] = byCode[code] || { signups: 0, donations: 0, dollars: 0 });
      if (type === "Petition Signed") agg.signups++;
      if (type === "Donation" || type === "Rally Ticket Purchased") {
        agg.donations++;
        const p = parsePayload(f.payload);
        if (typeof p.amount === "number") agg.dollars += p.amount / 100;
      }
    }
    const rollupRows = await listRows(ROLLUP, { fields: ["code"] });
    for (const [code, agg] of Object.entries(byCode)) {
      // eslint-disable-next-line no-await-in-loop
      await upsert(ROLLUP, "code", code, {
        signups: agg.signups, donations: agg.donations,
        dollars: Math.round(agg.dollars * 100) / 100, updated_at: nowIso(),
      }, rollupRows);
      out.referrers++;
    }

    // ---------- 2. AB Daily for yesterday ----------
    const { start, end, label } = yesterdayWindow();
    const inWindow = (iso) => { const t = new Date(iso || 0).getTime(); return t >= start.getTime() && t < end.getTime(); };

    // sms_signup: sends by variant
    const sends = await listRows(SMS_SENDS, {
      formula: `AND({template}='signup_ab', OR({status}='sent', {status}='scheduled'), IS_AFTER({sent_at}, '${start.toISOString()}'), IS_BEFORE({sent_at}, '${end.toISOString()}'))`,
      fields: ["variant"],
    });
    // clicks + opt-outs + donations from Events in the window
    const dayEvents = await listRows(EVENTS, {
      formula: `AND(IS_AFTER({timestamp}, '${start.toISOString()}'), IS_BEFORE({timestamp}, '${end.toISOString()}'), OR({event_type}='SMS Click', {event_type}='SMS Opt Out', {event_type}='Donation'))`,
      fields: ["event_type", "payload", "timestamp"],
    });

    const cells = {
      sms_signup: { A: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 }, B: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 } },
      petition_lapse: { A: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 }, B: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 } },
      donation_lapse: { A: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 }, B: { sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 } },
    };
    // Count DISTINCT clickers per variant, not raw taps. One person double-
    // tapping the link (fat fingers, back-then-forward) or an app prefetch that
    // slips past the UA filter would otherwise inflate the click count. Dedupe
    // on the ?c= referral code; anonymous taps (no code) each count once.
    const clickers = { A: new Set(), B: new Set() };
    let anonClicks = { A: 0, B: 0 };
    for (const s of sends) {
      const v = s.fields?.variant?.name || s.fields?.variant;
      if (cells.sms_signup[v]) cells.sms_signup[v].sends++;
    }
    for (const e of dayEvents) {
      const type = e.fields?.event_type?.name || e.fields?.event_type;
      const p = parsePayload(e.fields?.payload);
      if (type === "SMS Click") {
        const v = p.utm_content === "issue" ? "B" : "A";
        if (p.c) clickers[v].add(String(p.c).toUpperCase());
        else anonClicks[v]++;
      } else if (type === "SMS Opt Out") {
        cells.sms_signup.A.optouts += 0.5; cells.sms_signup.B.optouts += 0.5; // attributed precisely below if possible
      } else if (type === "Donation") {
        const uc = String(p.utm_content || "");
        const amt = typeof p.amount === "number" ? p.amount / 100 : 0;
        if (uc === "ben") { cells.sms_signup.A.gifts++; cells.sms_signup.A.revenue += amt; }
        else if (uc === "issue") { cells.sms_signup.B.gifts++; cells.sms_signup.B.revenue += amt; }
        else if (uc === "lapse_a") { cells.donation_lapse.A.gifts++; cells.donation_lapse.A.revenue += amt; }
        else if (uc === "lapse_b") { cells.donation_lapse.B.gifts++; cells.donation_lapse.B.revenue += amt; }
      }
    }
    // Fold the deduped click tally back in: distinct referral codes + any
    // anonymous taps that carried no code.
    cells.sms_signup.A.clicks = clickers.A.size + anonClicks.A;
    cells.sms_signup.B.clicks = clickers.B.size + anonClicks.B;

    // lapse triggers (sends) by variant
    const lapses = await listRows(LAPSE, {
      formula: `AND({status}='triggered', IS_AFTER({triggered_at}, '${start.toISOString()}'), IS_BEFORE({triggered_at}, '${end.toISOString()}'))`,
      fields: ["form", "variant"],
    });
    for (const l of lapses) {
      const form = l.fields?.form?.name || l.fields?.form;
      const v = l.fields?.variant?.name || l.fields?.variant;
      const test = form === "donation" ? "donation_lapse" : "petition_lapse";
      if (cells[test][v]) cells[test][v].sends++;
    }

    const abRows = await listRows(AB_DAILY, { fields: ["row_id"] });
    for (const [test, variants] of Object.entries(cells)) {
      for (const [variant, c] of Object.entries(variants)) {
        if (!c.sends && !c.clicks && !c.gifts && !c.optouts) continue;
        const rowId = `${label}|${test}|${variant}`;
        // eslint-disable-next-line no-await-in-loop
        await upsert(AB_DAILY, "row_id", rowId, {
          date: label, test, variant,
          sends: c.sends, clicks: c.clicks, gifts: c.gifts,
          revenue: Math.round(c.revenue * 100) / 100,
          optouts: Math.round(c.optouts),
          updated_at: nowIso(),
        }, abRows);
        out.ab_rows++;
      }
    }

    // Nightly reconciliation of the event-driven signature counter (Airtable
    // has no atomic increment, so the per-signup bump can drift under
    // concurrency; this full recount corrects it and fires missed milestones).
    const signature = await recomputeSignatureCount().catch((e) => {
      console.error("nightly recount:", e.message);
      return null;
    });
    return res.status(200).json({ ok: true, date: label, signature, ...out });
  } catch (e) {
    console.error("nightly-rollup:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
