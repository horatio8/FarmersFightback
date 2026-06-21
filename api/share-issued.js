// Vercel serverless function: logs a Share Issued event when a donor
// clicks one of the share-with-five buttons. Pairs with the Share Click
// events emitted by /api/petition-signup when the recipient actually
// signs — together they let you reconstruct the recruiting funnel:
//   Share Issued (Alice clicks share-to-facebook)
//   Share Click  (Bob arrives with ?ref=ALICE_CODE)
//   Petition Signed (Bob)
//   referred_by  (Bob.referred_by → Alice)
//
// POST /api/share-issued
// Body: { referral_code, platform, share_url }

const {
  findContactByReferralCode,
  logEvent,
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
    const { referral_code, platform, share_url } = body;
    if (!referral_code) return res.status(400).json({ error: "referral_code required" });
    if (!platform) return res.status(400).json({ error: "platform required" });

    const contact = await findContactByReferralCode(referral_code);
    if (!contact) return res.status(404).json({ error: "Unknown referral_code" });

    await logEvent({
      contactRecordId: contact.id,
      event_type: "Share Issued",
      payload: {
        platform,
        share_url: share_url || null,
        referral_code: String(referral_code).toUpperCase(),
      },
      referral_code_used: referral_code,
      source_channel: "Referral",
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("share-issued error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
