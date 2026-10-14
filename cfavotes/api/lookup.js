// GET /api/lookup?postcode=3387
// GET /api/lookup?lat=-36.658&lng=142.917
// GET /api/lookup?address=12 Main St Marnoo VIC   (needs GOOGLE_MAPS_KEY)
//
// Answers with the voter's seats in every jurisdiction that is switched on.
// A split postcode comes back with `resolved:false` and the options, so the
// page can ask for a street address or offer a pick list.
//
// Addresses are geocoded and then forgotten: the response carries the seats
// and the point, never the address string, and nothing is logged.

const { lookupPoint, lookupPostcode } = require("../lib/electorates");

async function geocode(address) {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) throw Object.assign(new Error("Address lookup is not configured yet; use a postcode"), { status: 501 });
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", address);
  u.searchParams.set("components", "country:AU");
  u.searchParams.set("region", "au");
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  const hit = j.results && j.results[0];
  if (!hit) throw Object.assign(new Error("Could not place that address"), { status: 404 });
  const { lat, lng } = hit.geometry.location;
  return { lat, lng, precision: hit.geometry.location_type, formatted: hit.formatted_address };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const q = req.query || {};
  try {
    let out;
    if (q.postcode) {
      out = lookupPostcode(q.postcode);
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    } else if (q.lat !== undefined && q.lng !== undefined) {
      out = lookupPoint({ lat: q.lat, lng: q.lng });
      res.setHeader("Cache-Control", "public, s-maxage=86400");
    } else if (q.address) {
      const g = await geocode(String(q.address).slice(0, 200));
      out = lookupPoint({ lat: g.lat, lng: g.lng });
      out.point = { lat: g.lat, lng: g.lng, precision: g.precision };
      out.method = "address";
      res.setHeader("Cache-Control", "no-store");
    } else {
      return res.status(400).json({ error: "Give a postcode, a lat/lng, or an address" });
    }
    return res.status(200).json(out);
  } catch (err) {
    // Anything that set its own status is a message for the caller (bad
    // input, not configured, not found). Only a bare 500 is ours to hide.
    const status = err.status || 500;
    if (status === 500) console.error("lookup error:", err && err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error: status === 500 ? "Lookup failed" : err.message });
  }
};
