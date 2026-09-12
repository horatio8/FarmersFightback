// GET /api/parties?state=VIC
// The comparison grid: issues down, parties across. Majors first, the rest
// behind an expander on the page. Reads Party Positions and Issues from
// Airtable; placeholders until the base is configured and populated.

const CONFIG = require("../config/jurisdictions.json");
const { fetchRatings } = require("../lib/airtable");

const PLACEHOLDER_ISSUES = [1, 2, 3, 4, 5, 6].map((n) => ({ slug: `issue-${n}`, title: `Issue ${n} (placeholder)`, order: n, in_party_grid: true }));

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const stateKey = String((req.query || {}).state || CONFIG.site.default_jurisdiction || "").toUpperCase();
  const st = CONFIG.states[stateKey];
  if (!st || !st.enabled) return res.status(404).json({ error: `${stateKey || "that state"} is not switched on` });
  let ratings = { issues: [], party_positions: [], live: false };
  try { ratings = await fetchRatings(stateKey); } catch (e) { console.error("parties unavailable:", e.message); }
  const issues = (ratings.issues.length ? ratings.issues : PLACEHOLDER_ISSUES).filter((i) => i.in_party_grid !== false);
  const majors = st.parties_major || [], others = st.parties_other || [];
  const row = (party, major) => ({
    party, major,
    ratings: Object.fromEntries(issues.map((i) => {
      const pp = ratings.party_positions.find((p) => p.party === party && p.issue_slug === i.slug);
      return [i.slug, pp ? { rating: pp.rating || "Unknown", sources: pp.source_urls || [], evidence: pp.evidence || "" } : { rating: "Unknown", sources: [], evidence: "" }];
    })),
  });
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  return res.status(200).json({ state: stateKey, state_name: st.name, issues, majors: majors.map((p) => row(p, true)), others: others.map((p) => row(p, false)), live: ratings.live });
};
