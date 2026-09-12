// GET /api/seat?state=VIC&district=Ripon
//
// Everything the scorecard page needs for one lower-house seat: the seat,
// its upper-house region, the candidates and sitting members in both, and a
// rating per issue for each of them.
//
// Ratings come from Airtable (Positions, Party Positions, Issues) when the
// base is configured, and are "Unknown" otherwise, so the page works from
// day one and fills in as the research lands. Candidates come from the
// imported list in data/candidates until the commission's declared list
// replaces it.

const path = require("path");
const fs = require("fs");
const { listSeats, splitName } = require("../lib/electorates");
const CONFIG = require("../config/jurisdictions.json");
const { fetchRatings } = require("../lib/airtable");

const PLACEHOLDER_ISSUES = [
  { slug: "issue-1", title: "Issue one (placeholder)", order: 1 },
  { slug: "issue-2", title: "Issue two (placeholder)", order: 2 },
  { slug: "issue-3", title: "Issue three (placeholder)", order: 3 },
  { slug: "issue-4", title: "Issue four (placeholder)", order: 4 },
  { slug: "issue-5", title: "Issue five (placeholder)", order: 5 },
];

const cache = new Map();
function loadCandidates(stateKey) {
  const st = CONFIG.states[stateKey];
  const year = st && st.election && st.election.date ? st.election.date.slice(0, 4) : new Date().getFullYear();
  const key = `${stateKey.toLowerCase()}-${year}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(__dirname, "..", "data", "candidates", `${key}.json`);
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { candidates: [], retiring: [] };
  cache.set(key, data);
  return data;
}

// Party names on candidates are specific (Liberal, National); ratings may be
// held against the party or its Coalition umbrella. Try both.
const PARTY_ALIASES = { Liberal: ["Liberal", "Coalition"], National: ["National", "Coalition"], Coalition: ["Coalition", "Liberal"] };

function ratingsFor(member, issues, ratings) {
  const out = {};
  for (const issue of issues) {
    const own = ratings.positions.find((p) => p.member_id === member.member_id && p.issue_slug === issue.slug && p.published !== false);
    if (own) { out[issue.slug] = { rating: own.rating || "Unknown", confidence: own.confidence || null, method: own.method || null, sources: own.source_urls || [] }; continue; }
    const aliases = PARTY_ALIASES[member.party] || [member.party];
    const pp = ratings.party_positions.find((p) => aliases.includes(p.party) && p.issue_slug === issue.slug && p.published !== false);
    out[issue.slug] = pp
      ? { rating: pp.rating || "Unknown", confidence: "Medium", method: "Party position", sources: pp.source_urls || [] }
      : { rating: "Unknown", confidence: null, method: null, sources: [] };
  }
  return out;
}
const ORDER = { Red: 0, Amber: 1, Green: 2, Unknown: 3 };
function overall(byIssue) {
  const vals = Object.values(byIssue).map((x) => x.rating);
  if (!vals.length || vals.every((v) => v === "Unknown")) return "Unknown";
  return vals.filter((v) => v !== "Unknown").sort((a, b) => ORDER[a] - ORDER[b])[0]; // worst light wins
}
const memberId = (c) => `${c.house}:${c.electorate}:${c.name}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const q = req.query || {};
  const stateKey = String(q.state || CONFIG.site.default_jurisdiction || "").toUpperCase();
  const st = CONFIG.states[stateKey];
  if (!st || !st.enabled) return res.status(404).json({ error: `${stateKey || "that state"} is not switched on` });
  const seats = listSeats(stateKey, "assembly");
  const seat = seats.find((s) => s.name.toLowerCase() === String(q.district || "").toLowerCase());
  if (!seat) return res.status(404).json({ error: "Unknown district", options: seats.map((s) => s.name) });
  const region = splitName(seat.raw_name).region;

  const { candidates, retiring, source } = loadCandidates(stateKey);
  const retiringNames = new Set(retiring.map((r) => r.name));
  const shape = (c) => ({ ...c, member_id: memberId(c), retiring: retiringNames.has(c.name) });
  const lower = candidates.filter((c) => c.house === "assembly" && c.electorate === seat.name).map(shape);
  const upper = candidates.filter((c) => c.house === "council" && c.electorate === region).map(shape);

  let ratings = { issues: [], positions: [], party_positions: [], live: false };
  try { ratings = await fetchRatings(stateKey); } catch (e) { console.error("ratings unavailable:", e.message); }
  const issues = ratings.issues.length ? ratings.issues : PLACEHOLDER_ISSUES;

  const decorate = (m) => { const by = ratingsFor(m, issues, ratings); return { ...m, ratings: by, overall: overall(by) }; };
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  return res.status(200).json({
    state: stateKey, state_name: st.name, election: st.election,
    seat: { name: seat.name, code: seat.code, house: st.houses.assembly.name },
    region: region ? { name: region, house: st.houses.council.name, members: st.houses.council.per_voter } : null,
    issues,
    lower: lower.map(decorate),
    upper: upper.map(decorate),
    ratings_live: ratings.live,
    candidates_source: source || null,
  });
};
