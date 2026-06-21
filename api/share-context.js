// Vercel serverless function: returns the share context (referral_code +
// first_name + contact_id) for the donor on the /share thank-you page.
//
// Lookup modes (first match wins):
//   1. ?session_id=cs_xxx      → resolve Stripe Checkout Session → customer
//                                 email → Contacts. Used right after Stripe
//                                 redirect, when the webhook has just landed.
//   2. ?email=jane@example.com → direct Contacts lookup by email. Used as a
//                                 fallback when localStorage is empty and no
//                                 session_id is present.
//
// Returns 404 if no contact found yet — the client polls until success or
// gives up.
//
// GET /api/share-context?session_id=cs_xxx
// GET /api/share-context?email=jane@example.com
// Response: { referral_code, first_name, contact_id }

const {
  findContactByEmail,
  setReferralCodeIfMissing,
} = require("./_airtable");

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
  "https://farmersfightback-tellerconsulting.vercel.app",
]);
function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

async function fetchCheckoutSession(sessionId) {
  if (!STRIPE_KEY || !sessionId) return null;
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!r.ok) return null;
  return r.json();
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const sessionId = url.searchParams.get("session_id") || "";
    const email = url.searchParams.get("email") || "";

    let lookupEmail = email;
    let petitionSlug = "";
    if (sessionId) {
      const session = await fetchCheckoutSession(sessionId);
      if (session) {
        if (!lookupEmail) {
          lookupEmail = (session.customer_details && session.customer_details.email) || session.customer_email || "";
        }
        petitionSlug = session.client_reference_id || "";
      }
    }
    if (!lookupEmail) {
      return res.status(400).json({ error: "session_id or email required" });
    }

    const contact = await findContactByEmail(lookupEmail);
    if (!contact) {
      // Likely the Stripe webhook hasn't finished writing yet. Client polls.
      return res.status(404).json({ error: "Contact not found yet" });
    }

    // Donors who came straight via Stripe may not have a referral_code yet
    // (the webhook is best-effort about this); ensure one before responding.
    const referralCode = await setReferralCodeIfMissing(contact.id, contact.fields);

    return res.status(200).json({
      contact_id: contact.fields.contact_id,
      referral_code: referralCode,
      first_name: contact.fields.first_name || "",
      petition_slug: petitionSlug || null,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("share-context error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
