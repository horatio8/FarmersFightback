// Shared Meta Conversions API poster — used by /api/meta-capi (browser-driven)
// and /api/stripe-webhook (server-driven from Stripe events).

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

function buildUserData(user_data, { ip, userAgent } = {}) {
  const phNormalised = user_data.ph ? user_data.ph.replace(/[\s\-()+ ]/g, "") : undefined;
  const out = {
    em: user_data.em ? [sha256(user_data.em)] : undefined,
    fn: user_data.fn ? [sha256(user_data.fn)] : undefined,
    ln: user_data.ln ? [sha256(user_data.ln)] : undefined,
    ph: phNormalised ? [sha256(phNormalised)] : undefined,
    zp: user_data.zp ? [sha256(user_data.zp)] : undefined,
    ct: user_data.ct ? [sha256(user_data.ct)] : undefined,
    st: user_data.st ? [sha256(user_data.st)] : undefined,
    country: user_data.country ? [sha256(user_data.country)] : undefined,
    external_id: user_data.external_id ? [sha256(user_data.external_id)] : undefined,
    client_ip_address: ip || undefined,
    client_user_agent: userAgent || undefined,
    fbc: user_data.fbc || undefined,
    fbp: user_data.fbp || undefined,
  };
  Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
  return out;
}

async function postEvent({ event_name, event_id, event_source_url, action_source, user_data, custom_data, ip, userAgent }) {
  if (!PIXEL_ID || !TOKEN) {
    const err = new Error("META_PIXEL_ID or META_CAPI_TOKEN not set");
    err.code = "MISCONFIGURED";
    throw err;
  }

  const event = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: event_id || `${event_name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event_source_url: event_source_url || "https://farmersfightback.com",
    action_source: action_source || "website",
    user_data: buildUserData(user_data || {}, { ip, userAgent }),
  };
  if (custom_data && Object.keys(custom_data).length > 0) event.custom_data = custom_data;

  const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [event] }),
  });
  const result = await response.json();
  if (!response.ok) {
    const err = new Error("Meta API error");
    err.code = "META_ERROR";
    err.detail = result;
    throw err;
  }
  return result;
}

module.exports = { postEvent, sha256 };
