// Vercel serverless function: fires when a petition (or any page) loads
// with ?ref= present in the URL — i.e. someone clicked a shared link.
// Logs a Share Click event on the referrer's contact so we can measure
// total link loads independent of whether the visitor converts.
//
// The Share Click → Share Conversion pair gives us a full funnel:
//   Share Issued     — the referrer pressed a share button on /share
//   Share Click      — someone loaded their ?ref= link  (this route)
//   Share Conversion — that someone went on to sign the petition
//
// POST /api/share-click
// Body: { ref, source_url?, fbclid? }
// Response: { success } | { error }

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
    const { ref, source_url, fbclid } = body;
    if (!ref) return res.status(400).json({ error: "ref required" });

    const referrer = await findContactByReferralCode(ref);
    if (!referrer) return res.status(404).json({ error: "Unknown referral_code" });

    await logEvent({
      contactRecordId: referrer.id,
      event_type: "Share Click",
      payload: {
        ref_code: String(ref).toUpperCase(),
        source_url: source_url || null,
        fbclid: fbclid || null,
        user_agent: req.headers["user-agent"] || null,
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || null,
      },
      fbclid,
      referral_code_used: ref,
      source_channel: "Referral",
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("share-click error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
