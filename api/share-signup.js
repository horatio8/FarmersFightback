// Vercel serverless function: creates or matches a contact from the
// /share page when the donor is unknown (no localStorage referral_code,
// no resolvable Stripe session_id). Matches the petition-signup identity
// ladder so a donor who already exists gets their existing referral_code
// rather than a duplicate row.
//
// POST /api/share-signup
// Body: { first_name, last_name, email, mobile?, postcode? }
//   first_name, last_name, email — required
//   mobile, postcode — optional
// Response: { success, contact_id, referral_code, first_name, is_new_contact }

const {
  matchOrCreateContact,
  setReferralCodeIfMissing,
} = require("./_airtable");

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

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    const first_name = (body.first_name || "").trim();
    const last_name = (body.last_name || "").trim();
    const email = (body.email || "").trim();
    const mobile = (body.mobile || "").trim();
    const postcode = (body.postcode || "").trim();

    if (!first_name) return res.status(400).json({ error: "first_name required" });
    if (!last_name) return res.status(400).json({ error: "last_name required" });
    if (!email) return res.status(400).json({ error: "email required" });

    const { record, isNew } = await matchOrCreateContact({
      first_name,
      last_name,
      email,
      mobile,
      postcode,
      source_channel: "Direct",
    });
    const referralCode = await setReferralCodeIfMissing(record.id, record.fields);

    return res.status(200).json({
      success: true,
      contact_id: record.fields.contact_id,
      referral_code: referralCode,
      first_name: record.fields.first_name || first_name,
      is_new_contact: isNew,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("share-signup error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
