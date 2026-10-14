// GET /api/boundary?state=VIC&district=Ripon
//
// The outline of one lower-house seat for the map on the result page:
// polygons as [lng, lat] rings rounded to ~100m, plus the bounding box.
// Read from the same boundary file the lookup uses, so the map and the
// lookup can never disagree.

const path = require("path");
const fs = require("fs");
const CONFIG = require("../config/jurisdictions.json");

const cache = new Map();
function features(stateKey) {
  if (cache.has(stateKey)) return cache.get(stateKey);
  const st = CONFIG.states[stateKey];
  const file = st && path.join(__dirname, "..", "data", "boundaries", `${st.houses.assembly.boundary}.json`);
  const fc = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { features: [] };
  cache.set(stateKey, fc.features);
  return fc.features;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
function thin(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [r3(x), r3(y)], q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const q = req.query || {};
  const stateKey = String(q.state || CONFIG.site.default_jurisdiction || "").toUpperCase();
  const st = CONFIG.states[stateKey];
  if (!st || !st.enabled) return res.status(404).json({ error: `${stateKey || "that state"} is not switched on` });
  const want = String(q.district || "").toLowerCase();
  const f = features(stateKey).find((x) => x.properties.name.split(" (")[0].toLowerCase() === want);
  if (!f) return res.status(404).json({ error: "Unknown district" });

  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = polys.map((p) => thin(p[0])).filter((r) => r.length > 3);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json({ name: f.properties.name.split(" (")[0], code: f.properties.code, bbox: [minX, minY, maxX, maxY], rings });
};
