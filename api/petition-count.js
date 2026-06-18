// Multi-form petition counter aggregator.
// Sums total_signups across all registered Farmers Fightback forms in
// Campaign Nucleus, with in-process caching to keep CN load minimal.
//
// GET /api/petition-count → { count: <integer>, stale?: true }
//
// Environment variables:
//   CN_BASE_URL       — Campaign Nucleus API base URL
//                       (e.g. https://teller.campaignnucleus.com)
//   CN_CLIENT_ID      — OAuth client_credentials client id
//   CN_CLIENT_SECRET  — OAuth client_credentials client secret
//
// Maintenance: when adding a new FF form, append its UUID to FF_FORM_IDS
// here and in api/petition-event.js.

let cachedCount = null;
let cacheTimestamp = 0;
let cachedToken = null;
let tokenExpiry = 0;
const CACHE_TTL = 10_000;

const FF_FORM_IDS = [
  "de602723-dce3-4a83-ab0b-b8156faf01e2", // Omnibus Petition
  "26c245da-cc8a-496b-976a-f4e399cdab68", // Hold the Gate
  "436f0df8-b0b2-42e9-a94f-2db7a80b0df0", // Baldwin Campaign
  "fb97da79-e214-424e-991f-092c4015affd", // Volunteer Subscription
  "4b9cac7f-1cff-4aa5-aefe-9f4391c47e5c", // Contact
  "08377f48-fc74-4c2e-a20d-de5e34353001", // Fuel & Fertiliser
];

function invalidateCache() {
  cachedCount = null;
  cacheTimestamp = 0;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${process.env.CN_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.CN_CLIENT_ID,
      client_secret: process.env.CN_CLIENT_SECRET,
      scope: "read",
    }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchFormCount(token, formId) {
  const res = await fetch(`${process.env.CN_BASE_URL}/api/v1/forms/${formId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.warn(`Form ${formId} failed: ${res.status}`);
    return 0;
  }
  const json = await res.json();
  // Defensive: CN responses have appeared in three shapes across versions.
  const form = (json && json.data) || (json && json.form) || json;
  return Number(form && form.total_signups) || 0;
}

async function getAggregateCount() {
  if (cachedCount !== null && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedCount;
  }
  const token = await getToken();
  const counts = await Promise.all(FF_FORM_IDS.map(id => fetchFormCount(token, id)));
  cachedCount = counts.reduce((sum, c) => sum + c, 0);
  cacheTimestamp = Date.now();
  return cachedCount;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://farmersfightback.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const count = await getAggregateCount();
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10, stale-while-revalidate=60");
    return res.status(200).json({ count });
  } catch (err) {
    console.error("petition-count error:", err && err.stack || err);
    console.error("petition-count env check:", {
      CN_BASE_URL: process.env.CN_BASE_URL || "(unset)",
      CN_CLIENT_ID_set: Boolean(process.env.CN_CLIENT_ID),
      CN_CLIENT_SECRET_set: Boolean(process.env.CN_CLIENT_SECRET),
    });
    if (cachedCount !== null) {
      res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=60");
      return res.status(200).json({ count: cachedCount, stale: true });
    }
    return res.status(500).json({ error: "Failed" });
  }
};

module.exports.invalidateCache = invalidateCache;
module.exports.FF_FORM_IDS = FF_FORM_IDS;
