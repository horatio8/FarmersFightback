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
  createRow,
  findOne,
} = require("./_airtable");
const { cnProfileMatch } = require("./_cn");
const { phoneHash } = require("./_util");

const SMS_SENDS_TABLE = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const REPLIES_TABLE = process.env.AIRTABLE_SMS_REPLIES_TABLE || "SMS Replies";
const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const AT_BASE = "https://api.airtable.com/v0";

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "POST only" });
  // Optional shared secret: if CELLCAST_WEBHOOK_BASIC ("user:pass") is set,
  // require it as HTTP Basic auth. Unset => open, since a misconfigured secret
  // silently dropping STOPs is worse than an open endpoint that only ever
  // flips opt-out flags.
  const wantBasic = process.env.CELLCAST_WEBHOOK_BASIC;
  if (wantBasic) {
    const expected = `Basic ${Buffer.from(wantBasic).toString("base64")}`;
    if ((req.headers.authorization || "") !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    // Forward a verbatim copy to the previous consumer (the cellcast-mcp app)
    // so repointing Cellcast's single webhook slot here doesn't cut off its
    // feed. Kicked off now to run concurrently with our own processing;
    // every response path below goes through respond(), which awaits it
    // first (a frozen lambda kills in-flight fetches). Best-effort: a dead
    // forward target never blocks STOP handling.
    const forwardP = process.env.CELLCAST_FORWARD_URL
      ? fetch(process.env.CELLCAST_FORWARD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        }).catch((e) => console.error("cellcast forward:", e.message))
      : null;
    const respond = async (payload) => {
      if (forwardP) await forwardP;
      return res.status(200).json(payload);
    };
    // Cellcast v1 inbound webhook: { sender:<customer #>, reply:<their text>,
    // message:<original outbound>, receiver:<our #> }. Read the INBOUND text
    // from `reply` first — `message` is the outbound copy. Other field names
    // kept as defensive fallbacks for delivery-receipt / legacy shapes.
    const from = body.sender || body.from || body.mobile || body.number ||
      (req.method === "GET" ? new URL(req.url, "https://x").searchParams.get("from") : "");
    const text = String(body.reply || body.message || body.body || body.text || body.sms_text ||
      (req.method === "GET" ? new URL(req.url, "https://x").searchParams.get("message") : "") || "");

    const phone = normPhone(from);
    if (!phone) return respond({ ok: true, ignored: "no phone" });
    const isStop = /^\s*(stop|unsub|unsubscribe)\b/i.test(text);

    // Record EVERY reply in the SMS Replies table, not just STOPs. Dedupe on
    // Cellcast's message _id when present (webhook retries); fall back to a
    // timestamp key. Note: if the 5-min poll also picks this reply up it
    // creates a second row under its own phone|received_at key — acceptable
    // while the webhook is optional/unconfigured.
    if (text) {
      try {
        const receivedAt = new Date().toISOString();
        const replyId = `${phone}|${body._id || receivedAt}`;
        const dup = body._id ? await findOne(REPLIES_TABLE, `{reply_id}='${replyId}'`) : null;
        if (!dup) {
          const c = await findContactByMobile(phone).catch(() => null);
          await createRow(REPLIES_TABLE, {
            reply_id: replyId,
            phone,
            body: text.slice(0, 2000),
            received_at: receivedAt,
            is_stop: isStop,
            via: "webhook",
            ...(c ? { contact: [c.id] } : {}),
          });
        }
      } catch (e) { console.error("reply capture:", e.message); }
    }

    if (!isStop) return respond({ ok: true, recorded: !!text, ignored: "not a STOP" });

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

    return respond({ ok: true });
  } catch (e) {
    console.error("cellcast-inbound:", e.message);
    return res.status(200).json({ ok: false });
  }
};
