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
} = require("./_airtable");

async function recordRallyTicketPurchase({ session }) {
  if (!session || !session.id) return { ok: false, error: "no session" };
  try {
    const meta = (session.metadata && (session.metadata.ff_meta || session.metadata)) || {};
    const details = session.customer_details || {};
    const addr = details.address || {};

    // Prefer the identity we captured pre-payment (metadata) for names;
    // Stripe's customer_details for what the buyer typed into the card form.
    const first_name = meta.first_name || (details.name ? details.name.split(" ")[0] : undefined);
    const last_name = meta.last_name || (details.name ? details.name.split(" ").slice(-1)[0] : undefined);
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

module.exports = { recordRallyTicketPurchase };
