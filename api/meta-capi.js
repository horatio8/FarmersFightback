// Vercel serverless function: forwards conversion events to Meta's Conversions API.
// Receives events from the frontend, hashes PII with SHA-256, and sends to Meta.
// Uses event deduplication (event_id) to avoid double-counting with the browser pixel.
//
// POST /api/meta-capi
// Body: { event_name, event_id, event_source_url, user_data, custom_data }

const { postEvent } = require("./_meta");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://farmersfightback.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { event_name, event_id, event_source_url, user_data = {}, custom_data = {} } = req.body || {};
    if (!event_name) return res.status(400).json({ error: "event_name required" });

    const result = await postEvent({
      event_name,
      event_id,
      event_source_url,
      action_source: "website",
      user_data,
      custom_data,
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({ success: true, events_received: result.events_received });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    if (err.code === "META_ERROR") {
      console.error("Meta CAPI error:", JSON.stringify(err.detail));
      return res.status(502).json({ error: "Meta API error", detail: err.detail });
    }
    console.error("Meta CAPI handler error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
