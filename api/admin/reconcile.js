// Read-only reconciliation tallies, one store per call:
//
//   GET /api/admin/reconcile?token=ADMIN_TOKEN&part=contacts
//     { total, by_status, by_source }
//   ...&part=signatures     { total, with_contact, with_email, distinct_emails }
//   ...&part=donations      { total, sum_amount, with_stripe_id, dupe_stripe_ids }
//   ...&part=tickets        { total, by_payment_status, adult_qty, total_qty,
//                             sum_amount, dupe_payment_intents }
//   ...&part=events         { by_event_type, by_fanout_status } for the four
//                           event types that project into typed tables
//   ...&part=fanout_failures  events whose projection did not land
//
// Each part is a full paged scan, sized to fit one 300s invocation on its
// own — that is why they are separate calls rather than one report. Events
// reads go through listRows, which sweeps both bases, so history counts
// whether or not the migration has finished.
//
// Nothing here writes, and no payload or contact detail leaves the endpoint —
// tallies, sums and duplicate KEYS only (stripe ids are opaque references).

const { listRows, escapeFormula } = require("../_airtable");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const SIGNATURES = process.env.AIRTABLE_PETITION_SIGNATURES_TABLE || "Petition Signatures";
const DONATIONS = process.env.AIRTABLE_DONATIONS_TABLE || "Donations";
const TICKETS = process.env.AIRTABLE_RALLY_TICKETS_TABLE || "Rally Tickets";
const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";

const PROJECTED_TYPES = ["Petition Signed", "Donation", "Rally Ticket Purchased", "Rally Ticket Comped"];

// Count rows by the value of one field. Selects arrive either as strings or
// as {name} objects depending on the client; normalise both.
function tally(rows, field) {
  const out = {};
  for (const r of rows) {
    const v = r.fields && r.fields[field];
    const key = v == null || v === "" ? "(blank)" : (v.name || String(v));
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// Values of a key field that appear on more than one row — the shape a
// double-write would leave behind.
function dupes(rows, field) {
  const seen = new Map();
  for (const r of rows) {
    const v = r.fields && r.fields[field];
    if (!v) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => ({ value: v, rows: n }));
}

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const url = new URL(req.url, "https://x");
  const part = url.searchParams.get("part") || "";
  const started = Date.now();

  try {
    let out;
    if (part === "contacts") {
      const rows = await listRows(CONTACTS, { fields: ["status", "source_channel"] });
      out = { total: rows.length, by_status: tally(rows, "status"), by_source: tally(rows, "source_channel") };
    } else if (part === "signatures") {
      const rows = await listRows(SIGNATURES, { fields: ["contact", "email", "lead_source"] });
      const emails = new Set(rows.map((r) => r.fields && r.fields.email).filter(Boolean));
      out = {
        total: rows.length,
        with_contact: rows.filter((r) => (r.fields.contact || []).length).length,
        with_email: rows.filter((r) => r.fields.email).length,
        distinct_emails: emails.size,
        by_lead_source: tally(rows, "lead_source"),
      };
    } else if (part === "donations") {
      const rows = await listRows(DONATIONS, { fields: ["amount", "stripe_object_id", "currency"] });
      out = {
        total: rows.length,
        sum_amount: Math.round(rows.reduce((s, r) => s + (Number(r.fields.amount) || 0), 0) * 100) / 100,
        with_stripe_id: rows.filter((r) => r.fields.stripe_object_id).length,
        dupe_stripe_ids: dupes(rows, "stripe_object_id"),
      };
    } else if (part === "tickets") {
      const rows = await listRows(TICKETS, {
        fields: ["payment_status", "adult_qty", "total_qty", "amount", "stripe_payment_intent", "order_ref"],
      });
      out = {
        total: rows.length,
        by_payment_status: tally(rows, "payment_status"),
        adult_qty: rows.reduce((s, r) => s + (Number(r.fields.adult_qty) || 0), 0),
        total_qty: rows.reduce((s, r) => s + (Number(r.fields.total_qty) || 0), 0),
        sum_amount: Math.round(rows.reduce((s, r) => s + (Number(r.fields.amount) || 0), 0) * 100) / 100,
        dupe_payment_intents: dupes(rows, "stripe_payment_intent"),
        dupe_order_refs: dupes(rows, "order_ref"),
      };
    } else if (part === "events") {
      const formula = `OR(${PROJECTED_TYPES.map((t) => `{event_type}='${escapeFormula(t)}'`).join(",")})`;
      const rows = await listRows(EVENTS, { formula, fields: ["event_type", "fanout_status"] });
      out = { total: rows.length, by_event_type: tally(rows, "event_type"), by_fanout_status: tally(rows, "fanout_status") };
    } else if (part === "fanout_failures") {
      const rows = await listRows(EVENTS, {
        formula: `OR({fanout_status}='Failed', {fanout_status}='No Typed Table')`,
        fields: ["event_id", "event_type", "timestamp", "fanout_status", "fanout_error"],
      });
      out = {
        total: rows.length,
        by_event_type: tally(rows, "event_type"),
        sample: rows.slice(0, 20).map((r) => r.fields),
      };
    } else {
      return res.status(400).json({
        error: "unknown part",
        parts: ["contacts", "signatures", "donations", "tickets", "events", "fanout_failures"],
      });
    }
    out.part = part;
    out.elapsed_s = Math.round((Date.now() - started) / 1000);
    return res.status(200).json(out);
  } catch (e) {
    console.error("reconcile:", e.message);
    return res.status(500).json({ error: e.message.slice(0, 300) });
  }
};

module.exports.tally = tally;
module.exports.dupes = dupes;
