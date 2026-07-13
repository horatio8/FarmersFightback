// Donor webinar: token-gated event + prefill context.
//
// GET /api/webinar-context?session=tuesday&t=TOKEN
//   → 200 { event: { title, starts_at_utc, timezone, join_url|null },
//           prefill: { first_name, last_name, email, mobile, postcode } }
//   → 403 { private: true }   invalid/expired token, or session mismatch
//   → 503 { error: "not configured" } when WEBINAR_TOKEN_SECRET is unset
//
// Only the token's own contact is ever returned — the contact_id comes from
// the verified HMAC payload, never from a query param.

const { hostBase } = require("./_util");
const {
  isConfigured,
  verifyToken,
  normSession,
  findWebinarBySession,
  findContactByContactId,
} = require("./_webinar");

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  if (!isConfigured()) return res.status(503).json({ error: "not configured" });

  const url = new URL(req.url, hostBase(req));
  const session = normSession(url.searchParams.get("session"));
  const token = url.searchParams.get("t") || "";

  const v = verifyToken(token);
  if (!v || !session || v.session !== session) {
    return res.status(403).json({ private: true });
  }

  try {
    const webinar = await findWebinarBySession(session);
    if (!webinar) return res.status(404).json({ error: "session not found" });

    const contact = await findContactByContactId(v.contact_id);
    const cf = (contact && contact.fields) || {};
    const wf = webinar.fields || {};

    return res.status(200).json({
      event: {
        title: wf.title || "Donor Briefing",
        starts_at_utc: wf.starts_at_utc || null,
        timezone: wf.timezone || "Australia/Melbourne",
        join_url: wf.join_url || null,
      },
      prefill: {
        first_name: cf.first_name || "",
        last_name: cf.last_name || "",
        email: cf.email || "",
        mobile: cf.mobile || "",
        postcode: cf.postcode || "",
      },
    });
  } catch (e) {
    console.error("webinar-context error:", e.message);
    return res.status(500).json({ error: "Couldn't load the briefing. Please try again." });
  }
};
