// Donation checkout (Workstream 2, Pattern A): creates a Stripe Checkout
// Session on the donations account and hands the donor to Stripe's HOSTED
// page. No card data ever touches this site.
//
// POST /api/checkout   {amount, frequency: "oneoff"|"monthly", email?,
//                       slug?, ref?, contact_id?, sms_variant?,
//                       utm_source/medium/campaign/content/term?}
//   → { url }  (Stripe-hosted payment page)
//
// GET /api/checkout?amount=65&frequency=monthly&...  → 303 to Stripe.
//   Same params as POST; lets SMS/email links deep-link a prefilled ask.
//
// GET /api/checkout?session_id=cs_...  → session summary for the
//   thank-you state on /donate (amount, frequency, email, paid).
//
// Every session carries metadata {org:ff, frequency, utm_*, ref,
// contact_id, sms_variant} so revenue joins back to variant + referrer
// (72h attribution done in reporting). Also logs a Lapse Queue row so
// /api/cron/lapse-sweep can detect checkout abandons after 30 min.
//
// Env: STRIPE_SECRET_KEY / STRIPE_FUNDRAISING_SECRET_KEY — which account a
// new session lands on is decided per-request by _stripe-fundraising.

const { createRow, uuid, nowIso } = require("./_airtable");
const { toFormBody, stripeClient, hostBase } = require("./_util");
const { fundraisingKey, fundraisingReadKeys } = require("./_stripe-fundraising");

const LAPSE_TABLE = process.env.AIRTABLE_LAPSE_TABLE || "Lapse Queue";

// Create the session on whichever account the cutover clock points at.
// If that account refuses (e.g. the W&G restricted key is missing a
// permission the donation flow needs), retry once on the legacy account
// with a loud log — a gift must never be lost to a key-scope problem.
async function createOnActiveAccount(payload) {
  const key = fundraisingKey();
  try {
    return await stripeClient(key)("checkout/sessions", { method: "POST", body: toFormBody(payload) });
  } catch (e) {
    const legacy = process.env.STRIPE_SECRET_KEY;
    if (legacy && key !== legacy) {
      console.error(`fundraising-account session create failed (${e.message}) — retrying on legacy account`);
      return stripeClient(legacy)("checkout/sessions", { method: "POST", body: toFormBody(payload) });
    }
    throw e;
  }
}

// A session can only be read back by the account that created it, and
// thank-you readbacks straddle the cutover (donor pays at 23:58, lands back
// on /donate at 00:01) — so try both accounts, newest-likely first.
async function readSession(sessionId) {
  let lastErr;
  for (const key of fundraisingReadKeys()) {
    try {
      return await stripeClient(key)(`checkout/sessions/${sessionId}`);
    } catch (e) {
      lastErr = e;
      if (e.status !== 404) throw e;
    }
  }
  throw lastErr || new Error("no Stripe key configured");
}

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

function cleanParams(src) {
  const pick = (k) => {
    const v = src[k];
    return v === undefined || v === null || v === "" ? undefined : String(v).slice(0, 200);
  };
  return {
    amount: Number(src.amount),
    frequency: pick("frequency") === "monthly" ? "monthly" : "oneoff",
    email: pick("email"),
    slug: pick("slug"),
    ref: pick("ref") ? String(src.ref).toUpperCase().slice(0, 20) : undefined,
    contact_id: pick("contact_id") || pick("c"),
    sms_variant: pick("sms_variant"),
    utm_source: pick("utm_source"),
    utm_medium: pick("utm_medium"),
    utm_campaign: pick("utm_campaign"),
    utm_content: pick("utm_content"),
    utm_term: pick("utm_term"),
    fbclid: pick("fbclid"),
    fbp: pick("fbp"),
    source_url: cleanSourceUrl(src.source_url),
  };
}

// Only trust our own pages as a source_url, and keep it inside Stripe's
// 500-char metadata value limit.
function cleanSourceUrl(v) {
  if (!v) return undefined;
  try {
    const u = new URL(String(v));
    const host = u.hostname.replace(/^www\./, "");
    if (u.protocol !== "https:" || !host.endsWith("farmersfightback.com")) return undefined;
    return u.toString().slice(0, 450);
  } catch {
    return undefined;
  }
}

async function createSession(p, req) {
  const cents = Math.round(p.amount * 100);
  if (!Number.isFinite(cents) || cents < 200 || cents > 5000000) {
    const err = new Error("Amount must be between $2 and $50,000.");
    err.code = "BAD_AMOUNT";
    throw err;
  }
  const monthly = p.frequency === "monthly";
  const label = monthly ? "monthly" : "one-off";
  const base = `${hostBase(req)}/donate`;

  const metadata = {
    org: "ff",
    frequency: p.frequency,
    content_name: monthly ? "Monthly Donation" : "One-off Donation",
    source_url: p.source_url || `${base}`,
    ...(p.fbclid ? { fbclid: p.fbclid } : {}),
    ...(p.fbp ? { fbp: p.fbp } : {}),
    ...(p.ref ? { ref: p.ref } : {}),
    ...(p.contact_id ? { contact_id: p.contact_id } : {}),
    ...(p.sms_variant ? { sms_variant: p.sms_variant } : {}),
    ...(p.utm_source ? { utm_source: p.utm_source } : {}),
    ...(p.utm_medium ? { utm_medium: p.utm_medium } : {}),
    ...(p.utm_campaign ? { utm_campaign: p.utm_campaign } : {}),
    ...(p.utm_content ? { utm_content: p.utm_content } : {}),
    ...(p.utm_term ? { utm_term: p.utm_term } : {}),
  };

  const payload = {
    mode: monthly ? "subscription" : "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "aud",
        unit_amount: cents,
        product_data: { name: `Farmers Fightback Donation (${label})` },
        ...(monthly ? { recurring: { interval: "month" } } : {}),
      },
    }],
    metadata,
    success_url: `${base}?cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?cancelled=1`,
    allow_promotion_codes: false,
    ...(p.email ? { customer_email: p.email } : {}),
    // Existing convention: client_reference_id carries the petition slug the
    // donor came from (stripe-webhook + /share read it back).
    ...(p.slug ? { client_reference_id: p.slug } : {}),
    ...(monthly
      ? { subscription_data: { metadata, description: `Farmers Fightback Donation (${label})` } }
      : { payment_intent_data: { metadata, description: `Farmers Fightback Donation (${label})` } }),
  };

  const session = await createOnActiveAccount(payload);

  // Abandon detection for WS4: log the attempt; lapse-sweep checks whether
  // this session got paid after 30 min. Best-effort only. Identity-less
  // attempts are not logged: the sweep can do nothing with an anonymous
  // row, and the donate tiles are now plain GET links that crawlers can
  // follow — each bot hit would otherwise mint a junk pending row.
  if (p.email || p.contact_id) {
    try {
      await createRow(LAPSE_TABLE, {
        lapse_id: uuid(),
        form: "donation",
        email: p.email || undefined,
        contact_id: p.contact_id || undefined,
        session_id: session.id,
        amount: p.amount,
        status: "pending",
        created_at: nowIso(),
      });
    } catch (e) {
      console.error("lapse row create failed:", e.message);
    }
  }

  return session;
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_FUNDRAISING_SECRET_KEY && !process.env.STRIPE_RALLY_SECRET_KEY) {
    console.error("no Stripe secret key set (STRIPE_SECRET_KEY / STRIPE_FUNDRAISING_SECRET_KEY / STRIPE_RALLY_SECRET_KEY)");
    return res.status(500).json({ error: "Donations aren't configured yet." });
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, hostBase(req));
      const sessionId = url.searchParams.get("session_id") || url.searchParams.get("cs");
      if (sessionId) {
        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: "Invalid session_id" });
        const s = await readSession(sessionId);
        return res.status(200).json({
          session: {
            amount_total: s.amount_total || 0,
            currency: s.currency || "aud",
            frequency: s.mode === "subscription" ? "monthly" : "oneoff",
            email: s.customer_details?.email || s.customer_email || "",
            paid: s.payment_status === "paid",
          },
        });
      }
      // Deep-link mode: /api/checkout?amount=65&frequency=monthly&... → 303.
      const p = cleanParams(Object.fromEntries(url.searchParams));
      const session = await createSession(p, req);
      res.setHeader("Location", session.url);
      return res.status(303).end();
    }

    if (req.method !== "POST") return res.status(405).json({ error: "POST or GET only" });
    const p = cleanParams(req.body || {});
    const session = await createSession(p, req);
    return res.status(200).json({ url: session.url, id: session.id });
  } catch (e) {
    if (e.code === "BAD_AMOUNT") return res.status(400).json({ error: e.message });
    console.error("checkout error:", e);
    return res.status(500).json({ error: "Couldn't start the donation. Please try again." });
  }
};
