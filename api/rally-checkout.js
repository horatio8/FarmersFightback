// Vercel serverless function: creates a Stripe Embedded Checkout Session
// for the Farmers Fightback Rally and returns its client_secret so the
// front-end can mount Stripe's payment form inline on /rally. Also
// supports GET ?session_id=X to read a session's basic details back on
// the return trip (so the /rally confirmation page can render name/qty
// from Stripe rather than trusting the client to preserve them).
//
// POST /api/rally-checkout
// Body: { adult_qty, kid_qty, first_name, last_name, email, phone,
//         postcode, ref }
// Response: { client_secret, publishable_key }
//   - client_secret is passed to stripe.initEmbeddedCheckout on the client
//   - publishable_key lets us keep pk_live_... out of the git repo
//
// GET /api/rally-checkout?session_id=cs_...
// Response: { session: { first_name, last_name, email, phone, postcode,
//                        adult_qty, kid_qty, referral_code } }
//
// The rally sits on its own Stripe account (Wallaloo & Gre Gre District
// Alliance), separate from the site's donation account. Env vars for that
// account are prefixed STRIPE_RALLY_* so the two accounts never share
// credentials.
//
// Env:
//   STRIPE_RALLY_SECRET_KEY         Restricted secret key (sk_live_...)
//                                   with Checkout Sessions read+write
//   STRIPE_RALLY_PUBLISHABLE_KEY    Publishable key (pk_live_...) —
//                                   safe to be public, served via this
//                                   API so it stays out of the repo
//   STRIPE_RALLY_ADULT_PRICE_ID     Price ID for the adult ticket
//   STRIPE_RALLY_KID_PRICE_ID       Price ID for the kids ticket
//                                   (optional — omit if adult-only)
//   RALLY_SUCCESS_URL_BASE          Optional; defaults to
//                                   https://<host>/rally
//
// The Airtable write happens in api/rally-webhook.js when Stripe fires
// checkout.session.completed on the rally account — that's where the
// payment is confirmed. This endpoint's job is just to mint the session.

const { matchOrCreateContact, setReferralCodeIfMissing, logEvent } = require("./_airtable");
const { recordRallyTicketPurchase } = require("./_rally");

const STRIPE_KEY = process.env.STRIPE_RALLY_SECRET_KEY;
const STRIPE_PK = process.env.STRIPE_RALLY_PUBLISHABLE_KEY;
const ADULT_PRICE_ID = process.env.STRIPE_RALLY_ADULT_PRICE_ID;
const KID_PRICE_ID = process.env.STRIPE_RALLY_KID_PRICE_ID;

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

async function stripeFetch(path, opts = {}) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`Stripe ${r.status}: ${body.slice(0, 400)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Flatten a nested object into Stripe's form-encoded style, e.g.
// { line_items: [{ price: "p", quantity: 2 }] } → line_items[0][price]=p&...
function toFormBody(obj, prefix = "") {
  const parts = [];
  const enc = encodeURIComponent;
  const walk = (val, key) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(v, `${key}[${i}]`));
    } else if (typeof val === "object") {
      Object.keys(val).forEach((k) => walk(val[k], `${key}[${k}]`));
    } else {
      parts.push(`${enc(key)}=${enc(String(val))}`);
    }
  };
  Object.keys(obj).forEach((k) => walk(obj[k], prefix ? `${prefix}[${k}]` : k));
  return parts.join("&");
}

function hostBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "www.farmersfightback.com";
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!STRIPE_KEY) {
    console.error("STRIPE_RALLY_SECRET_KEY not set");
    return res.status(500).json({ error: "Ticketing isn't fully configured yet. Please try again shortly." });
  }

  // GET ?session_id=X → read summary back (used on Stripe return).
  if (req.method === "GET") {
    const url = new URL(req.url, hostBase(req));
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ error: "Invalid session_id" });
    }
    try {
      const s = await stripeFetch(`checkout/sessions/${sessionId}`);
      const meta = s.metadata || {};
      const details = s.customer_details || {};

      // Confirm-on-return: if this session is paid, record the ticket now.
      // This is the primary recording path on SSO-protected preview deploys
      // (where Stripe's webhook can't reach us) and a belt-and-braces backup
      // on production. Idempotent on the session id, so it never double-writes
      // alongside the webhook. Best-effort — never block the page render.
      if (s.payment_status === "paid") {
        try { await recordRallyTicketPurchase({ session: s }); }
        catch (e) { console.error("confirm-on-return record failed:", e.message); }
      }

      return res.status(200).json({
        session: {
          first_name: meta.first_name || "",
          last_name: meta.last_name || "",
          email: details.email || meta.email || "",
          phone: details.phone || meta.phone || "",
          postcode: (details.address && details.address.postal_code) || meta.postcode || "",
          adult_qty: Number(meta.adult_qty) || 0,
          kid_qty: Number(meta.kid_qty) || 0,
          referral_code: meta.referral_code || "",
          amount_total: s.amount_total || 0,
          currency: s.currency || "aud",
        },
      });
    } catch (e) {
      console.error("rally-checkout GET:", e.message);
      return res.status(400).json({ error: "Couldn't fetch session details" });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST or GET only" });

  try {
    const body = req.body || {};
    const adult_qty = Math.max(0, Math.min(50, Number(body.adult_qty) || 0));
    const kid_qty = Math.max(0, Math.min(50, Number(body.kid_qty) || 0));
    if (adult_qty + kid_qty < 1) {
      return res.status(400).json({ error: "Add at least one ticket." });
    }
    const first_name = String(body.first_name || "").trim();
    const last_name = String(body.last_name || "").trim();
    const email = String(body.email || "").trim();
    const phone = String(body.phone || "").trim();
    const postcode = String(body.postcode || "").trim();
    const ref = String(body.ref || "").trim().toUpperCase();

    if (!first_name || !last_name || !email || !phone) {
      return res.status(400).json({ error: "Please fill in your name, email, and phone." });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    if (!ADULT_PRICE_ID && adult_qty > 0) {
      console.error("STRIPE_RALLY_ADULT_PRICE_ID not set — cannot sell adult tickets yet");
      return res.status(500).json({ error: "Ticket pricing hasn't been configured yet. Please try again shortly." });
    }
    if (!KID_PRICE_ID && kid_qty > 0) {
      console.error("STRIPE_RALLY_KID_PRICE_ID not set — cannot sell kid tickets yet");
      return res.status(500).json({ error: "Kids ticket pricing hasn't been configured yet." });
    }

    // Pre-payment identity capture so the contact exists in Airtable with
    // their referral_code before the Stripe redirect. If we don't do this
    // now, the referral_code we hand back on the confirmation page won't
    // exist yet. The stripe-webhook.js path also does match-or-create — it's
    // idempotent so this double-write is safe.
    let referral_code = "";
    try {
      const { record } = await matchOrCreateContact({
        first_name, last_name, email, mobile: phone, postcode,
        source_channel: "Rally Ticket Funnel",
      });
      referral_code = await setReferralCodeIfMissing(record.id, record.fields);
      await logEvent({
        contactRecordId: record.id,
        event_type: "Rally Ticket Started",
        payload: {
          source: "rally_funnel_paid",
          adult_qty, kid_qty,
          contact: { first_name, last_name, email, phone, postcode },
          ref: ref || null,
        },
        referral_code_used: ref || undefined,
        source_channel: "Rally Ticket Funnel",
      });
    } catch (e) {
      // Non-fatal — don't block the ticket sale if Airtable is down.
      console.error("rally pre-payment Airtable write failed:", e.message);
    }

    const base = process.env.RALLY_SUCCESS_URL_BASE || `${hostBase(req)}/rally`;
    const line_items = [];
    if (adult_qty > 0) line_items.push({ price: ADULT_PRICE_ID, quantity: adult_qty });
    if (kid_qty > 0) line_items.push({ price: KID_PRICE_ID, quantity: kid_qty });

    // Metadata carries everything the webhook needs to (a) match to a
    // Contact by identity and (b) attribute the referral. Keep values
    // short — Stripe metadata is capped at 500 chars per value.
    const metadata = {
      ff_content_type: "rally_ticket",
      first_name, last_name,
      email, phone, postcode,
      adult_qty: String(adult_qty),
      kid_qty: String(kid_qty),
      ref: ref || "",
      referral_code: referral_code || "",
      source_url: `${base}?ref=${ref || ""}`,
    };

    const session = await stripeFetch("checkout/sessions", {
      method: "POST",
      body: toFormBody({
        mode: "payment",
        ui_mode: "embedded",
        payment_method_types: ["card"],
        line_items,
        customer_email: email,
        client_reference_id: ref || "rally",
        allow_promotion_codes: false,
        // Embedded checkout uses a single return_url instead of the
        // success_url + cancel_url pair. Stripe will redirect here when
        // payment completes; if the buyer bails out mid-flow we just
        // leave the session unpaid (Stripe expires it) and they can
        // start over from /rally.
        return_url: `${base}?session_id={CHECKOUT_SESSION_ID}`,
        metadata,
        payment_intent_data: { metadata },
      }),
    });

    return res.status(200).json({
      client_secret: session.client_secret,
      publishable_key: STRIPE_PK || "",
      id: session.id,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("rally-checkout error:", err);
    return res.status(500).json({ error: "Couldn't start checkout. Please try again." });
  }
};
