// Vercel serverless function: receives Stripe webhook events from the
// Rally's own Stripe account (Wallaloo & Gre Gre District Alliance) and
// writes each ticket purchase to Airtable + fires Meta CAPI "Purchase"
// for ad attribution.
//
// The rally uses a separate Stripe account from the site's donation
// flow, so its webhook lives on its own path with its own signing
// secret. This handler processes ONLY rally ticket events; the donation
// account's webhook stays wired to /api/stripe-webhook and is untouched.
//
// Wired in the Wallaloo/GreGre Stripe Dashboard → Developers → Webhooks:
//   Endpoint URL: https://www.farmersfightback.com/api/rally-webhook
//   Events to subscribe to:
//     - checkout.session.completed
//
// Env:
//   STRIPE_RALLY_WEBHOOK_SECRET  Signing secret (whsec_...) for this
//                                account's webhook endpoint. NOT the
//                                donation account's webhook secret.
//   STRIPE_RALLY_SECRET_KEY      Restricted secret key for the rally
//                                account, used for the customer-lookup
//                                fallback when the event doesn't carry
//                                embedded customer_details.
//   META_PIXEL_ID                Used by ./_meta (same Meta account)
//   META_CAPI_TOKEN              Used by ./_meta (same Meta account)

const crypto = require("crypto");
const { postEvent } = require("./_meta");
const { splitName } = require("./_util");
const { recordRallyTicketPurchase } = require("./_rally");

module.exports.config = { api: { bodyParser: false } };

const WEBHOOK_SECRET = process.env.STRIPE_RALLY_WEBHOOK_SECRET;
const STRIPE_KEY = process.env.STRIPE_RALLY_SECRET_KEY;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Identical algorithm to stripe-webhook.js — Stripe's signature scheme
// doesn't vary by account. We just verify against a different secret.
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
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age > 300) return false;
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const computed = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
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

async function resolveCustomerDetails(obj) {
  const direct = obj.customer_details || {
    email: obj.customer_email,
    name: obj.customer_name,
    phone: obj.customer_phone,
    address: obj.customer_address,
  };
  if (direct.email || direct.name) return direct;
  if (obj.customer && STRIPE_KEY) {
    try {
      const c = await stripeGet(`customers/${obj.customer}`);
      return { email: c.email, name: c.name, phone: c.phone, address: c.address };
    } catch (e) {
      console.error("stripe customer lookup failed:", e.message);
    }
  }
  return direct;
}

async function fireCAPIPurchase({ event_id, amount_minor, currency, details, sourceUrl, fbc, fbp, ip, userAgent }) {
  const { fn, ln } = splitName(details && details.name);
  const user_data = {
    em: details && details.email,
    fn, ln,
    ph: details && details.phone,
    zp: details && details.address && details.address.postal_code,
    country: details && details.address && details.address.country
      ? String(details.address.country).toLowerCase()
      : "au",
    fbc, fbp,
  };
  const value = Math.round((amount_minor || 0)) / 100;
  return postEvent({
    event_name: "Purchase",
    event_id,
    event_source_url: sourceUrl || "https://www.farmersfightback.com/rally",
    action_source: "website",
    user_data,
    custom_data: {
      value,
      currency: (currency || "AUD").toUpperCase(),
      content_name: "Rally Ticket",
    },
    ip,
    userAgent,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");

  if (!WEBHOOK_SECRET) {
    console.error("STRIPE_RALLY_WEBHOOK_SECRET not set");
    return res.status(500).send("Server misconfigured");
  }

  let raw;
  try { raw = await readRawBody(req); } catch (e) { return res.status(400).send("Failed to read body"); }

  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], WEBHOOK_SECRET)) {
    return res.status(400).send("Invalid signature");
  }

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("Invalid JSON"); }

  try {
    const type = event.type;
    const obj = event.data && event.data.object;
    const ua = req.headers["user-agent"];
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress;

    if (type !== "checkout.session.completed") {
      return res.status(200).json({ received: true, ignored: type });
    }
    if (obj.payment_status !== "paid") {
      return res.status(200).json({ received: true, skipped: `payment_status=${obj.payment_status}` });
    }

    const details = await resolveCustomerDetails(obj);
    const meta = (obj.metadata && (obj.metadata.ff_meta || obj.metadata)) || {};

    // Defensive: on the rally account, EVERY checkout should be a rally
    // ticket. Log a warning if metadata says otherwise but process anyway
    // so a mis-tagged sale still lands in Airtable.
    if (meta.ff_content_type && meta.ff_content_type !== "rally_ticket") {
      console.warn(`rally-webhook: unexpected ff_content_type "${meta.ff_content_type}" on rally account, processing anyway`);
    }

    // Airtable write via the shared recorder — idempotent on the session id,
    // so this is safe alongside the confirmation-page recorder in
    // rally-checkout.js (whichever runs first wins; the other no-ops).
    await recordRallyTicketPurchase({ session: obj });

    await fireCAPIPurchase({
      event_id: `stripe_rally_${obj.id}`,
      amount_minor: obj.amount_total,
      currency: obj.currency,
      details,
      sourceUrl: meta.source_url,
      fbc: meta.fbc,
      fbp: meta.fbp,
      ip,
      userAgent: ua,
    });

    return res.status(200).json({ received: true, fired: "Purchase", type: "rally_ticket" });
  } catch (err) {
    console.error("rally-webhook handler error:", err);
    return res.status(500).json({ error: "handler error" });
  }
};
