// Vercel serverless function: generic capture for any interaction —
// surveys, RSVPs, partial form abandons, etc. Writes to Airtable Events
// with identity ladder match-or-create. Does NOT fire Meta — wire the
// specific event types you want optimised through their own routes.
//
// POST /api/event-log
// Body (JSON):
//   event_type (required) — one of the Events.event_type select choices
//   email | mobile        — at least one needed for identity match
//   first_name, last_name, postcode, fbclid, fbp, ref, source_channel
//   payload               — anything; defaults to the whole body

const {
  matchOrCreateContact,
  logEvent,
  updateContactStatusFromEvent,
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
    const {
      event_type,
      email,
      mobile,
      first_name,
      last_name,
      postcode,
      fbclid,
      fbp,
      payload,
      source_channel,
      ref,
    } = body;
    if (!event_type) return res.status(400).json({ error: "event_type required" });
    if (!email && !mobile && !(first_name && last_name && postcode)) {
      return res
        .status(400)
        .json({ error: "email, mobile, or first+last+postcode required" });
    }

    const { record } = await matchOrCreateContact({
      first_name,
      last_name,
      email,
      mobile,
      postcode,
      fbclid,
      fbp,
      source_channel,
    });

    const eventRecord = await logEvent({
      contactRecordId: record.id,
      event_type,
      payload: payload || body,
      fbclid,
      referral_code_used: ref || undefined,
      source_channel: source_channel || undefined,
    });

    try {
      await updateContactStatusFromEvent(
        record.id,
        event_type,
        record.fields.status
      );
    } catch (e) {
      console.error("status update failed:", e.message);
    }

    return res.status(200).json({
      success: true,
      contact_id: record.fields.contact_id,
      event_id: eventRecord.fields.event_id,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("event-log error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
