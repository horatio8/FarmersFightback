#!/usr/bin/env node
// Build the boundary files for one state from the ABS ArcGIS services:
//
//   node scripts/ingest-boundaries.js VIC
//
// Produces, under data/boundaries/:
//   vic-state.json      lower-house seats (ABS SED 2024), simplified
//   vic-federal.json    federal divisions (ABS CED 2024), simplified
//   vic-postcodes.json  postcode -> seats with share of area, both layers
//
// Dev-only: needs the turf packages, which live in scripts/node_modules so
// the deployed site stays dependency-free.  `cd scripts && npm install`.
//
// Sources (CC BY 4.0, Commonwealth of Australia / ABS):
//   https://geo.abs.gov.au/arcgis/rest/services/ASGS2024/SED/MapServer/0
//   https://geo.abs.gov.au/arcgis/rest/services/ASGS2024/CED/MapServer/0
//   https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/POA/MapServer/0
// Checked 12 Sep 2026: VIC CED = 38 divisions, matching the AEC's own
// October 2024 shapefile name for name.

const fs = require("fs");
const path = require("path");
const CONFIG = require("../config/jurisdictions.json");

const req = (m) => { try { return require(m); } catch { console.error(`Missing ${m}. Run: cd scripts && npm install`); process.exit(1); } };
const simplify = req("@turf/simplify").default;
const intersect = req("@turf/intersect").default;
const area = req("@turf/area").default;
const bbox = req("@turf/bbox").default;
const booleanIntersects = req("@turf/boolean-intersects").default;
const { featureCollection } = req("@turf/helpers");

const ABS = "https://geo.abs.gov.au/arcgis/rest/services";
const OUT = path.join(__dirname, "..", "data", "boundaries");
const PSEUDO = /no usual address|migratory|offshore|shipping/i;
const TOLERANCE = Number(process.env.TOLERANCE || 0.0004); // degrees, ~40m

// Postcode prefixes per state, to pull only that state's postal areas.
const POA_PREFIX = { NSW: ["1", "2"], ACT: ["2"], VIC: ["3", "8"], QLD: ["4", "9"], SA: ["5"], WA: ["6"], TAS: ["7"], NT: ["0"] };

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function pull(service, where, fields) {
  const u = `${ABS}/${service}/query?where=${encodeURIComponent(where)}&outFields=${fields}&outSR=4326&f=geojson`;
  const fc = await getJson(u);
  if (!fc.features) throw new Error(`No features from ${service} for ${where}`);
  return fc;
}
function clean(fc, nameKey, codeKey) {
  return featureCollection(fc.features
    .filter((f) => f.geometry && !PSEUDO.test(f.properties[nameKey]))
    .map((f) => ({ type: "Feature", properties: { code: String(f.properties[codeKey]), name: f.properties[nameKey] }, geometry: simplify(f, { tolerance: TOLERANCE, highQuality: false }).geometry })));
}
function postcodeIndex(poa, layers) {
  const out = {};
  const overlap = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
  for (const [layer, fc] of Object.entries(layers)) {
    out[layer] = {};
    const fb = fc.features.map((f) => bbox(f));
    for (const p of poa.features) {
      if (!p.geometry) continue;
      const pc = p.properties.poa_code_2021, pb = bbox(p), total = area(p);
      if (!total) continue;
      const hits = [];
      fc.features.forEach((f, i) => {
        if (!overlap(pb, fb[i]) || !booleanIntersects(p, f)) return;
        try { const x = intersect(featureCollection([p, f])); if (x) { const a = area(x); if (a / total > 0.005) hits.push({ code: f.properties.code, name: f.properties.name, share: a / total }); } }
        catch { hits.push({ code: f.properties.code, name: f.properties.name, share: null }); }
      });
      const s = hits.reduce((n, h) => n + (h.share || 0), 0);
      if (s > 0) hits.forEach((h) => { if (h.share !== null) h.share = +(h.share / s).toFixed(4); });
      hits.sort((a, b) => (b.share || 0) - (a.share || 0));
      if (hits.length) out[layer][pc] = hits;
    }
  }
  return out;
}

(async () => {
  const key = String(process.argv[2] || "").toUpperCase();
  const st = CONFIG.states[key];
  if (!st) { console.error(`Unknown state ${key}. Options: ${Object.keys(CONFIG.states).join(", ")}`); process.exit(1); }
  const code = st.abs_state_code, k = key.toLowerCase();
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  console.log(`[${key}] state seats (SED) ...`);
  const sedRaw = await pull("ASGS2024/SED/MapServer/0", `state_code_2021='${code}'`, "sed_code_2024,sed_name_2024");
  const stateFc = clean(sedRaw, "sed_name_2024", "sed_code_2024");
  fs.writeFileSync(path.join(OUT, `${k}-state.json`), JSON.stringify(stateFc));
  console.log(`  ${stateFc.features.length} seats -> ${k}-state.json`);

  console.log(`[${key}] federal divisions (CED) ...`);
  const cedRaw = await pull("ASGS2024/CED/MapServer/0", `state_code_2021='${code}'`, "ced_code_2024,ced_name_2024");
  const fedFc = clean(cedRaw, "ced_name_2024", "ced_code_2024");
  fs.writeFileSync(path.join(OUT, `${k}-federal.json`), JSON.stringify(fedFc));
  console.log(`  ${fedFc.features.length} divisions -> ${k}-federal.json`);

  console.log(`[${key}] postal areas ...`);
  const where = (POA_PREFIX[key] || []).map((p) => `poa_code_2021 LIKE '${p}%'`).join(" OR ");
  const poa = await pull("ASGS2021/POA/MapServer/0", where, "poa_code_2021");
  console.log(`  ${poa.features.length} postcodes; intersecting (this is the slow part) ...`);
  const idx = postcodeIndex(poa, { state: stateFc, federal: fedFc });
  fs.writeFileSync(path.join(OUT, `${k}-postcodes.json`), JSON.stringify(idx));
  const n = Object.keys(idx.state).length, split = Object.values(idx.state).filter((h) => h.length > 1).length;
  console.log(`  ${n} postcodes indexed, ${split} split across seats -> ${k}-postcodes.json`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s. Now set states.${key}.enabled = true in config/jurisdictions.json.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
