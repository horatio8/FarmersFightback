// Cellcast inbound-reply webhook (Workstream 1.8): STOP handling.
// Configure in the Cellcast dashboard → API settings → inbound webhook,
// pointing at https://www.farmersfightback.com/api/cellcast-inbound
//
// Any reply starting with STOP (case-insensitive; also UNSUB/UNSUBSCRIBE):
//  - sets sms_opt_out on the matching Contact
//  - marks any queued SMS rows for that phone as suppressed
//  - tags the CN profile sms_opt_out
//  - logs an "SMS Opt Out" event
// Always 200s so Cellcast doesn't retry-storm us.

const {
  findContactByMobile,
  listRows,
  updateRow,
  logEvent,
  normPhone,
} = require("./_airtable");
const { cnProfileMatch } = require("./_cn");
const { phoneHash } = require("./_util");

const SMS_SENDS_TABLE = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const AT_BASE = "https://api.airtable.com/v0";

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "POST only" });
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    // Cellcast payload shapes vary; accept the common field names.
    const from = body.from || body.mobile || body.number || body.sender ||
      (req.method === "GET" ? new URL(req.url, "https://x").searchParams.get("from") : "");
    const text = String(body.message || body.body || body.text || body.sms_text ||
      (req.method === "GET" ? new URL(req.url, "https://x").searchParams.get("message") : "") || "");

    const phone = normPhone(from);
    if (!phone) return res.status(200).json({ ok: true, ignored: "no phone" });
    const isStop = /^\s*(stop|unsub|unsubscribe)\b/i.test(text);
    if (!isStop) return res.status(200).json({ ok: true, ignored: "not a STOP" });

    // 1. Flag the contact.
    let contactRecordId;
    try {
      const contact = await findContactByMobile(phone);
      if (contact) {
        contactRecordId = contact.id;
        await fetch(`${AT_BASE}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTACTS)}/${contact.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { sms_opt_out: true }, typecast: true }),
        });
      }
    } catch (e) { console.error("opt-out contact flag:", e.message); }

    // 2. Suppress anything still queued for this phone.
    try {
      const hash = phoneHash(phone);
      const queued = await listRows(SMS_SENDS_TABLE, {
        formula: `AND({phone_hash}='${hash}', {status}='queued')`, maxRecords: 20,
      });
      for (const row of queued) {
        // eslint-disable-next-line no-await-in-loop
        await updateRow(SMS_SENDS_TABLE, row.id, { status: "suppressed", error: "STOP reply" });
      }
    } catch (e) { console.error("opt-out queue suppress:", e.message); }

    // 3. Flag in CN + log. Await the CN write — an un-awaited fetch can be
    // killed when the serverless lambda freezes on response.
    await cnProfileMatch({ mobile: phone, tags: ["sms_opt_out"] }).catch(() => {});
    await logEvent({
      contactRecordId,
      event_type: "SMS Opt Out",
      payload: { phone_last4: phone.slice(-4), reply: text.slice(0, 100) },
      source_channel: "Other",
      fanout: false,
    }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("cellcast-inbound:", e.message);
    return res.status(200).json({ ok: false });
  }
};
