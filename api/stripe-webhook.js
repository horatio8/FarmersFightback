// Vercel serverless function: receives Stripe webhook events from the
// donation Stripe account and fires Meta CAPI "Purchase" events for every
// successful charge — one-off or subscription rebill.
//
// Wired in the donation account's Stripe Dashboard → Developers →
// Webhooks → endpoint URL:
//   https://farmersfightback.com/api/stripe-webhook
// Events to subscribe to:
//   - checkout.session.completed   (one-off payments)
//   - invoice.paid                  (subscription first charge + every rebill)
//
// Rally ticket sales live on a separate Stripe account and have their
// own webhook handler at /api/rally-webhook — this endpoint does NOT
// process rally traffic.
//
// Environment variables required:
//   STRIPE_WEBHOOK_SECRET  — Stripe signing secret (whsec_...)
//   STRIPE_SECRET_KEY      — Stripe restricted API key (read: Checkout
//                            Sessions, Payment Links, Customers, Invoices)
//   META_PIXEL_ID          — used by ./_meta
//   META_CAPI_TOKEN        — used by ./_meta

const crypto = require("crypto");
const { postEvent } = require("./_meta");
const { splitName } = require("./_util");
const {
  matchOrCreateContact,
  logEventIdempotent,
  updateContactStatusFromEvent,
} = require("./_airtable");

// Disable Vercel's automatic body parsing — Stripe signature verification
// requires the raw request body bytes.
module.exports.config = { api: { bodyParser: false } };

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Verify Stripe webhook signature manually (HMAC-SHA256), matching the
// algorithm in Stripe's official SDK. Tolerates a 5-minute clock skew.
// https://docs.stripe.com/webhooks#verify-manually
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const idx = p.indexOf("=");
      return [p.slice(0, idx), p.slice(idx + 1)];
    })
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  // Reject events older than 5 minutes — replay-attack mitigation.
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age > 300) return false;

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const computed = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  // Timing-safe compare
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!r.ok) throw new Error(`Stripe ${path} → ${r.status}`);
  return r.json();
}

// Pull whatever customer details Stripe has for us. Different events
// expose customer data in different shapes; we try a couple of paths.
async function resolveCustomerDetails(obj) {
  // checkout.session.completed:
  //   obj.customer_details = { email, name, phone, address: { postal_code, country } }
  // invoice.paid:
  //   obj.customer_email, obj.customer_name, obj.customer_phone, obj.customer_address
  const direct = obj.customer_details || {
    email: obj.customer_email,
    name: obj.customer_name,
    phone: obj.customer_phone,
    address: obj.customer_address,
  };
  if (direct.email || direct.name) return direct;

  // Last-resort: look up the Customer by ID if we have one.
  if (obj.customer && STRIPE_KEY) {
    try {
      const c = await stripeGet(`customers/${obj.customer}`);
      return {
        email: c.email,
        name: c.name,
        phone: c.phone,
        address: c.address,
      };
    } catch (e) {
      console.error("stripe customer lookup failed:", e.message);
    }
  }
  return direct;
}

// Identity-match the Stripe customer to a Contact, log a Donation event in
// Airtable, update status. Idempotent via meta_event_id = stripe_<obj.id>.
// Best-effort: errors are logged but not thrown, so a transient Airtable
// outage doesn't block the Meta CAPI fire or trigger a Stripe retry.
async function recordDonationInAirtable({ stripe_event_id, details, amount_minor, currency, contentName, fbclid, fbp, sourceUrl, petitionSlug, stripeObjectId, stripeObjectType, rawStripeObject }) {
  try {
    const { fn, ln } = splitName(details && details.name);
    const { record } = await matchOrCreateContact({
      first_name: fn,
      last_name: ln,
      email: details && details.email,
      mobile: details && details.phone,
      postcode: details && details.address && details.address.postal_code,
      fbclid,
      fbp,
      source_channel: fbclid ? "Facebook" : "Direct",
    });
    await logEventIdempotent({
      contactRecordId: record.id,
      event_type: "Donation",
      // Curated structured fields up top for quick scanning, full raw
      // Stripe object underneath so nothing is ever lost.
      payload: {
        stripe_object_type: stripeObjectType,
        stripe_object_id: stripeObjectId,
        amount: amount_minor,
        currency: (currency || "aud").toUpperCase(),
        content_name: contentName,
        source_url: sourceUrl,
        petition_slug: petitionSlug || null,
        fbclid,
        fbp,
        customer: {
          email: details && details.email,
          name: details && details.name,
          phone: details && details.phone,
          postcode: details && details.address && details.address.postal_code,
          country: details && details.address && details.address.country,
        },
        raw: rawStripeObject,
      },
      fbclid,
      meta_event_id: stripe_event_id,
    });
    try {
      await updateContactStatusFromEvent(record.id, "Donation", record.fields.status);
    } catch (e) {
      console.error("airtable status update failed:", e.message);
    }
  } catch (e) {
    console.error("airtable donation write failed:", e.message);
  }
}

async function fireCAPIPurchase({ event_id, amount_minor, currency, details, contentName, sourceUrl, fbc, fbp, ip, userAgent }) {
  const { fn, ln } = splitName(details && details.name);
  const user_data = {
    em: details && details.email,
    fn,
    ln,
    ph: details && details.phone,
    zp: details && details.address && details.address.postal_code,
    country: details && details.address && details.address.country
      ? String(details.address.country).toLowerCase()
      : "au",
    fbc,
    fbp,
  };
  const value = Math.round((amount_minor || 0)) / 100;
  return postEvent({
    event_name: "Purchase",
    event_id,
    event_source_url: sourceUrl || "https://farmersfightback.com/donate",
    action_source: "website",
    user_data,
    custom_data: {
      value,
      currency: (currency || "AUD").toUpperCase(),
      content_name: contentName || "Donation",
    },
    ip,
    userAgent,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");

  if (!WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET not set");
    return res.status(500).send("Server misconfigured");
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(400).send("Failed to read body");
  }

  const sig = req.headers["stripe-signature"];
  if (!verifyStripeSignature(raw, sig, WEBHOOK_SECRET)) {
    return res.status(400).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // Acknowledge fast — Stripe expects a 2xx within 10s.
  // We still do the work synchronously below because Vercel functions
  // terminate after the response is sent; if Meta is slow, Stripe will
  // retry on non-2xx, but typical Meta latency is <500ms so this is fine.

  try {
    const type = event.type;
    const obj = event.data && event.data.object;
    const ua = req.headers["user-agent"];
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress;

    if (type === "checkout.session.completed") {
      // Subscription first charges also fire invoice.paid — skip them here
      // to avoid double-counting.
      if (obj.mode === "subscription") {
        return res.status(200).json({ received: true, skipped: "subscription handled by invoice.paid" });
      }
      if (obj.payment_status !== "paid") {
        return res.status(200).json({ received: true, skipped: `payment_status=${obj.payment_status}` });
      }

      const details = await resolveCustomerDetails(obj);
      const meta = (obj.metadata && (obj.metadata.ff_meta || obj.metadata)) || {};
      await recordDonationInAirtable({
        stripe_event_id: `stripe_${obj.id}`,
        details,
        amount_minor: obj.amount_total,
        currency: obj.currency,
        contentName: meta.content_name || "One-off Donation",
        fbclid: meta.fbclid,
        fbp: meta.fbp,
        sourceUrl: meta.source_url,
        petitionSlug: obj.client_reference_id || null,
        stripeObjectId: obj.id,
        stripeObjectType: "checkout.session",
        rawStripeObject: obj,
      });
      await fireCAPIPurchase({
        event_id: `stripe_${obj.id}`,                   // idempotent across retries
        amount_minor: obj.amount_total,
        currency: obj.currency,
        details,
        contentName: meta.content_name || "One-off Donation",
        sourceUrl: meta.source_url,
        fbc: meta.fbc,
        fbp: meta.fbp,
        ip,
        userAgent: ua,
      });
      return res.status(200).json({ received: true, fired: "Purchase" });
    }

    if (type === "invoice.paid") {
      if (obj.status !== "paid") {
        return res.status(200).json({ received: true, skipped: `status=${obj.status}` });
      }
      // invoice.paid fires for subscription first charge AND every rebill.
      // We pull the originating Checkout Session's metadata (if available)
      // by reading the subscription, so we can carry fbc/fbp/source_url
      // through to the rebill events too.
      let meta = {};
      let details = await resolveCustomerDetails(obj);
      if (obj.subscription && STRIPE_KEY) {
        try {
          const sub = await stripeGet(`subscriptions/${obj.subscription}`);
          meta = sub.metadata || {};
          if (!details.email && sub.customer) {
            const c = await stripeGet(`customers/${sub.customer}`);
            details = { email: c.email, name: c.name, phone: c.phone, address: c.address };
          }
        } catch (e) {
          console.error("subscription lookup failed:", e.message);
        }
      }

      await recordDonationInAirtable({
        stripe_event_id: `stripe_${obj.id}`,
        details,
        amount_minor: obj.amount_paid,
        currency: obj.currency,
        contentName: meta.content_name || "Monthly Donation",
        fbclid: meta.fbclid,
        fbp: meta.fbp,
        sourceUrl: meta.source_url,
        // Subscription rebills don't carry client_reference_id on the
        // invoice — we'd need to look up the original checkout session
        // to recover the petition slug. For now leave null on rebills.
        petitionSlug: meta.petition_slug || null,
        stripeObjectId: obj.id,
        stripeObjectType: "invoice",
        rawStripeObject: obj,
      });
      await fireCAPIPurchase({
        event_id: `stripe_${obj.id}`,
        amount_minor: obj.amount_paid,
        currency: obj.currency,
        details,
        contentName: meta.content_name || "Monthly Donation",
        sourceUrl: meta.source_url,
        fbc: meta.fbc,
        fbp: meta.fbp,
        ip,
        userAgent: ua,
      });
      return res.status(200).json({ received: true, fired: "Purchase" });
    }

    return res.status(200).json({ received: true, ignored: type });
  } catch (err) {
    console.error("stripe-webhook handler error:", err);
    // Return 500 so Stripe retries — better than silently dropping the event.
    return res.status(500).json({ error: "handler error" });
  }
};
