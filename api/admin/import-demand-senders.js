// Import the supporters who emailed the Premier into Contacts.
//
// POST /api/admin/import-demand-senders?token=ADMIN_TOKEN
//   { rows: [ { first_name, last_name, email, emails?[], first_seen?, messages? } ] }
//
//   ?write=1   actually create the missing contacts (default is a dry run)
//   ?events=1  also put an "Email Action Sent" row on each contact's timeline
//
// Why this exists: every email sent from the /demand page was BCC'd to the
// campaign address, and that mailbox is the only complete record of who
// actually took the action. The capture beacon should have recorded them all,
// but a client bug discarded any session that resumed after a page reload, so
// the mailbox holds people the CRM never saw. This reconciles the two.
//
// The rows are posted in the request rather than read from a file in the repo:
// this is 5,000 supporters' names, addresses and phone numbers, and the repo is
// public. None of it is committed, and nothing here logs an address.
//
// Contacts are created with createRow, NOT matchOrCreateContact. That is the
// whole point of the distinction: matchOrCreateContact bumps the public
// signature counter, and these people are being back-filled, not signing for
// the first time. Importing 5,000 of them through the wrong helper would add
// 5,000 to the number on the front page for actions already counted.
//
// Idempotent: a contact that already exists is matched and left alone, so the
// job can be re-run over the same batch safely. Matching considers every
// address a supporter used — 1 in 5 sent from a family or shared account and
// signed with their own, so matching on the sending address alone would create
// duplicates of people already in the CRM.

const {
  findContactByEmail, createRow, logEventIdempotent, uuid, nowIso,
} = require("../_airtable");
const { requireBasicAuth } = require("../_util");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const EVENT_TYPE = "Email Action Sent";
const MAX_ROWS = 400;

// The rule Campaign Nucleus enforces (PHP filter_var). Kept identical to the
// one in _cn.js: an address CN will reject is one we should not store either.
const EMAIL_RE = new RegExp(
  "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
  + "@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$"
);
function validEmail(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v || v.length > 254) return "";
  const at = v.indexOf("@");
  if (at < 1 || at > 64) return "";
  return EMAIL_RE.test(v) ? v : "";
}

function clean(v, max = 100) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, max) : "";
}

// "Sat, 15 Aug 2026 22:00:27 +1000" or an ISO date — either way, an ISO string.
function isoDate(v) {
  const s = clean(v, 60);
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function authed(req, res) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || "";
  const tokenOk = Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
  const cronOk = Boolean(process.env.CRON_SECRET)
    && (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET}`;
  if (tokenOk || cronOk) return true;
  return requireBasicAuth(req, res);
}

module.exports = async function handler(req, res) {
  if (!authed(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const url = new URL(req.url, "https://x");
  const write = url.searchParams.get("write") === "1";
  const withEvents = url.searchParams.get("events") === "1";

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return res.status(400).json({ error: "body must be { rows: [...] }" });
  if (rows.length > MAX_ROWS) {
    return res.status(400).json({ error: `at most ${MAX_ROWS} rows per call, got ${rows.length}` });
  }

  const stats = {
    received: rows.length,
    invalid_email: 0,
    already_known: 0,
    created: 0,
    events_written: 0,
    errors: 0,
  };
  const samples = { created: [], invalid: [], errors: [] };

  for (const row of rows) {
    // Every address this person used, primary first. Matching on all of them
    // is what stops a shared-inbox sender becoming a duplicate.
    const candidates = [];
    const primary = validEmail(row.email);
    if (primary) candidates.push(primary);
    for (const alt of Array.isArray(row.emails) ? row.emails : []) {
      const e = validEmail(alt);
      if (e && !candidates.includes(e)) candidates.push(e);
    }
    if (!candidates.length) {
      stats.invalid_email += 1;
      if (samples.invalid.length < 10) samples.invalid.push(clean(row.email, 80));
      continue;
    }

    try {
      let contact = null;
      for (const e of candidates) {
        // eslint-disable-next-line no-await-in-loop
        contact = await findContactByEmail(e);
        if (contact) break;
      }

      if (!contact) {
        if (!write) {
          stats.created += 1; // "would create"
          if (samples.created.length < 10) samples.created.push(candidates[0]);
        } else {
          const fields = {
            contact_id: uuid(),
            email: candidates[0],
            last_updated: nowIso(),
          };
          const first = clean(row.first_name, 80);
          const last = clean(row.last_name, 80);
          if (first) fields.first_name = first;
          if (last) fields.last_name = last;
          const seen = isoDate(row.first_seen);
          if (seen) fields.date_first_seen = seen;
          fields.first_source_channel = "Other";

          // createRow, not matchOrCreateContact — see the note at the top.
          // It still routes through createContact, so the new contact gets a
          // unique referral code like everybody else.
          // eslint-disable-next-line no-await-in-loop
          contact = await createRow(CONTACTS, fields);
          stats.created += 1;
          if (samples.created.length < 10) samples.created.push(candidates[0]);
        }
      } else {
        stats.already_known += 1;
      }

      // Timeline row, so an email to the Premier sits alongside that
      // supporter's petition signature and donations. Keyed on the address so
      // re-running the import cannot double up.
      if (write && withEvents && contact && contact.id) {
        // eslint-disable-next-line no-await-in-loop
        await logEventIdempotent({
          contactRecordId: contact.id,
          event_type: EVENT_TYPE,
          meta_event_id: `demand_carroll_${candidates[0]}`,
          timestamp: isoDate(row.first_seen) || nowIso(),
          source_channel: "Other",
          payload: {
            source: "email_action_backfill",
            campaign: "demand-carroll",
            messages: Number(row.messages) || 1,
          },
          fanout: false,
        }).then(() => { stats.events_written += 1; })
          .catch((e) => { console.error("import event:", e.message); });
      }
    } catch (e) {
      stats.errors += 1;
      // Never log the address itself — this runs against real supporter data.
      if (samples.errors.length < 5) samples.errors.push(e.message.slice(0, 160));
      console.error("import-demand-senders row failed:", e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    mode: write ? "write" : "dry-run",
    events: withEvents,
    stats,
    samples,
    note: write
      ? "contacts created without bumping the public signature counter"
      : "nothing was written; re-run with &write=1 to apply",
  });
};
