#!/usr/bin/env node
// Wikipedia "Candidates of the <year> <state> state election" -> JSON.
//
//   node scripts/import-candidates-wikipedia.js VIC 2026 [path/to/page.wikitext]
//
// Fetches the page's raw wikitext (or reads a saved copy) and writes
// data/candidates/<state>-<year>.json:
//   { source, fetched_at,
//     candidates: [{ house, electorate, name, party, incumbent, sources, ... }],
//     retiring:   [{ house, electorate, name, party, announced, sources }] }
// Every source URL Wikipedia cites for a name is kept: that is the evidence
// trail the ratings hang off.
//
// Wikipedia is a starting point, not the record. After nominations close
// the commission's declared list replaces it (VEC: 9 Nov 2026 for Victoria).
//
// Wikitext quirks handled here, because each one silently shifted a column:
//   - <ref> blocks span lines and contain pipes: lifted out into placeholders
//     before any splitting, then their URLs recovered per cell.
//   - A table opens "{|", then "|-", THEN the "!" header cells.
//   - A row can start "||" (Brunswick did): that is the electorate cell.
//   - Upper house tables stack several header/data bands for extra parties;
//     each data band is read against the header band directly above it.

const fs = require("fs");
const path = require("path");

const STATE_NAMES = { VIC: "Victorian", NSW: "New South Wales", QLD: "Queensland", SA: "South Australian", WA: "Western Australian", TAS: "Tasmanian", NT: "Northern Territory", ACT: "Australian Capital Territory" };
// Short forms Wikipedia uses in cells "(L)" and in header cells.
const PARTY_TAG = {
  L: "Liberal", N: "National", Ind: "Independent", FF: "Family First", AJP: "Animal Justice",
  SA: "Sustainable Australia", Sustainable: "Sustainable Australia", LBT: "Libertarian", DLP: "DLP",
  LC: "Legalise Cannabis", SFF: "Shooters, Fishers and Farmers", West: "Western Victoria Party",
  VS: "Victorian Socialists", Socialists: "Victorian Socialists", ON: "One Nation", Grn: "Greens", ALP: "Labor",
  Freedom: "Freedom Party", "EMI - Reform": "End Mass Immigration - Reform AU",
};
const ROW_SEP = /\n\|-[^\n]*\n/;

function parse(src) {
  const refs = [];
  const lift = (s) => s.replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, (m) => { refs.push(m); return `@@R${refs.length - 1}@@`; });
  const urlsIn = (s) => [...new Set([...s.matchAll(/@@R(\d+)@@/g)].flatMap((m) => [...refs[+m[1]].matchAll(/\burl\s*=\s*(https?:\/\/[^\s|}\]]+)/g)].map((u) => u[1])))];
  const clean = (s) => s.replace(/@@R\d+@@/g, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/'''/g, "").replace(/&nbsp;/g, " ").trim();
  const partyName = (raw) => { const c = clean(raw).replace(/\s*candidates?$/i, "").replace(/^Pauline Hanson's /, "").replace(/^Liberal\/National Coalition$/, "Coalition"); return PARTY_TAG[c] || c; };
  const splitNames = (cell) => clean(cell).split("\n").map((s) => s.trim()).filter(Boolean).map((nm) => {
    const m = nm.match(/^(.*?)\s*\(([^()]{1,40})\)\s*$/);
    return m ? { name: m[1].trim(), tag: m[2].trim() } : { name: nm, tag: null };
  });
  const resolveParty = (col, tag) => {
    if (/^Coalition$/i.test(col)) return tag ? (PARTY_TAG[tag] || tag) : "Coalition";
    if (/^Other/i.test(col)) return tag ? (PARTY_TAG[tag] || tag) : "Other";
    return tag && PARTY_TAG[tag] ? PARTY_TAG[tag] : col;
  };

  const text = lift(src);
  const at = (re) => { const i = text.search(re); return i; };
  const retStart = at(/\n==\s*Retiring MPs\s*==/), laStart = at(/\n==\s*Legislative Assembly\s*==/), lcStart = at(/\n==\s*Legislative Council\s*==/);
  const endStart = at(/\n==\s*(Resignations|References|See also|Notes)/);
  const candidates = [], retiring = [];

  // ---- retiring members: bullet list under party sub-headings
  if (retStart >= 0) {
    const ret = text.slice(retStart, laStart > retStart ? laStart : undefined);
    let party = null;
    for (const line of ret.split("\n")) {
      const h = line.match(/^===\s*(.*?)\s*===/); if (h) { party = clean(h[1]); continue; }
      if (!/^\*/.test(line)) continue;
      const name = clean((line.match(/\[\[([^\]]+)\]\]/) || [])[1] || "").split("|").pop();
      const house = /\bMLC\b/.test(line) ? "council" : "assembly";
      const seat = clean((line.match(/\(\s*\[\[[^\]]*\]\]\s*\)/) || [])[0] || "").replace(/^\(|\)$/g, "").replace(/ Region$/, "");
      const announced = (clean(line).match(/announced\s+([^<]+?)\s*$/) || [])[1] || null;
      if (name) retiring.push({ house, electorate: seat, name, party, announced, sources: urlsIn(line) });
    }
  }

  // ---- lower house: one table, one row per district
  if (laStart >= 0) {
    const la = text.slice(laStart, lcStart > laStart ? lcStart : (endStart > laStart ? endStart : undefined));
    const rows = la.split(ROW_SEP);
    const headerRow = rows.find((r) => /^!/m.test(r)) || "";
    const cols = [...headerRow.matchAll(/^!\s*(.*?)\s*$/gm)].map((m) => partyName(m[1]).replace(/^Held by$/i, "held_by").replace(/^Electorate$/i, "electorate"));
    for (const row0 of rows) {
      if (!/Electoral (district|division) of/.test(row0)) continue;
      // A leading "||" is the electorate cell, not an empty cell then a pipe.
      const row = row0.replace(/(^|\n)\|\|(?=\s*\[\[)/g, "$1|");
      const cells = ("\n" + row).split(/\n\|(?!\|)/).slice(1);
      const rec = Object.fromEntries(cols.map((c, i) => [c, cells[i] || ""]));
      const electorate = clean(rec.electorate || ""), held_by = clean(rec.held_by || "");
      for (const col of cols.filter((c) => c !== "electorate" && c !== "held_by")) {
        const raw = rec[col]; if (!raw || !clean(raw)) continue;
        const incumbent = /'''/.test(raw), sources = urlsIn(raw);
        for (const { name, tag } of splitNames(raw)) candidates.push({ house: "assembly", electorate, held_by, name, party: resolveParty(col, tag), incumbent, sources });
      }
    }
  }

  // ---- upper house: one table per region, in bands of header row + data row
  if (lcStart >= 0) {
    const lc = text.slice(lcStart, endStart > lcStart ? endStart : undefined);
    for (const block of lc.split(/\n===\s*/).slice(1)) {
      const region = clean(block.slice(0, block.indexOf("===")));
      const tblStart = block.indexOf("{|"); if (tblStart < 0) continue;
      const tblEnd = block.indexOf("\n|}", tblStart);
      const tbl = block.slice(tblStart, tblEnd > 0 ? tblEnd : undefined);
      let parties = [];
      for (const row of tbl.split(ROW_SEP)) {
        if (/^!/m.test(row)) { parties = [...row.matchAll(/^!\s*(.*?)\s*$/gm)].map((m) => partyName(m[1])); continue; }
        if (!/valign\s*=\s*top/i.test(row)) continue; // the colour-swatch row, or table chrome
        const cells = ("\n" + row).split(/\n\|\s*valign\s*=\s*top\s*\|?/i).slice(1);
        cells.forEach((cell, i) => {
          const col = parties[i] || `column ${i + 1}`;
          cell.split("\n").filter((l) => /^\s*#/.test(l)).forEach((l, pos) => {
            const first = splitNames(l.replace(/^\s*#\s*/, ""))[0];
            if (!first || !first.name) return;
            candidates.push({ house: "council", electorate: region, ticket_position: pos + 1, name: first.name, party: resolveParty(col, first.tag), incumbent: /'''/.test(l), sources: urlsIn(l) });
          });
        });
      }
    }
  }
  return { candidates, retiring };
}

async function main() {
  const state = String(process.argv[2] || "VIC").toUpperCase(), year = process.argv[3] || String(new Date().getFullYear()), local = process.argv[4];
  const title = `Candidates_of_the_${year}_${STATE_NAMES[state]}_state_election`.replace(/ /g, "_");
  const source = `https://en.wikipedia.org/wiki/${title}`;
  let src;
  if (local) src = fs.readFileSync(local, "utf8");
  else {
    const r = await fetch(`https://en.wikipedia.org/w/index.php?title=${title}&action=raw`, { headers: { "User-Agent": "FarmersVotesResearch/1.0 (support@farmersfightback.com)" } });
    if (!r.ok) throw new Error(`Wikipedia ${title} -> HTTP ${r.status}`);
    src = await r.text();
  }
  const { candidates, retiring } = parse(src);
  const outDir = path.join(__dirname, "..", "data", "candidates");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${state.toLowerCase()}-${year}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ source, fetched_at: new Date().toISOString(), candidates, retiring }, null, 1));
  const la = candidates.filter((o) => o.house === "assembly"), lc = candidates.filter((o) => o.house === "council");
  console.log(outFile);
  console.log(`assembly: ${new Set(la.map((o) => o.electorate)).size} districts, ${la.length} candidates, ${la.filter((o) => o.incumbent).length} incumbents, ${la.filter((o) => o.sources.length).length} with a source`);
  console.log(`council:  ${new Set(lc.map((o) => o.electorate)).size} regions, ${lc.length} candidates, ${lc.filter((o) => o.incumbent).length} incumbents`);
  console.log(`retiring: ${retiring.filter((r) => r.house === "assembly").length} MLAs, ${retiring.filter((r) => r.house === "council").length} MLCs`);
  const byParty = candidates.reduce((a, o) => (a[o.party] = (a[o.party] || 0) + 1, a), {});
  console.log("by party:", JSON.stringify(Object.fromEntries(Object.entries(byParty).sort((x, y) => y[1] - x[1]))));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parse };
