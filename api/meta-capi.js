// Vercel serverless function: forwards conversion events to Meta's Conversions API.
// Receives events from the frontend, hashes PII with SHA-256, and sends to Meta.
// Uses event deduplication (event_id) to avoid double-counting with the browser pixel.
//
// POST /api/meta-capi
// Body: { event_name, event_id, user_data: { em, fn, ln, ph, zp, ct, st, country }, custom_data: { value, currency, content_name } }
//
// Environment variables required:
//   META_PIXEL_ID    — Facebook Pixel / Dataset ID
//   META_CAPI_TOKEN  — Conversions API access token

const crypto = require("crypto");

const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_CAPI_TOKEN;
const API_VERSION = "v21.0";

function sha256(value) {
  if (!value) return undefined;
  const normalised = String(value).trim().toLowerCase();
  if (!normalised) return undefined;
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

module.exports = async function handler(req, res) {
  // CORS headers for same-site fetch
  res.setHeader("Access-Control-Allow-Origin", "https://farmersfightback.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!PIXEL_ID || !TOKEN) {
    console.error("META_PIXEL_ID or META_CAPI_TOKEN not set");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  try {
    const { event_name, event_id, event_source_url, user_data = {}, custom_data = {} } = req.body || {};

    if (!event_name) return res.status(400).json({ error: "event_name required" });

    // Hash PII fields per Meta requirements
    const hashed_user_data = {
      em: user_data.em ? [sha256(user_data.em)] : undefined,
      fn: user_data.fn ? [sha256(user_data.fn)] : undefined,
      ln: user_data.ln ? [sha256(user_data.ln)] : undefined,
      ph: user_data.ph ? [sha256(user_data.ph.replace(/[\s\-()+ ]/g, ""))] : undefined,
      zp: user_data.zp ? [sha256(user_data.zp)] : undefined,
      country: user_data.country ? [sha256(user_data.country)] : undefined,
      client_ip_address: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress,
      client_user_agent: req.headers["user-agent"],
      fbc: user_data.fbc || undefined,
      fbp: user_data.fbp || undefined,
    };

    // Remove undefined keys
    Object.keys(hashed_user_data).forEach(k => hashed_user_data[k] === undefined && delete hashed_user_data[k]);

    const event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: event_id || `${event_name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      event_source_url: event_source_url || "https://farmersfightback.com",
      action_source: "website",
      user_data: hashed_user_data,
    };

    // Add custom_data if present (value, currency, content_name, etc.)
    if (Object.keys(custom_data).length > 0) {
      event.custom_data = custom_data;
    }

    const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${TOKEN}`;
    const payload = { data: [event] };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Meta CAPI error:", JSON.stringify(result));
      return res.status(502).json({ error: "Meta API error", detail: result });
    }

    return res.status(200).json({ success: true, events_received: result.events_received });
  } catch (err) {
    console.error("Meta CAPI handler error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
