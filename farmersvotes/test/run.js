// node test/run.js  -- the lookup engine, end to end, against the shipped data.
const assert = require("assert");
const path = require("path");
const E = require("../lib/electorates");
const handler = require("../api/lookup");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  ✗   " + name + "\n      " + (e.message || e).split("\n")[0]); }
}
const res = () => { const r = { code: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const byHouse = (seats, h) => seats.find((s) => s.house === h);

(async () => {
  console.log("electorate lookup");

  await test("config has exactly the states we switched on", () => {
    assert.deepStrictEqual(E.enabledStates(), ["VIC"]);
    const st = E.status();
    const vic = st.states.find((s) => s.key === "VIC");
    assert.ok(vic.data.state && vic.data.federal && vic.data.postcodes, "VIC boundary or postcode files missing");
    for (const s of st.states.filter((x) => !x.enabled)) assert.ok(!s.data.state, `${s.key} has data but is off; fine, just noting`);
  });

  await test("a point in Marnoo lands in Ripon, Western Victoria region", () => {
    const r = E.lookupPoint({ lng: 142.917, lat: -36.658 });
    assert.strictEqual(r.supported, true); assert.strictEqual(r.state, "VIC");
    assert.strictEqual(byHouse(r.seats, "assembly").name, "Ripon");
    assert.strictEqual(byHouse(r.seats, "council").name, "Western Victoria");
    assert.strictEqual(byHouse(r.seats, "council").members, 5, "every Victorian has five upper house members");
    assert.ok(!byHouse(r.seats, "reps"), "federal is off, so no federal seat");
    assert.strictEqual(r.election.date, "2026-11-28");
  });

  await test("known towns resolve to the right seats", () => {
    const cases = [
      [144.9631, -37.8136, "Melbourne", "Northern Metropolitan"],
      [142.20, -36.71, "Lowan", "Western Victoria"],
      [142.16, -34.19, "Mildura", "Northern Victoria"],
      [147.61, -37.83, "Gippsland East", "Eastern Victoria"],
      [144.28, -36.76, "Bendigo West", "Northern Victoria"],
    ];
    for (const [lng, lat, seat, region] of cases) {
      const r = E.lookupPoint({ lng, lat });
      assert.strictEqual(byHouse(r.seats, "assembly").name, seat, `${lng},${lat}`);
      assert.strictEqual(byHouse(r.seats, "council").name, region, `${lng},${lat}`);
    }
  });

  await test("a point in Sydney is reported as outside the enabled states, not as an error", () => {
    const r = E.lookupPoint({ lng: 151.2093, lat: -33.8688 });
    assert.strictEqual(r.supported, false); assert.deepStrictEqual(r.enabled, ["VIC"]);
  });

  await test("a postcode inside one seat resolves outright", () => {
    const r = E.lookupPostcode("3400");
    assert.strictEqual(r.resolved, true);
    assert.strictEqual(byHouse(r.seats, "assembly").name, "Lowan");
    assert.strictEqual(byHouse(r.seats, "council").name, "Western Victoria");
  });

  await test("a split postcode returns its options with shares that sum to one", () => {
    const r = E.lookupPostcode("3387");
    assert.strictEqual(r.resolved, false);
    const names = r.options.assembly.map((o) => o.name);
    assert.deepStrictEqual(names, ["Ripon", "Lowan"]);
    const sum = r.options.assembly.reduce((n, o) => n + o.share, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `shares sum to ${sum}`);
    assert.ok(r.options.assembly[0].share > 0.8, "Marnoo's postcode is mostly Ripon");
  });

  await test("a postcode in a state that is off says so by name", () => {
    const r = E.lookupPostcode("2000");
    assert.strictEqual(r.supported, false); assert.strictEqual(r.state, "NSW");
    assert.match(r.reason, /New South Wales is not switched on/);
  });

  await test("postcode edge cases: leading zero, junk, ACT ranges", () => {
    assert.strictEqual(E.stateOfPostcode("0800"), "NT");
    assert.strictEqual(E.stateOfPostcode("2600"), "ACT");
    assert.strictEqual(E.stateOfPostcode("2601"), "ACT");
    assert.strictEqual(E.stateOfPostcode("2650"), "NSW");
    assert.throws(() => E.lookupPostcode("abcd"), /four digits/);
  });

  await test("seat lists come out of the boundary data, not a hand-typed list", () => {
    const lower = E.listSeats("VIC", "assembly"), regions = E.listSeats("VIC", "council"), fed = E.listSeats("VIC", "reps");
    assert.strictEqual(lower.length, 88); assert.strictEqual(regions.length, 8); assert.strictEqual(fed.length, 38);
    assert.ok(lower.some((s) => s.name === "Ripon") && fed.some((s) => s.name === "Mallee"));
    assert.deepStrictEqual(regions.map((r) => r.name), ["Eastern Victoria", "North-Eastern Metropolitan", "Northern Metropolitan", "Northern Victoria", "South-Eastern Metropolitan", "Southern Metropolitan", "Western Metropolitan", "Western Victoria"]);
  });

  await test("lookups are fast enough for a serverless function", () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) E.lookupPoint({ lng: 142 + Math.random() * 7, lat: -39 + Math.random() * 5 });
    const ms = (Date.now() - t0) / 200;
    assert.ok(ms < 20, `${ms.toFixed(1)}ms per lookup`);
  });

  console.log("api/lookup");
  await test("GET ?postcode= answers with a day of edge cache", async () => {
    const r = res(); await handler({ method: "GET", query: { postcode: "3400" } }, r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.resolved, true); assert.match(r.headers["Cache-Control"], /s-maxage=86400/);
  });
  await test("GET ?lat=&lng= works and a bad request is a 400", async () => {
    let r = res(); await handler({ method: "GET", query: { lat: "-36.658", lng: "142.917" } }, r);
    assert.strictEqual(r.code, 200); assert.strictEqual(byHouse(r.body.seats, "assembly").name, "Ripon");
    r = res(); await handler({ method: "GET", query: {} }, r); assert.strictEqual(r.code, 400);
    r = res(); await handler({ method: "GET", query: { postcode: "12" } }, r); assert.strictEqual(r.code, 400);
  });
  await test("address lookup without a Maps key says so with a 501, never a crash", async () => {
    const saved = process.env.GOOGLE_MAPS_KEY; delete process.env.GOOGLE_MAPS_KEY;
    try { const r = res(); await handler({ method: "GET", query: { address: "Marnoo VIC" } }, r); assert.strictEqual(r.code, 501); assert.match(r.body.error, /postcode/); }
    finally { if (saved !== undefined) process.env.GOOGLE_MAPS_KEY = saved; }
  });

  console.log("candidates");
  await test("the Victorian candidate list covers every district and carries sources", () => {
    const file = require(path.join(__dirname, "..", "data", "candidates", "vic-2026.json"));
    const c = file.candidates, la = c.filter((x) => x.house === "assembly"), lc = c.filter((x) => x.house === "council");
    assert.match(file.source, /^https:\/\/en\.wikipedia\.org\/wiki\//, "the file says where it came from");
    assert.strictEqual(new Set(la.map((x) => x.electorate)).size, 88, "one row set per Assembly district");
    assert.strictEqual(new Set(lc.map((x) => x.electorate)).size, 8, "all eight Council regions");
    // Every seat either has its sitting member marked, or that member is on
    // the retiring list. A handful more are genuinely open (a resignation, a
    // disendorsement), so allow a small gap rather than a magic number.
    const incumbents = la.filter((x) => x.incumbent).length, retiringMLAs = file.retiring.filter((r) => r.house === "assembly").length;
    assert.ok(incumbents + retiringMLAs >= 84, `${incumbents} incumbents + ${retiringMLAs} retiring should cover nearly all 88 seats`);
    assert.ok(la.filter((x) => x.sources.length).length / la.length > 0.7, "most candidates have a citation URL");
    assert.ok(!c.some((x) => /^column \d/.test(x.party)), "every upper house candidate maps to a named party column");
    const seatNames = new Set(E.listSeats("VIC", "assembly").map((s) => s.name));
    const unknown = [...new Set(la.map((x) => x.electorate))].filter((d) => !seatNames.has(d));
    assert.deepStrictEqual(unknown, [], "every candidate district must match a boundary name");
    const missing = [...seatNames].filter((s) => !la.some((x) => x.electorate === s));
    assert.deepStrictEqual(missing, [], "every boundary seat has candidate rows");
    // Known facts, as a guard against silent column drift.
    const ripon = la.filter((x) => x.electorate === "Ripon");
    assert.ok(ripon.some((x) => x.name === "Martha Haylett" && x.party === "Labor" && x.incumbent), "Ripon: Haylett is the sitting Labor member");
    assert.ok(ripon.some((x) => x.party === "National") && ripon.some((x) => x.party === "Liberal"), "Ripon: Coalition (L)/(N) tags resolve to parties");
    const wv = lc.filter((x) => x.electorate === "Western Victoria");
    // Upper house tickets are joint Coalition lists, untagged, so "Coalition" is the honest label there.
    assert.ok(wv.some((x) => x.name === "Bev McArthur" && ["Coalition", "Liberal"].includes(x.party) && x.incumbent), "Western Victoria: McArthur is a sitting Coalition MLC");
    assert.ok(wv.some((x) => x.name === "Sarah Mansfield" && x.party === "Greens"), "Western Victoria: Mansfield is Greens, so the bands are aligned");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
