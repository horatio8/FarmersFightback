// Cron (every 5 min): STOP handling by POLLING Cellcast's get-responses
// API — no Cellcast webhook required, so the client's existing
// cellcast-mcp inbound webhook is left completely untouched.
//
// Walks new inbound replies since a stored watermark (Site Stats key
// sms_inbound_watermark), finds STOP/UNSUB messages, and runs the same
// suppression as the webhook path: flag Contacts.sms_opt_out, suppress
// queued SMS, tag the CN profile, log an "SMS Opt Out" event.
//
// First run seeds the watermark to the newest reply and processes nothing
// historical (the automated-SMS programme is new — nobody has STOPped it
// yet). A one-time historical sweep can be run separately if wanted.
//
// Uses the Cellcast v1 API (Authorization: Bearer CELLCAST_API_KEY) — same
// key as sending. Shape: { meta:{status}, data:{ items:[{from, body,
// received_at}], totalPages, nextPage } }.

const {
  findContactByMobile, listRows, updateRow, findOne, createRow,
  logEvent, nowIso,
} = require("../_airtable");
const { requireCron, cellcastToE164, phoneHash } = require("../_util");
const { cnProfileMatch } = require("../_cn");

const SMS_SENDS_TABLE = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const STATS_TABLE = process.env.AIRTABLE_STATS_TABLE || "Site Stats";
const AT = "https://api.airtable.com/v0";
const WATERMARK_KEY = "sms_inbound_watermark";
const STOP_RE = /^\s*(stop|unsub|unsubscribe|opt\s*out|remove\s*me)\b/i;
const CELLCAST_BASE = (process.env.CELLCAST_API_BASE || "https://api.cellcast.com/api/v1").replace(/\/$/, "");

async function getResponses(page) {
  const r = await fetch(`${CELLCAST_BASE}/apiClient/getResponses?page=${page}`, {
    headers: { Authorization: `Bearer ${process.env.CELLCAST_API_KEY}`, Accept: "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.meta?.status !== "SUCCESS") {
    throw new Error(`Cellcast getResponses ${r.status} ${j.meta?.status || ""}`.trim());
  }
  return j.data || {};
}

async function suppress(fromE164, body) {
  let contactRecordId;
  try {
    const contact = await findContactByMobile(fromE164);
    if (contact) {
      contactRecordId = contact.id;
      if (!contact.fields?.sms_opt_out) {
        await fetch(`${AT}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTACTS)}/${contact.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { sms_opt_out: true }, typecast: true }),
        });
      }
    }
  } catch (e) { console.error("suppress contact:", e.message); }

  try {
    const hash = phoneHash(fromE164);
    const queued = await listRows(SMS_SENDS_TABLE, {
      formula: `AND({phone_hash}='${hash}', {status}='queued')`, maxRecords: 20,
    });
    for (const row of queued) {
      // eslint-disable-next-line no-await-in-loop
      await updateRow(SMS_SENDS_TABLE, row.id, { status: "suppressed", error: "STOP reply" });
    }
  } catch (e) { console.error("suppress queue:", e.message); }

  await cnProfileMatch({ mobile: fromE164, tags: ["sms_opt_out"] }).catch(() => {});
  await logEvent({
    contactRecordId,
    event_type: "SMS Opt Out",
    payload: { phone_last4: fromE164.slice(-4), reply: String(body).slice(0, 100), via: "poll" },
    source_channel: "Other",
    fanout: false,
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  if (!process.env.CELLCAST_API_KEY) return res.status(200).json({ skipped: "CELLCAST_API_KEY not set" });
  try {
    const wmRow = await findOne(STATS_TABLE, `{key}='${WATERMARK_KEY}'`);
    const watermark = wmRow?.fields?.text_value ? new Date(wmRow.fields.text_value).getTime() : null;

    const first = await getResponses(1);
    const firstItems = first.items || [];
    if (!firstItems.length) return res.status(200).json({ ok: true, empty: true });

    // Seed on first run — record newest, process nothing historical.
    if (watermark === null) {
      const newest = firstItems[0].received_at;
      await createRow(STATS_TABLE, { key: WATERMARK_KEY, text_value: newest, updated_at: nowIso() });
      return res.status(200).json({ ok: true, seeded: newest, note: "no historical processing on first run" });
    }

    // Walk pages newest→older until we pass the watermark (cap pages).
    let newestSeen = watermark;
    let stops = 0, scanned = 0, page = 1;
    const totalPages = first.totalPages || 1;
    let items = firstItems;
    while (page <= Math.min(totalPages, 40)) {
      let reachedOld = false;
      for (const it of items) {
        const t = new Date(it.received_at).getTime();
        if (!Number.isFinite(t)) continue;
        if (t <= watermark) { reachedOld = true; break; }
        scanned++;
        if (t > newestSeen) newestSeen = t;
        if (STOP_RE.test(it.body || "")) {
          const e164 = cellcastToE164(it.from);
          if (e164) { stops++; /* eslint-disable-next-line no-await-in-loop */ await suppress(e164, it.body); }
        }
      }
      if (reachedOld || page >= totalPages) break;
      page++;
      // eslint-disable-next-line no-await-in-loop
      items = (await getResponses(page)).items || [];
    }

    if (newestSeen > watermark) {
      await updateRow(STATS_TABLE, wmRow.id, {
        text_value: new Date(newestSeen).toISOString(), updated_at: nowIso(),
      });
    }
    return res.status(200).json({ ok: true, scanned, stops, pages: page });
  } catch (e) {
    console.error("sms-inbound-poll:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
