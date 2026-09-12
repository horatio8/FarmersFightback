// Thin Airtable client for the Farmers Votes base (AIRTABLE_FV_BASE_ID).
// Same REST API and token as the FF site. Every function degrades cleanly
// when the base is not configured, so the site runs before the keys land.

const BASE = () => process.env.AIRTABLE_FV_BASE_ID || "";
const TOKEN = () => process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN || "";
const configured = () => !!(BASE() && TOKEN());

async function at(pathname, init = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE()}/${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Airtable ${pathname}: ${r.status} ${j.error && j.error.message || ""}`), { status: r.status });
  return j;
}

async function listAll(table, params = {}) {
  const rows = [];
  let offset;
  do {
    const u = new URLSearchParams({ pageSize: "100", ...params });
    if (offset) u.set("offset", offset);
    const j = await at(`${encodeURIComponent(table)}?${u}`);
    rows.push(...(j.records || []).map((r) => ({ id: r.id, ...r.fields })));
    offset = j.offset;
  } while (offset);
  return rows;
}

async function create(table, fields) {
  const j = await at(encodeURIComponent(table), { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return j.records && j.records[0];
}

async function findOne(table, formula) {
  const j = await at(`${encodeURIComponent(table)}?${new URLSearchParams({ filterByFormula: formula, maxRecords: "1" })}`);
  const r = j.records && j.records[0];
  return r ? { id: r.id, ...r.fields } : null;
}

async function update(table, id, fields) {
  return at(`${encodeURIComponent(table)}/${id}`, { method: "PATCH", body: JSON.stringify({ fields, typecast: true }) });
}

const splitUrls = (s) => String(s || "").split(/[\s,]+/).filter((x) => /^https?:\/\//.test(x));

// Issues, member positions and party positions for one jurisdiction.
// Cached in-process for five minutes; the API layer caches at the edge too.
let ratingsCache = { at: 0, key: "", data: null };
async function fetchRatings(stateKey) {
  if (!configured()) return { issues: [], positions: [], party_positions: [], live: false };
  const now = Date.now();
  if (ratingsCache.data && ratingsCache.key === stateKey && now - ratingsCache.at < 5 * 60 * 1000) return ratingsCache.data;
  const [issues, positions, party] = await Promise.all([
    listAll("Issues", { filterByFormula: "{active}=1", "sort[0][field]": "order" }),
    listAll("Positions", { filterByFormula: "{published}=1" }),
    listAll("Party Positions", { filterByFormula: `AND({published}=1, OR({jurisdiction}='${stateKey}', {jurisdiction}='federal', {jurisdiction}=''))` }),
  ]);
  const data = {
    live: true,
    issues: issues.map((i) => ({ slug: i.slug, title: i.title, question: i.question, order: i.order || 0, weight: i.weight || 1, in_questionnaire: !!i.in_questionnaire, in_party_grid: !!i.in_party_grid })),
    positions: positions.map((p) => ({ ...p, source_urls: splitUrls(p.source_urls) })),
    party_positions: party.map((p) => ({ ...p, source_urls: splitUrls(p.source_urls) })),
  };
  ratingsCache = { at: now, key: stateKey, data };
  return data;
}

module.exports = { configured, listAll, create, findOne, update, fetchRatings };
