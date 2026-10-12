// POST /api/donate  { amount, name, address, email, mobile, declared, attribution }
//   → { url }  Stripe's hosted checkout page. No card data touches this site.
// GET  /api/donate?session_id=cs_...
//   → { amount, email, paid }  for the thank-you state on /donate.
//
// Victorian law caps gifts at $5,190 per donor for this election and needs
// the donor's name and residential address on every gift. The per-gift cap
// is enforced here; the running total per donor is a reconciliation job.
// Name, address, mobile and the declaration ride on the session metadata.
//
// Env: STRIPE_FV_SECRET_KEY. Without it the endpoint answers 503 and the
// page tells the donor donations open shortly.

const CAP = 5190;
const KEY = () => process.env.STRIPE_FV_SECRET_KEY || "";

function form(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
async function stripe(path, init = {}) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { ...init, headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/x-www-form-urlencoded" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || `Stripe ${r.status}`), { status: r.status });
  return j;
}
const origin = (req) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "farmersfightback.vote";
  const proto = req.headers["x-forwarded-proto"] || (/^localhost|^127\./.test(host) ? "http" : "https");
  return `${proto}://${host}`;
};
const clip = (s, n = 400) => String(s || "").trim().slice(0, n);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    const id = String((req.query || {}).session_id || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Bad session id" });
    if (!KEY()) return res.status(503).json({ error: "Donations are not open yet" });
    try {
      const s = await stripe(`checkout/sessions/${id}`);
      return res.status(200).json({ amount: Math.round((s.amount_total || 0) / 100), email: s.customer_details?.email || s.customer_email || "", paid: s.payment_status === "paid" });
    } catch (e) { return res.status(e.status === 404 ? 404 : 502).json({ error: "Could not read that donation" }); }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  const b = req.body || {};
  const amount = Math.round(Number(b.amount));
  if (!(amount >= 1)) return res.status(400).json({ error: "Pick an amount" });
  if (amount > CAP) return res.status(400).json({ error: `Victorian law caps donations at $${CAP.toLocaleString("en-AU")} per donor` });
  if (!clip(b.name) || !clip(b.address)) return res.status(400).json({ error: "We need your full name and residential address" });
  if (!/^\S+@\S+\.\S+$/.test(clip(b.email))) return res.status(400).json({ error: "Enter a valid email for your receipt" });
  if (!b.declared) return res.status(400).json({ error: "We can't take your gift without the declaration" });
  if (!KEY()) return res.status(503).json({ error: "Donations open shortly. Thanks for being early." });

  const a = b.attribution || {};
  const base = origin(req);
  try {
    const s = await stripe("checkout/sessions", {
      method: "POST",
      body: form({
        mode: "payment",
        customer_email: clip(b.email, 200),
        submit_type: "donate",
        line_items: { 0: { quantity: 1, price_data: { currency: "aud", unit_amount: amount * 100, product_data: { name: "Gift to Farmers Fightback Votes" } } } },
        success_url: `${base}/donate?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/donate?amount=${amount}`,
        metadata: {
          org: "fv", donor_name: clip(b.name, 200), donor_address: clip(b.address), donor_mobile: clip(b.mobile, 20),
          declaration: `accepted ${new Date().toISOString()}`,
          utm_source: clip(a.utm_source, 100), utm_medium: clip(a.utm_medium, 100), utm_campaign: clip(a.utm_campaign, 100),
          utm_content: clip(a.utm_content, 100), ref: clip(a.ref, 20),
        },
      }),
    });
    return res.status(200).json({ url: s.url });
  } catch (e) {
    console.error("donate error:", e.message);
    return res.status(502).json({ error: "Could not start checkout. Please try again." });
  }
};
