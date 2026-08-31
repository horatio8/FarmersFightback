// One-off repair: a donation checkout session that a pre-cutover deploy of
// /api/rally-webhook booked as a rally ticket gets re-booked as the
// Donation it is — through the SAME pipeline every donation uses
// (processDonationEvent → contact match, Donation event + fanout, status
// update, Meta CAPI), not a hand-written record.
//
// GET /api/admin/repair-donation-event?token=ADMIN_TOKEN&session_id=cs_...
//   Dry-run: reports what would be deleted and rebooked.
// ...&write=1
//   Deletes the mis-booked "Rally Ticket Purchased" Events row + Rally
//   Tickets row for that session, then replays the session through the
//   donation pipeline. Idempotent: the Donation books under
//   meta_event_id stripe_<session_id>, so running twice writes once.

const {
  listRows,
  atFetch,
  escapeFormula,
  EVENTS_BASE_ID,
  MAIN_BASE_ID,
} = require("../_airtable");
const { fundraisingReadKeys } = require("../_stripe-fundraising");
const { processDonationEvent } = require("../stripe-webhook");

const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";
const TICKETS = process.env.AIRTABLE_RALLY_TICKETS_TABLE || "Rally Tickets";

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const url = new URL(req.url, "https://x");
  const sessionId = url.searchParams.get("session_id") || "";
  const write = url.searchParams.get("write") === "1";
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return res.status(400).json({ error: "session_id must be a Stripe checkout session id" });
  }

  try {
    // The session itself is the source of truth for what this money was.
    let session = null;
    let sessionKey = null;
    for (const key of fundraisingReadKeys()) {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (r.ok) { session = await r.json(); sessionKey = key; break; }
      if (r.status !== 404) throw new Error(`Stripe ${r.status}`);
    }
    if (!session) return res.status(404).json({ error: "session not found on any configured account" });

    const meta = session.metadata || {};
    if (meta.ff_content_type === "rally_ticket") {
      return res.status(400).json({ error: "that session IS a rally ticket — nothing to repair" });
    }
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: `session is not paid (${session.payment_status})` });
    }
    if (session.mode === "subscription") {
      // processDonationEvent books subscriptions from invoice.paid, not the
      // session — deleting the mis-booked rows here would leave the money in
      // no ledger. Resend the invoice.paid event from the Stripe dashboard
      // instead (the new webhook routing will book it), then re-run this.
      return res.status(400).json({ error: "subscription session — replay its invoice.paid event instead of this repair" });
    }

    // The rows the old dispatcher wrote under its ticket identity.
    const misEvent = await listRows(EVENTS, {
      formula: `{meta_event_id}='${escapeFormula(`stripe_rally_${sessionId}`)}'`,
      maxRecords: 5,
    });
    const misTicket = await listRows(TICKETS, {
      formula: `{stripe_session_id}='${escapeFormula(sessionId)}'`,
      maxRecords: 5,
    });

    const out = {
      session_id: sessionId,
      amount: (session.amount_total || 0) / 100,
      donor: session.customer_details && session.customer_details.email,
      misbooked_event_rows: misEvent.map((r) => r.id),
      misbooked_ticket_rows: misTicket.map((r) => r.id),
      write,
    };

    if (!write) {
      out.note = "dry run — add &write=1 to delete the mis-booked rows and re-book as a Donation";
      return res.status(200).json(out);
    }

    for (const r of misEvent) {
      // eslint-disable-next-line no-await-in-loop
      await atFetch(`${encodeURIComponent(EVENTS)}/${r.id}`, { method: "DELETE", baseId: EVENTS_BASE_ID });
    }
    for (const r of misTicket) {
      // eslint-disable-next-line no-await-in-loop
      await atFetch(`${encodeURIComponent(TICKETS)}/${r.id}`, { method: "DELETE", baseId: MAIN_BASE_ID });
    }

    const booked = await processDonationEvent("checkout.session.completed", session, {
      stripeKey: sessionKey,
      ip: undefined,
      userAgent: undefined,
    });
    out.deleted = { events: misEvent.length, tickets: misTicket.length };
    out.rebooked = booked;
    return res.status(200).json(out);
  } catch (e) {
    console.error("repair-donation-event:", e.message);
    return res.status(500).json({ error: e.message.slice(0, 300) });
  }
};
