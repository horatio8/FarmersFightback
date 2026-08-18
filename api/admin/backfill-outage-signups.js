// Repair the outage-window signups: people whose Contact saved but whose
// "Petition Signed" event was rejected while the Events table was full
// (17-18 Aug 2026), leaving them with no event, no signature row and no
// status.
//
//   GET /api/admin/backfill-outage-signups?token=ADMIN_TOKEN
//     Dry run: counts candidates by first_source_channel and by hour.
//   ...&write=1&channels=Direct,Facebook,Referral,Other
//     Log the missing event for candidates whose channel is listed.
//     channels is REQUIRED with write, so a human has looked at the dry
//     run and chosen which flows really were petition signups.
//   ...&from=ISO&to=ISO   override the window (defaults to the outage).
//
// A candidate is a contact that (a) was created inside the window, (b) has
// no Petition Signatures row, and (c) has no status — the exact residue the
// outage left, since status is only ever set after the event that failed.
//
// What the repair writes, per person:
//   - a Petition Signed event with payload.source = "outage-backfill" and
//     timestamp = the contact's real creation time, so history stays honest
//     and time-windowed rollups count them in the right day;
//   - via the normal fan-out, their Petition Signatures row;
//   - their status, through the same helper the live signup uses.
// Nothing outbound: no SMS, no Meta event, no email. The public tally is
// unchanged — it counts Contacts, and these contacts already exist.
//
// Idempotent: meta_event_id = outage_backfill_<contact uuid>, checked
// through logEventIdempotent across every log slice, so a re-run or a
// crash-and-retry can never write a second event. Time-boxes itself at
// 240s and reports how far it got; re-invoke until remaining is 0.

const {
  listRows, logEventIdempotent, updateContactStatusFromEvent, escapeFormula,
} = require("../_airtable");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const SIGNATURES = process.env.AIRTABLE_PETITION_SIGNATURES_TABLE || "Petition Signatures";

// The Events table filled just after the last successful write on 17 Aug and
// the split deployed at 07:05 UTC on the 18th; a few minutes' slack each side.
const DEFAULT_FROM = "2026-08-17T05:00:00.000Z";
const DEFAULT_TO = "2026-08-18T07:10:00.000Z";
const TIME_BUDGET_MS = 240 * 1000;

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

// The event the outage should have produced. Exported for the test.
function buildBackfillEvent(contact) {
  const f = contact.fields || {};
  return {
    contactRecordId: contact.id,
    event_type: "Petition Signed",
    timestamp: contact.createdTime,
    source_channel: f.first_source_channel || undefined,
    meta_event_id: `outage_backfill_${f.contact_id || contact.id}`,
    payload: {
      source: "outage-backfill",
      note: "Event log was full when this person signed; event reconstructed from their Contact record.",
      window: { from: DEFAULT_FROM, to: DEFAULT_TO },
      first_name: f.first_name,
      last_name: f.last_name,
      email: f.email,
      mobile: f.mobile,
      postcode: f.postcode,
      fbclid: f.fbclid,
    },
    fbclid: f.fbclid || undefined,
  };
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const url = new URL(req.url, "https://x");
  const write = url.searchParams.get("write") === "1";
  const from = url.searchParams.get("from") || DEFAULT_FROM;
  const to = url.searchParams.get("to") || DEFAULT_TO;
  const channels = (url.searchParams.get("channels") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (write && !channels.length) {
    return res.status(400).json({ error: "write=1 requires channels=A,B,... — run the dry run first and choose" });
  }
  const started = Date.now();

  try {
    // Every contact that already has a signature row. One scan, held as a set.
    const signatureRows = await listRows(SIGNATURES, { fields: ["contact"] });
    const signed = new Set();
    for (const s of signatureRows) for (const id of (s.fields.contact || [])) signed.add(id);

    const windowContacts = await listRows(CONTACTS, {
      formula: `AND(IS_AFTER(CREATED_TIME(), '${escapeFormula(from)}'), IS_BEFORE(CREATED_TIME(), '${escapeFormula(to)}'))`,
      fields: ["contact_id", "first_name", "last_name", "email", "mobile", "postcode",
        "fbclid", "first_source_channel", "status"],
    });

    const candidates = windowContacts.filter((c) => {
      const f = c.fields || {};
      const st = f.status && f.status.name ? f.status.name : f.status;
      return !signed.has(c.id) && !st;
    });

    const byChannel = {};
    const byHour = {};
    for (const c of candidates) {
      const ch = (c.fields || {}).first_source_channel || "(blank)";
      byChannel[ch] = (byChannel[ch] || 0) + 1;
      const h = String(c.createdTime || "").slice(0, 13);
      byHour[h] = (byHour[h] || 0) + 1;
    }

    if (!write) {
      return res.status(200).json({
        dry_run: true,
        window: { from, to },
        contacts_in_window: windowContacts.length,
        candidates: candidates.length,
        by_channel: byChannel,
        by_hour: byHour,
        next: "re-run with &write=1&channels=<the channels that are petition flows>",
      });
    }

    const out = {
      dry_run: false, window: { from, to }, channels,
      candidates: candidates.length, backfilled: 0, skipped_channel: 0,
      already_done: 0, errors: 0, remaining: 0,
    };
    for (const c of candidates) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const ch = (c.fields || {}).first_source_channel || "(blank)";
      if (!channels.includes(ch)) { out.skipped_channel += 1; continue; }
      try {
        // eslint-disable-next-line no-await-in-loop
        const ev = await logEventIdempotent(buildBackfillEvent(c));
        // logEventIdempotent returns the existing event when this person was
        // already repaired; only count a genuinely new write as backfilled.
        if (ev && ev.fields && ev.fields.meta_event_id && ev.createdTime
            && Date.now() - Date.parse(ev.createdTime) > 60 * 1000) {
          out.already_done += 1;
        } else {
          out.backfilled += 1;
        }
        // eslint-disable-next-line no-await-in-loop
        await updateContactStatusFromEvent(c.id, "Petition Signed", (c.fields || {}).status);
      } catch (e) {
        out.errors += 1;
        console.error("outage backfill:", c.id, e.message);
      }
    }
    out.remaining = Math.max(0, out.candidates - out.backfilled - out.already_done
      - out.skipped_channel - out.errors);
    out.elapsed_s = Math.round((Date.now() - started) / 1000);
    return res.status(200).json(out);
  } catch (e) {
    console.error("backfill-outage-signups:", e.message);
    return res.status(500).json({ error: e.message.slice(0, 300) });
  }
};

module.exports.buildBackfillEvent = buildBackfillEvent;
