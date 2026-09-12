// Electorate lookup: a point or a postcode in, every seat the voter has a say
// in out, for every jurisdiction that is switched on in config/jurisdictions.json.
//
// Boundaries are ABS ASGS 2024 state (SED) and federal (CED) polygons,
// simplified to ~40m and stored per jurisdiction under data/boundaries/
// (see scripts/ingest-boundaries.js). Point-in-polygon is a plain ray cast
// with a bounding-box pre-filter, so this needs no dependencies and answers
// in about a millisecond.
//
// Nothing in here knows about Victoria. Adding a state is: set enabled in
// the config, run the ingest script, done.

const fs = require("fs");
const path = require("path");
const CONFIG = require("../config/jurisdictions.json");

const DATA = path.join(__dirname, "..", "data", "boundaries");
const cache = new Map();

// ---------------------------------------------------------------- geometry
function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (ring) => { for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } };
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const ring of poly) eat(ring);
  return [minX, minY, maxX, maxY];
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(pt, poly) {
  if (!inRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(pt, poly[k])) return false; // holes
  return true;
}
function inFeature(pt, f) {
  const b = f._bbox;
  if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) return false;
  const g = f.geometry;
  if (g.type === "Polygon") return inPolygon(pt, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((p) => inPolygon(pt, p));
  return false;
}

// ------------------------------------------------------------------ layers
function loadLayer(key) {
  if (cache.has(key)) return cache.get(key);
  const file = path.join(DATA, `${key}.json`);
  if (!fs.existsSync(file)) { cache.set(key, null); return null; }
  const fc = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const f of fc.features) f._bbox = bboxOf(f.geometry);
  cache.set(key, fc);
  return fc;
}
function loadPostcodes(stateKey) {
  const key = `${stateKey.toLowerCase()}-postcodes`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(DATA, `${key}.json`);
  const idx = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  cache.set(key, idx);
  return idx;
}
function findSeat(layerKey, lng, lat) {
  const fc = loadLayer(layerKey);
  if (!fc) return null;
  const f = fc.features.find((x) => inFeature([lng, lat], x));
  return f ? { code: f.properties.code, name: f.properties.name } : null;
}

// ------------------------------------------------------------------ config
const stateEntries = () => Object.entries(CONFIG.states || {});
const enabledStates = () => stateEntries().filter(([, s]) => s.enabled).map(([k]) => k);
const stateConfig = (k) => (CONFIG.states || {})[k] || null;
const federalOn = (stateKey) => !!((CONFIG.federal && CONFIG.federal.enabled) || (stateConfig(stateKey) || {}).federal_enabled);

// "Ripon (Western Victoria)" -> { display: "Ripon", region: "Western Victoria" }
function splitName(name) {
  const m = String(name || "").match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  return m ? { display: m[1].trim(), region: m[2].trim() } : { display: String(name || "").trim(), region: null };
}

// Region (upper house) for a lower-house seat, per the state's configured rule.
function regionFor(stateKey, seat, lng, lat) {
  const st = stateConfig(stateKey);
  const council = st && st.houses && st.houses.council;
  if (!council) return null;
  if (council.region_from === "statewide") return { name: st.name, statewide: true };
  if (council.region_from === "parenthetical") { const r = splitName(seat && seat.name).region; return r ? { name: r } : null; }
  if (council.region_from === "boundary" && council.boundary && lng !== undefined) { const s = findSeat(council.boundary, lng, lat); return s ? { code: s.code, name: s.name } : null; }
  return null;
}

// Which enabled state contains this point? First hit wins; states do not overlap.
function stateOfPoint(lng, lat) {
  for (const k of enabledStates()) {
    const st = stateConfig(k);
    const layer = st.houses && st.houses.assembly && st.houses.assembly.boundary;
    if (layer && findSeat(layer, lng, lat)) return k;
  }
  return null;
}

// Australian postcode ranges, for a useful answer about states we have not
// switched on yet. Not used for anything the enabled path needs.
function stateOfPostcode(pc) {
  const n = Number(pc);
  if (!Number.isFinite(n)) return null;
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
  if (n >= 1000 && n <= 2999) return "NSW";
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return "VIC";
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return "QLD";
  if (n >= 5000 && n <= 5999) return "SA";
  if (n >= 6000 && n <= 6999) return "WA";
  if (n >= 7000 && n <= 7999) return "TAS";
  if (n >= 800 && n <= 999) return "NT";
  return null;
}

// -------------------------------------------------------------- public API
function lookupPoint({ lng, lat }) {
  lng = Number(lng); lat = Number(lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw Object.assign(new Error("lng and lat must be numbers"), { status: 400 });
  const stateKey = stateOfPoint(lng, lat);
  if (!stateKey) return { supported: false, state: null, reason: "Outside every enabled state", enabled: enabledStates() };
  const st = stateConfig(stateKey);
  const seats = [];
  const lower = findSeat(st.houses.assembly.boundary, lng, lat);
  const { display } = splitName(lower.name);
  seats.push({ jurisdiction: stateKey, level: "state", house: "assembly", house_name: st.houses.assembly.name, code: lower.code, name: display, raw_name: lower.name });
  const region = regionFor(stateKey, lower, lng, lat);
  if (region) seats.push({ jurisdiction: stateKey, level: "state", house: "council", house_name: st.houses.council.name, code: region.code || null, name: region.name, statewide: !!region.statewide, members: st.houses.council.per_voter });
  if (federalOn(stateKey)) {
    const fed = findSeat(`${stateKey.toLowerCase()}-federal`, lng, lat);
    if (fed) seats.push({ jurisdiction: "federal", level: "federal", house: "reps", house_name: CONFIG.federal.houses.reps.name, code: fed.code, name: fed.name });
    seats.push({ jurisdiction: "federal", level: "federal", house: "senate", house_name: CONFIG.federal.houses.senate.name, name: st.name, statewide: true, members: CONFIG.federal.houses.senate.per_voter });
  }
  return { supported: true, state: stateKey, method: "point", seats, election: st.election || null };
}

// A postcode resolves outright when one seat covers it; otherwise the caller
// gets the options with their share of the postcode, and can either ask for
// a street address or let the voter pick.
function lookupPostcode(postcode) {
  // Three digits is a real Northern Territory postcode typed without its
  // leading zero (800 -> 0800); anything shorter or non-numeric is a typo.
  const raw = String(postcode || "").trim();
  if (!/^\d{3,4}$/.test(raw)) throw Object.assign(new Error("postcode must be four digits"), { status: 400 });
  const pc = raw.padStart(4, "0");
  const guess = stateOfPostcode(pc);
  for (const k of enabledStates()) {
    const idx = loadPostcodes(k);
    if (!idx || !idx.state || !idx.state[pc]) continue;
    const st = stateConfig(k);
    const shape = (h) => ({ code: h.code, name: splitName(h.name).display, raw_name: h.name, share: h.share });
    const assembly = idx.state[pc].map(shape);
    const out = {
      supported: true, state: k, method: "postcode", postcode: pc,
      resolved: assembly.length === 1,
      options: { assembly, council: [...new Set(idx.state[pc].map((h) => splitName(h.name).region).filter(Boolean))] },
      election: st.election || null,
    };
    if (federalOn(k) && idx.federal && idx.federal[pc]) out.options.reps = idx.federal[pc].map(shape);
    if (out.resolved) out.seats = lookupPostcodeSeats(k, out);
    return out;
  }
  return { supported: false, state: guess, postcode: pc, reason: guess && !enabledStates().includes(guess) ? `${(stateConfig(guess) || { name: guess }).name} is not switched on yet` : "Unknown postcode", enabled: enabledStates() };
}
function lookupPostcodeSeats(k, r) {
  const st = stateConfig(k);
  const a = r.options.assembly[0];
  const seats = [{ jurisdiction: k, level: "state", house: "assembly", house_name: st.houses.assembly.name, code: a.code, name: a.name, raw_name: a.raw_name }];
  const region = regionFor(k, { name: a.raw_name });
  if (region) seats.push({ jurisdiction: k, level: "state", house: "council", house_name: st.houses.council.name, code: region.code || null, name: region.name, statewide: !!region.statewide, members: st.houses.council.per_voter });
  if (r.options.reps && r.options.reps.length === 1) seats.push({ jurisdiction: "federal", level: "federal", house: "reps", house_name: CONFIG.federal.houses.reps.name, code: r.options.reps[0].code, name: r.options.reps[0].name });
  return seats;
}

// Every seat in a jurisdiction, for the party grid and the candidate survey.
function listSeats(stateKey, house = "assembly") {
  const st = stateConfig(stateKey);
  if (!st) return [];
  if (house === "council" && st.houses.council && st.houses.council.region_from === "parenthetical") {
    const fc = loadLayer(st.houses.assembly.boundary);
    return fc ? [...new Set(fc.features.map((f) => splitName(f.properties.name).region))].filter(Boolean).sort().map((name) => ({ name })) : [];
  }
  const key = house === "reps" ? `${stateKey.toLowerCase()}-federal` : st.houses[house] && st.houses[house].boundary;
  const fc = key && loadLayer(key);
  return fc ? fc.features.map((f) => ({ code: f.properties.code, name: splitName(f.properties.name).display, raw_name: f.properties.name })).sort((x, y) => x.name.localeCompare(y.name)) : [];
}

// What the config says is on, and whether the data behind it is present.
function status() {
  return {
    site: CONFIG.site,
    federal: { enabled: !!(CONFIG.federal && CONFIG.federal.enabled) },
    states: stateEntries().map(([k, s]) => {
      const assembly = s.houses && s.houses.assembly && s.houses.assembly.boundary;
      return {
        key: k, name: s.name, enabled: !!s.enabled, federal_enabled: !!s.federal_enabled, election: s.election && s.election.date,
        data: { state: !!(assembly && loadLayer(assembly)), federal: !!loadLayer(`${k.toLowerCase()}-federal`), postcodes: !!loadPostcodes(k) },
      };
    }),
  };
}

module.exports = { lookupPoint, lookupPostcode, listSeats, status, splitName, stateOfPostcode, enabledStates, _inFeature: inFeature, _bboxOf: bboxOf };
