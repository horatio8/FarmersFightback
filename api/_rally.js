// Shared recorder for a completed rally ticket purchase. Called from two
// places so a paid ticket lands in Airtable no matter which path fires:
//   1. api/rally-webhook.js — Stripe's checkout.session.completed webhook
//      (server-to-server; only reaches a PUBLIC deployment, i.e. production).
//   2. api/rally-checkout.js — the GET ?session_id= lookup the /rally
//      confirmation page makes on return from Stripe (works everywhere,
//      including SSO-protected preview deploys the webhook can't reach).
//
// Both pass the Stripe Checkout Session object. Idempotent via
// meta_event_id = stripe_rally_<session.id>, so the two paths (and page
// refreshes / webhook retries) never double-write.

const {
  matchOrCreateContact,
  setReferralCodeIfMissing,
  logEventIdempotent,
  listRows,
} = require("./_airtable");
const { splitName } = require("./_util");

// ---- Ticket sales close ---------------------------------------------------
//
// Sales end at whichever comes FIRST (owner decision, 18 Aug 2026):
//   - 1,044 tickets sold, the ground's capacity; or
//   - midnight at the end of Wednesday 26 August, Melbourne time
//     (2026-08-26 24:00 AEST = 2026-08-26T14:00:00Z), so the gate list and
//     catering can be locked before the weekend.
//
// The check is enforced HERE, at session creation, not only in the page: a
// cached page or a direct POST must not be able to sell ticket 1,045.
//
// The count sums every seat in Rally Tickets (paid and comped alike — the
// ground does not care who paid). Two buyers racing the last seats can still
// both pass, and someone already inside Stripe's form when the cap falls will
// still complete; the cap is a gate, not a ledger lock, and a couple of seats
// past 1,044 is an accepted cost of keeping checkout simple.
//
// If Airtable cannot be reached the COUNT check fails OPEN (a down database
// must not stop the last day of sales) — the TIME check needs nothing and
// always holds.
const TICKET_CAP = 1044;
const SALES_CLOSE_UTC = "2026-08-26T14:00:00.000Z";
const TICKETS_TABLE = process.env.AIRTABLE_RALLY_TICKETS_TABLE || "Rally Tickets";
const SALES_CLOSED_MESSAGE =
  "We're sorry — ticket sales have now closed. The response has been bigger than we ever hoped, "
  + "and the night is at capacity. If you already have tickets, we'll see you at the gate.";

async function ticketSalesState(now = Date.now()) {
  if (now >= Date.parse(SALES_CLOSE_UTC)) {
    return { closed: true, reason: "time", message: SALES_CLOSED_MESSAGE };
  }
  try {
    const rows = await listRows(TICKETS_TABLE, { fields: ["total_qty", "adult_qty", "kid_qty"] });
    const sold = rows.reduce((s, r) => {
      const f = r.fields || {};
      const q = Number(f.total_qty) || (Number(f.adult_qty) || 0) + (Number(f.kid_qty) || 0);
      return s + q;
    }, 0);
    if (sold >= TICKET_CAP) {
      return { closed: true, reason: "sold_out", sold, message: SALES_CLOSED_MESSAGE };
    }
    return { closed: false, sold };
  } catch (e) {
    console.error("ticketSalesState count failed (failing open):", e.message);
    return { closed: false, count_unavailable: true };
  }
}

async function recordRallyTicketPurchase({ session }) {
  if (!session || !session.id) return { ok: false, error: "no session" };
  try {
    const meta = (session.metadata && (session.metadata.ff_meta || session.metadata)) || {};
    const details = session.customer_details || {};
    const addr = details.address || {};

    // Prefer the identity we captured pre-payment (metadata) for names;
    // Stripe's customer_details for what the buyer typed into the card form.
    const { fn: nameFn, ln: nameLn } = splitName(details.name);
    const first_name = meta.first_name || nameFn;
    const last_name = meta.last_name || nameLn;
    const email = details.email || meta.email;
    const phone = details.phone || meta.phone;
    const postcode = addr.postal_code || meta.postcode;

    const { record } = await matchOrCreateContact({
      first_name, last_name, email, mobile: phone, postcode,
      fbclid: meta.fbclid, fbp: meta.fbp,
      source_channel: "Rally Ticket Funnel",
    });
    try { await setReferralCodeIfMissing(record.id, record.fields); } catch (e) {}

    const adult_qty = Number(meta.adult_qty) || 0;
    const kid_qty = Number(meta.kid_qty) || 0;

    await logEventIdempotent({
      contactRecordId: record.id,
      event_type: "Rally Ticket Purchased",
      payload: {
        stripe_object_type: "checkout.session",
        stripe_object_id: session.id,
        stripe_payment_intent: typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent && session.payment_intent.id) || null,
        stripe_account: "rally",
        amount: session.amount_total,
        currency: session.currency,
        content_name: "Rally Ticket",
        adult_qty,
        kid_qty,
        total_qty: adult_qty + kid_qty,
        source_url: meta.source_url,
        fbclid: meta.fbclid,
        fbp: meta.fbp,
        ref: meta.ref || null,
        referral_code: meta.referral_code || null,
        customer: {
          first_name, last_name,
          email, name: details.name, phone, postcode,
          country: addr.country,
        },
        raw: session,
      },
      fbclid: meta.fbclid,
      referral_code_used: meta.ref || undefined,
      source_channel: "Rally Ticket Funnel",
      meta_event_id: `stripe_rally_${session.id}`,
    });
    return { ok: true, contact_id: record.id };
  } catch (e) {
    console.error("recordRallyTicketPurchase failed:", e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { recordRallyTicketPurchase, ticketSalesState, TICKET_CAP, SALES_CLOSE_UTC };
