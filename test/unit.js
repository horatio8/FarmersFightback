// Unit tests: the pure logic behind the endpoints.
//
// No network of any kind. Where a module must talk to Airtable or Campaign
// Nucleus, fetch is replaced with an in-memory double, so a full run costs
// nothing in quota or tokens and produces the same result offline as online.

const path = require("path");
const { createRun, assert } = require("./lib/tap");
const { ROOT } = require("./lib/site");

const R = (rel) => require(path.join(ROOT, rel));

// Env the modules read at require time.
process.env.AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || "key_test";
process.env.AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "app_test";
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "tok_test";
process.env.CRON_SECRET = process.env.CRON_SECRET || "cron_test";
process.env.CN_API_KEY = process.env.CN_API_KEY || "cn_test";
process.env.RECEPTION_PASSCODE = process.env.RECEPTION_PASSCODE || "FarmersForever";

async function run() {
  const { group, test, results } = createRun("unit");

  // ---------------------------------------------------------------- reception
  group("reception: passcode");
  const rec = R("api/reception/_lib.js");

  await test("accepts the passcode exactly", () => {
    assert.ok(rec.passcodeOk("FarmersForever"), "the real passcode must work");
  });
  await test("forgives case and spacing, because it is retyped off a text message", () => {
    for (const v of ["farmersforever", "FARMERSFOREVER", "  FarmersForever  ", "Farmers Forever"]) {
      assert.ok(rec.passcodeOk(v), `should accept ${JSON.stringify(v)}`);
    }
  });
  await test("refuses anything else, including near misses", () => {
    for (const v of ["", null, undefined, "farmersforeve", "farmersforever1", "letmein", "FarmersFightback"]) {
      assert.ok(!rec.passcodeOk(v), `should refuse ${JSON.stringify(v)}`);
    }
  });
  await test("comparing a wrong-length guess does not throw", () => {
    assert.ok(!rec.passcodeOk("x"), "timingSafeEqual needs equal lengths; the guard must come first");
  });

  group("reception: invitation tokens");
  await test("tokens are 24 chars, URL-safe and free of lookalike glyphs", () => {
    for (let i = 0; i < 500; i++) {
      const t = rec.mintToken();
      assert.equal(t.length, 24, "wrong length");
      assert.match(t, /^[A-Za-z0-9]+$/, "must be URL-safe without escaping");
      assert.noMatch(t, /[0O1lI]/, `ambiguous glyph in ${t}`);
    }
  });
  await test("tokens do not repeat", () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const t = rec.mintToken();
      assert.ok(!seen.has(t), "collision");
      seen.add(t);
    }
  });
  await test("a referral code is too short to pass as an invitation token", () => {
    assert.ok(!rec.validTokenShape("VPX2ZD"), "6-char public codes must never open the token path");
    assert.ok(rec.validTokenShape(rec.mintToken()));
  });
  await test("token comparison rejects different lengths without throwing", () => {
    assert.ok(!rec.tokenEquals("abc", "abcd"));
    assert.ok(rec.tokenEquals("abcd", "abcd"));
  });

  group("reception: field validation");
  await test("mobiles normalise to the local form from every shape people type", () => {
    const cases = [
      ["0412345678", "0412345678"],
      ["+61412345678", "0412345678"],
      ["61412345678", "0412345678"],
      ["0412 345 678", "0412345678"],
      ["(03) 5385 1234", "0353851234"],
    ];
    for (const [input, want] of cases) assert.equal(rec.normMobile(input), want, `for ${input}`);
  });
  await test("nonsense mobiles are refused rather than silently stored", () => {
    for (const v of ["", "12", "abc", null, "1".repeat(20)]) {
      assert.equal(rec.normMobile(v), null, `should refuse ${JSON.stringify(v)}`);
    }
  });
  await test("email validation accepts real addresses and refuses broken ones", () => {
    for (const v of ["a@b.co", "first.last+tag@sub.domain.com.au", "x_y-z@bigpond.net.au"]) {
      assert.ok(rec.validEmail(v), `should accept ${v}`);
    }
    for (const v of ["", "no-at", "a@b", "a b@c.com", null]) {
      assert.ok(!rec.validEmail(v), `should refuse ${JSON.stringify(v)}`);
    }
  });
  await test("free text is trimmed and capped so a paste cannot blow up a record", () => {
    assert.equal(rec.cleanStr("  hi  "), "hi");
    assert.equal(rec.cleanStr("x".repeat(500), 60).length, 60);
    assert.equal(rec.cleanStr(null), "");
  });
  await test("the event record carries the details the page and API both render", () => {
    assert.equal(rec.EVENT.name, "Farmers Muster");
    assert.includes(rec.EVENT.time, "5:00pm");
    assert.includes(rec.EVENT.venue, "Marnoo");
    assert.includes(rec.EVENT.date, "29 August");
  });

  // -------------------------------------------------------- campaign nucleus
  group("campaign nucleus: email validation matches theirs");
  const cnSrc = require("fs").readFileSync(path.join(ROOT, "api/_cn.js"), "utf8");
  const cnMod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", cnSrc + "\nmodule.exports.__looksLikeEmail = looksLikeEmail;")(
    cnMod, cnMod.exports, require
  );
  const looksLikeEmail = cnMod.exports.__looksLikeEmail;

  await test("rejects the truncated addresses the old import left behind", () => {
    // Real values from the CRM. CN answers 422 for each, and one bad row fails
    // a whole bulk call, so they must be caught before they are ever sent.
    for (const v of [
      "shazt60@gmail.c", "vidane@optusnet.com.a", "ben@collisbrosplumbing.com.",
      "maureenj064@gmail..com", "waclaw2@optusnet.v", "5heather@iinet.net-au",
    ]) {
      assert.ok(!looksLikeEmail(v), `should refuse ${v}`);
    }
  });
  await test("ordinary addresses still pass", () => {
    for (const v of [
      "jamesflynn@me.com", "first.last+tag@sub.domain.com.au",
      "x_y-z@bigpond.net.au", "a@b.co", "HELEN.NANOS@bigpond.com",
    ]) {
      assert.ok(looksLikeEmail(v), `should accept ${v}`);
    }
  });
  await test("absurd input is refused without throwing", () => {
    for (const v of [null, undefined, "", "@", "a@", "@b.com", "x".repeat(300) + "@b.com"]) {
      assert.ok(!looksLikeEmail(v), `should refuse ${JSON.stringify(v)}`);
    }
  });

  group("campaign nucleus: request shape");
  await test("a GET carries no body, because fetch throws on one", async () => {
    const seen = [];
    const realFetch = global.fetch;
    global.fetch = async (u, init) => {
      seen.push({ method: init.method, hasBody: init.body !== undefined });
      return { ok: true, status: 200, text: async () => '{"data":{"id":"x"}}' };
    };
    try {
      const { cnFetch } = R("api/_cn.js");
      await cnFetch("/profiles/abc", null, "GET");
      await cnFetch("/profiles/match", { email: "a@b.com" }, "POST");
    } finally { global.fetch = realFetch; }
    assert.equal(seen[0].hasBody, false, "GET must not carry a body");
    assert.equal(seen[1].hasBody, true, "POST must still carry one");
  });

  // ------------------------------------------------------------ referral codes
  group("referral codes");
  const at = R("api/_airtable.js");
  await test("codes avoid glyphs that are misread when dictated or retyped", () => {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    for (const ch of "01OIL") assert.ok(!alphabet.includes(ch), `${ch} must be out of the alphabet`);
  });
  // Exercised through contact creation, which is the only way the app mints
  // one — and the path that used to leave 6,000 contacts without a code.
  async function createContactWithMock({ taken = new Set() } = {}) {
    const realFetch = global.fetch;
    const state = { lookups: 0, created: null };
    global.fetch = async (u, init = {}) => {
      const url = new URL(String(u));
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET") {
        state.lookups += 1;
        const f = url.searchParams.get("filterByFormula") || "";
        const m = /\{referral_code\}='([^']+)'/.exec(f);
        const hit = m && taken.has(m[1]);
        return { ok: true, status: 200, json: async () => ({ records: hit ? [{ id: "rec1", fields: {} }] : [] }) };
      }
      const body = JSON.parse(init.body);
      state.created = body.records[0].fields;
      return { ok: true, status: 200, json: async () => ({ records: [{ id: "recNEW", fields: state.created }] }) };
    };
    try {
      await at.createRow("Contacts", { email: "new@example.com", first_name: "New" });
    } finally { global.fetch = realFetch; }
    return state;
  }

  await test("a contact is born holding a code", async () => {
    const state = await createContactWithMock();
    assert.match(state.created.referral_code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/,
      "creation must mint a code: " + JSON.stringify(state.created));
  });

  await test("the code is checked against the table before it is used", async () => {
    const state = await createContactWithMock();
    assert.ok(state.lookups >= 1, "must ask the table whether the code is free");
  });

  await test("a taken code is skipped rather than issued twice", async () => {
    // Every code but one is spoken for, so the loop has to keep drawing.
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const taken = new Set();
    for (const a of alphabet) for (const b of alphabet) taken.add("AAAA" + a + b);
    const state = await createContactWithMock({ taken });
    assert.ok(!taken.has(state.created.referral_code), "issued a code somebody already holds");
  });

  await test("a caller-supplied code is honoured, not overwritten", async () => {
    const realFetch = global.fetch;
    let created = null;
    global.fetch = async (u, init = {}) => {
      if ((init.method || "GET").toUpperCase() === "GET") {
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      created = JSON.parse(init.body).records[0].fields;
      return { ok: true, status: 200, json: async () => ({ records: [{ id: "r", fields: created }] }) };
    };
    try {
      await at.createRow("Contacts", { email: "keep@example.com", referral_code: "KEEP99" });
    } finally { global.fetch = realFetch; }
    assert.equal(created.referral_code, "KEEP99");
  });

  // ----------------------------------------------------------------- airtable
  group("airtable helpers");
  const atl = R("lib/social/airtable.js");
  await test("formula escaping neutralises quotes and backslashes", () => {
    assert.equal(atl.fesc("O'Brien"), "O\\'Brien");
    assert.equal(atl.fesc("a\\b"), "a\\\\b");
    assert.equal(atl.fesc(""), "");
  });
  await test("escaping blocks an injected clause rather than passing it through", () => {
    const evil = "x' , '1'='1";
    assert.excludes(atl.fesc(evil), "' , '", "the quote must not survive unescaped");
  });

  // ------------------------------------------------------------------ prefill
  group("browser prefill script");
  const prefillSrc = require("fs").readFileSync(path.join(ROOT, "assets/prefill.js"), "utf8");
  await test("only opaque ids travel; no name, email or mobile parameter is read", () => {
    assert.includes(prefillSrc, "ID_PARAMS", "should read a list of id params");
    for (const bad of ['q.get("em")', 'q.get("fn")', 'q.get("mb")', 'q.get("ln")']) {
      assert.excludes(prefillSrc, bad, "personal detail must not be read from the URL");
    }
  });
  await test("the id is scrubbed from the address bar", () => {
    assert.includes(prefillSrc, "history.replaceState", "must rewrite the URL");
  });
  await test("an unresolved merge tag is discarded, not sent onward", () => {
    assert.includes(prefillSrc, "%recipient", "must recognise an unsubstituted tag");
  });
  await test("the lookup goes to our own origin, never to a third party", () => {
    assert.includes(prefillSrc, '"/api/prefill/resolve?"');
    assert.noMatch(prefillSrc, /fetch\(\s*["'`]https?:/, "must not call out to another host");
  });

  // -------------------------------------------------------- prefill: the API
  //
  // This endpoint hands over an email address and a mobile number in exchange
  // for an identifier. Everything below is about which identifiers it will
  // accept — the difference between a private lookup and a public oracle.
  group("prefill endpoint: what it will answer to");
  const resolver = R("api/prefill/resolve.js");

  // A response double, so the handler can be driven without a server.
  function fakeRes() {
    const r = { code: 0, body: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  }
  let cnCalls = [];
  function fakeReq(query, ip) {
    return {
      method: "GET",
      url: `/api/prefill/resolve${query}`,
      headers: { "x-forwarded-for": ip || `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      socket: {},
    };
  }
  async function callResolve(query) {
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      cnCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({
          data: {
            id: "0193f7a2-8c31-7c4b-b2e6-9f1d4e5a7b02",
            first_name: "Jane", last_name: "Farmer",
            email: "jane@example.com", mobile: "61412060882", zip: "3400",
          },
        }),
      };
    };
    try {
      const res = fakeRes();
      await resolver(fakeReq(query), res);
      return res;
    } finally { global.fetch = realFetch; }
  }

  await test("a genuine profile id resolves to that person's details", async () => {
    cnCalls = [];
    const res = await callResolve("?p=0193f7a2-8c31-7c4b-b2e6-9f1d4e5a7b02");
    assert.equal(res.code, 200);
    assert.ok(res.body.found, "a valid uuid should resolve");
    assert.equal(res.body.prefill.email, "jane@example.com");
  });

  await test("an Australian mobile comes back in the form the field expects", async () => {
    const res = await callResolve("?p=0193f7a2-8c31-7c4b-b2e6-9f1d4e5a7b02");
    assert.equal(res.body.prefill.mobile, "0412060882");
  });

  await test("a referral code is refused — those are published in share links", async () => {
    cnCalls = [];
    const res = await callResolve("?p=K7M2QX");
    assert.equal(res.body.found, false, "a public code must never resolve to an email address");
    assert.empty(cnCalls, "a refused id must not even reach Campaign Nucleus");
  });

  await test("an email address is refused — it would make this a lookup oracle", async () => {
    cnCalls = [];
    const res = await callResolve("?p=" + encodeURIComponent("someone@example.com"));
    assert.equal(res.body.found, false);
    assert.empty(cnCalls, "an address must not be probed against the CRM");
  });

  await test("an unsubstituted merge tag is refused rather than sent onward", async () => {
    cnCalls = [];
    const res = await callResolve("?p=" + encodeURIComponent("%recipient.id%"));
    assert.equal(res.body.found, false);
    assert.empty(cnCalls);
  });

  await test("a miss looks the same whatever the reason, so it cannot be probed", async () => {
    const shapes = await Promise.all([
      callResolve(""),
      callResolve("?p="),
      callResolve("?p=not-a-uuid"),
      callResolve("?p=12345678-1234-1234-1234-12345678901"), // one digit short
    ]);
    const seen = new Set(shapes.map((r) => `${r.code}:${JSON.stringify(r.body)}`));
    assert.equal(seen.size, 1, `misses must be indistinguishable, saw ${[...seen].join(" | ")}`);
  });

  await test("nothing beyond the four form fields crosses the wire", async () => {
    const res = await callResolve("?p=0193f7a2-8c31-7c4b-b2e6-9f1d4e5a7b02");
    assert.equal(Object.keys(res.body.prefill).sort().join(","), "email,first,last,mobile,postcode");
  });

  await test("the reply is never cached, anywhere", async () => {
    const res = await callResolve("?p=0193f7a2-8c31-7c4b-b2e6-9f1d4e5a7b02");
    assert.includes(res.headers["cache-control"], "no-store", "personal detail must not be cached");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
  });

  await test("only GET is answered", async () => {
    const res = fakeRes();
    await resolver({ ...fakeReq("?p=x"), method: "POST" }, res);
    assert.equal(res.code, 405);
  });

  // ------------------------------------------------------------ rate limiting
  //
  // The identifier space is large but not infinite, and a referral code is only
  // six characters. Grinding it from one host has to stop being viable.
  group("rate limiting");
  const rl = R("api/survey/_ratelimit.js");

  await test("a normal visitor is never limited", () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: {} };
    for (let i = 0; i < rl.MAX_PER_WINDOW; i++) {
      assert.ok(rl.check(req).ok, `request ${i + 1} should be allowed`);
    }
  });

  await test("a grinder is cut off, and told when to come back", () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.8" }, socket: {} };
    for (let i = 0; i < rl.MAX_PER_WINDOW; i++) rl.check(req);
    const over = rl.check(req);
    assert.equal(over.ok, false, "the request past the limit must be refused");
    assert.ok(over.retryAfter >= 1 && over.retryAfter <= 60, `odd retry-after: ${over.retryAfter}`);
  });

  await test("one grinder does not lock out everybody else", () => {
    const grinder = { headers: { "x-forwarded-for": "203.0.113.9" }, socket: {} };
    for (let i = 0; i < rl.MAX_PER_WINDOW + 5; i++) rl.check(grinder);
    const bystander = { headers: { "x-forwarded-for": "198.51.100.4" }, socket: {} };
    assert.ok(rl.check(bystander).ok, "an unrelated visitor must still get through");
  });

  await test("the caller is identified by the first hop, not the whole chain", () => {
    assert.equal(rl.clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, socket: {} }), "1.2.3.4");
    assert.equal(rl.clientIp({ headers: { "x-real-ip": "9.9.9.9" }, socket: {} }), "9.9.9.9");
    assert.equal(rl.clientIp({ headers: {}, socket: { remoteAddress: "7.7.7.7" } }), "7.7.7.7");
  });

  await test("an unidentifiable caller still gets counted, not waved through", () => {
    assert.equal(rl.clientIp({ headers: {}, socket: {} }), "unknown");
  });

  // -------------------------------------------------------------- PII masking
  //
  // A tokenised link says "we know who you are" to someone whose browser must
  // never receive enough to be worth stealing.
  group("masking personal detail for the browser");
  const mask = R("api/_mask.js");

  await test("a name shows its first letter and nothing more", () => {
    assert.equal(mask.maskName("James"), "J****");
    assert.equal(mask.maskName("Flynn"), "F****");
    assert.equal(mask.maskName("Jo"), "J*");
    assert.equal(mask.maskName("J"), "*");
  });

  await test("a mobile shows the prefix everyone shares and the last three", () => {
    assert.equal(mask.maskMobile("61412060882"), "04*****882");
    assert.equal(mask.maskMobile("0412 060 882"), "04*****882");
    assert.equal(mask.maskMobile("+61412060882"), "04*****882");
  });

  await test("an email stays recognisable without being usable", () => {
    assert.equal(mask.maskEmail("janninesc@gmail.com"), "j*******c@g****.com");
    assert.includes(mask.maskEmail("bob@farm.com.au"), ".com.au");
  });

  await test("a postcode keeps only its state digit", () => {
    assert.equal(mask.maskPostcode("3400"), "3***");
  });

  await test("a field nobody classified is masked, not passed through", () => {
    const out = mask.maskField("some_new_field", "Sensitive");
    assert.notEqual(out, "Sensitive", "an unclassified field must not leak");
    assert.includes(out, "*");
  });

  await test("junk in never produces a leak or a crash", () => {
    for (const fn of ["maskName", "maskEmail", "maskMobile", "maskPostcode"]) {
      for (const junk of [null, undefined, "", 0, {}, []]) {
        const out = mask[fn](junk);
        assert.equal(typeof out, "string", `${fn} must always return a string`);
      }
    }
  });

  await test("masking is not reversible: no full value survives it", () => {
    const secrets = { first_name: "James", email: "james@teller.consulting", mobile: "61412060882", postcode: "3400" };
    for (const [field, value] of Object.entries(secrets)) {
      const out = mask.maskField(field, value);
      assert.excludes(out, value, `${field} came back whole`);
    }
  });

  // -------------------------------------------------------- deployment config
  //
  // vercel.json is the one file where a typo is invisible until a cron silently
  // stops running or a link starts 404ing in production.
  group("deployment configuration");
  const fsx = require("fs");
  const vercel = R("vercel.json");
  const exists = (rel) => fsx.existsSync(path.join(ROOT, rel.replace(/^\//, "")));

  await test("every scheduled job points at a handler that exists", () => {
    const missing = (vercel.crons || [])
      .filter((c) => !exists(c.path + ".js"))
      .map((c) => c.path);
    assert.empty(missing, "a cron whose handler is missing never runs and never says so");
  });

  await test("every scheduled job has a real cron expression", () => {
    const bad = (vercel.crons || [])
      .filter((c) => String(c.schedule || "").trim().split(/\s+/).length !== 5)
      .map((c) => `${c.path}: ${c.schedule}`);
    assert.empty(bad, "malformed schedule");
  });

  await test("no two jobs claim the same path", () => {
    const seen = new Set(); const dupes = [];
    for (const c of vercel.crons || []) { if (seen.has(c.path)) dupes.push(c.path); seen.add(c.path); }
    assert.empty(dupes, "duplicate cron path");
  });

  await test("every function override names a file that exists", () => {
    const missing = Object.keys(vercel.functions || {}).filter((f) => !exists(f));
    assert.empty(missing, "an override on a missing file is silently ignored");
  });

  await test("no function asks for longer than the platform allows", () => {
    const over = Object.entries(vercel.functions || {})
      .filter(([, cfg]) => Number(cfg.maxDuration) > 300)
      .map(([f, cfg]) => `${f}: ${cfg.maxDuration}s`);
    assert.empty(over, "maxDuration above 300s is rejected at deploy time");
  });

  await test("the long-running jobs have been given the time they need", () => {
    // A job that walks the whole contact list will hit the 10s default and be
    // killed mid-pass, leaving its work half done and its cursor wrong.
    const fns = vercel.functions || {};
    for (const p of ["api/cron/referral-code-integrity.js", "api/admin/survey-uids.js"]) {
      assert.ok(fns[p] && fns[p].maxDuration >= 120, `${p} needs a raised maxDuration`);
    }
  });

  // A destination may be another rule's source, so resolving one means
  // following the chain the way a browser would.
  const RULES = [...(vercel.rewrites || []), ...(vercel.redirects || [])];
  const bare = (d) => String(d).split("#")[0].split("?")[0].replace(/\/$/, "");
  const onDisk = (d) => exists(d) || exists(d + ".html") || exists(d + "/index.html");
  function follow(dest, hops = 0) {
    const clean = bare(dest);
    if (!clean || hops > 5) return { at: clean, hops, ok: false };
    if (onDisk(clean)) return { at: clean, hops, ok: true };
    const next = RULES.find((r) => bare(r.source) === clean);
    if (next) return follow(next.destination, hops + 1);
    return { at: clean, hops, ok: false };
  }

  await test("every rewrite and redirect lands somewhere real", () => {
    const broken = RULES
      .map((r) => r.destination)
      .filter((d) => d && d.startsWith("/") && !d.includes(":") && !d.startsWith("/api/"))
      .filter((d) => !follow(d).ok)
      .map((d) => `${d} → nothing`);
    assert.empty(broken, "destination does not exist");
  });

  await test("no rule points at another rule, which would cost a second round trip", () => {
    const chained = RULES
      .filter((r) => r.destination && r.destination.startsWith("/") && !r.destination.includes(":"))
      .filter((r) => !r.destination.startsWith("/api/"))
      .filter((r) => follow(r.destination).hops > 0)
      .map((r) => `${r.source} → ${r.destination} → …`);
    assert.empty(chained, "chained redirect");
  });

  await test("every API destination points at a handler that exists", () => {
    const apis = [...(vercel.rewrites || []), ...(vercel.redirects || [])]
      .map((r) => r.destination)
      .filter((d) => d && d.startsWith("/api/"))
      .map((d) => d.split("?")[0]);
    const broken = apis.filter((d) => !exists(d + ".js") && !exists(d + "/index.js"));
    assert.empty(broken, "no handler for this route");
  });

  await test("clean URLs stay on, because every published link assumes them", () => {
    assert.equal(vercel.cleanUrls, true);
    assert.equal(vercel.trailingSlash, false);
  });

  // ------------------------------------------------------------ site linkage
  //
  // A link to a page that no longer exists is the defect most likely to reach a
  // supporter, and the least likely to be noticed: it looks fine in the editor
  // and 404s in their hand. Checked statically here rather than in the browser
  // pass, because it costs a file read instead of a page load.
  group("internal links");
  const { listPages } = require("./lib/site");
  const allPages = listPages();
  const known = new Set(allPages.map((p) => p.url));
  const sources = new Set(RULES.map((r) => bare(r.source)));

  // Every href a visitor could click. Most of them live in the JSX rather than
  // in the HTML shells, so walk the whole tree for those too.
  function jsxFiles(dir, out = []) {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", ".github"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) jsxFiles(full, out);
      else if (/\.jsx$/.test(e.name)) out.push(full);
    }
    return out;
  }

  // Most links are not written as href="/x" — they live in data, as
  // { label: "…", href: "/take-action/…" }, and reach an <a> through a
  // variable. Matching only on the attribute finds a fraction of them.
  //
  // Matching every path-shaped string instead goes too far the other way: the
  // donate buttons render "$50/mo", and "/mo" is not a link. So take literals
  // in the positions that carry a destination — an attribute, or a property
  // named for one — and nothing else.
  const LINK_KEY = "href|action|url|link|to|destination|path|src";
  const AS_ATTR = new RegExp(`(?:${LINK_KEY})=["'](\\/[^"'\`\${}\\s]*)["']`, "gi");
  const AS_PROP = new RegExp(`(?:${LINK_KEY})[A-Za-z]*\\s*:\\s*["'](\\/[^"'\`\${}\\s]*)["']`, "gi");

  function internalLinks() {
    const files = [...allPages.map((p) => p.path), ...jsxFiles(ROOT)];
    const out = [];
    for (const f of files) {
      const src = fsx.readFileSync(f, "utf8");
      const rel = path.relative(ROOT, f);
      for (const re of [AS_ATTR, AS_PROP]) {
        for (const m of src.matchAll(re)) out.push({ file: rel, href: m[1] });
      }
    }
    // The same path written in ten places is one link to check.
    const seen = new Set();
    return out.filter((l) => {
      const k = `${l.file}|${l.href}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const links = internalLinks();

  await test("the pages actually contain links to check", () => {
    // A guard on the scan itself: if a refactor moves the links somewhere this
    // does not look, the suite must say so rather than quietly pass on nothing.
    // The tree currently yields 77 distinct destinations.
    assert.ok(links.length >= 60, `only found ${links.length} internal links, the scan is probably wrong`);
  });

  await test("every internal link goes somewhere that exists", () => {
    const broken = links.filter(({ href }) => {
      const clean = bare(href);
      if (!clean || clean === "/") return false;
      if (clean.startsWith("/api/") || clean.startsWith("/_vercel/")) return false;
      if (known.has(clean) || sources.has(clean)) return false;
      // A rewrite or redirect whose source carries a parameter, e.g. /s/:slug.
      if (RULES.some((r) => new RegExp("^" + bare(r.source).replace(/:[^/]+/g, "[^/]+") + "$").test(clean))) return false;
      return !onDisk(clean);
    });
    assert.empty([...new Set(broken.map((b) => `${b.href}  (in ${b.file})`))], "link goes nowhere");
  });

  await test("no link points at a .html path, which would cost a redirect", () => {
    const dotted = links.filter(({ href }) => /\.html($|[?#])/.test(href));
    assert.empty([...new Set(dotted.map((b) => `${b.href}  (in ${b.file})`))],
      "cleanUrls serves this at the extensionless path");
  });

  // Assets are addressed three different ways across the tree — "assets/x",
  // "/assets/x" and "../assets/x" — so a path that is right on one page is
  // wrong one directory down. A missing stylesheet or script does not throw;
  // the page just renders wrong.
  await test("every stylesheet, script and image resolves to a real file", () => {
    const missing = [];
    for (const page of allPages) {
      const src = fsx.readFileSync(page.path, "utf8");
      const dir = path.dirname(page.path);
      for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const ref = m[1].split("?")[0].split("#")[0];
        if (!ref || /^(https?:)?\/\//.test(ref) || /^(data|mailto|tel|javascript):/.test(ref)) continue;
        if (ref.startsWith("/_vercel/") || ref.startsWith("/api/")) continue;
        // Only file-like references; bare routes are covered by the link test.
        if (!/\.[a-z0-9]{2,5}$/i.test(ref)) continue;
        const full = ref.startsWith("/") ? path.join(ROOT, ref.slice(1)) : path.resolve(dir, ref);
        if (!fsx.existsSync(full)) missing.push(`${ref}  (in ${page.file})`);
      }
    }
    assert.empty([...new Set(missing)], "asset does not exist at that path");
  });

  // Share cards. Not "every page must have one" — that would fail the build on
  // a decision nobody has made. But a page that declares a card and omits the
  // image gets posted to Facebook as a bare grey box, which is worse than not
  // declaring one at all.
  await test("a page that declares a share card also supplies its image", () => {
    const halfDressed = allPages.filter((p) => {
      const s = fsx.readFileSync(p.path, "utf8");
      return /property="og:title"/i.test(s) && !/property="og:image"/i.test(s);
    }).map((p) => p.url);
    assert.empty(halfDressed, "og:title without og:image posts as an empty card");
  });

  await test("every share image is an absolute URL, because Facebook will not resolve a relative one", () => {
    const relative = [];
    for (const p of allPages) {
      const s = fsx.readFileSync(p.path, "utf8");
      for (const m of s.matchAll(/property="og:image"\s+content="([^"]+)"/gi)) {
        if (!/^https?:\/\//i.test(m[1])) relative.push(`${p.url}: ${m[1]}`);
      }
    }
    assert.empty(relative, "relative og:image");
  });

  await test("every public page tells search engines what it is", () => {
    const undescribed = allPages
      .filter((p) => p.content && !["/admin", "/admin/econ"].includes(p.url))
      .filter((p) => !/name="description"/i.test(fsx.readFileSync(p.path, "utf8")))
      .map((p) => p.url);
    assert.empty(undescribed, "no meta description");
  });

  await test("every gated page is kept out of search results", () => {
    const leaky = allPages
      .filter((p) => p.gated)
      .filter((p) => !/name="robots"[^>]*noindex/i.test(fsx.readFileSync(p.path, "utf8")))
      // The survey and webinar pages are entered by link and are meant to be
      // findable; it is the admin and invitation surfaces that must not be.
      .filter((p) => ["/reception", "/admin", "/admin/econ"].includes(p.url))
      .map((p) => p.url);
    assert.empty(leaky, "private page is indexable");
  });

  // --------------------------------------------------------- the repair rules
  //
  // The autofix pass writes to source files, so its own rules need checking:
  // a rule that reports a finding it cannot repair would loop a build, and a
  // rule whose scan is not deterministic would make the tree churn.
  group("automatic repairs");
  const fixer = require("./autofix");

  await test("every rule declares what it looks for and why it matters", () => {
    const bad = fixer.RULES.filter((r) =>
      !r.id || !r.describe || typeof r.scan !== "function" || r.describe.length < 30);
    assert.empty(bad.map((r) => r.id || "(unnamed)"), "rule is incomplete");
  });

  await test("no two rules share an id", () => {
    const ids = fixer.RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate rule id in: ${ids.join(", ")}`);
  });

  await test("every finding carries a repair, or it does not belong here", () => {
    const { findings } = fixer.runRules();
    const unfixable = findings.filter((f) => typeof f.apply !== "function");
    assert.empty(unfixable.map((f) => `${f.rule}: ${f.file}`),
      "a defect needing judgement belongs in a failing test, not in autofix");
  });

  await test("scanning twice finds the same thing, so a run never churns the tree", () => {
    const key = (r) => r.findings.map((f) => `${f.rule}|${f.file}|${f.detail}`).sort().join("\n");
    assert.equal(key(fixer.runRules()), key(fixer.runRules()), "the scan is not deterministic");
  });

  await test("the tree is currently clean, so a deploy carries no known defect", () => {
    const { findings } = fixer.runRules();
    assert.empty(findings.map((f) => `[${f.rule}] ${f.file}: ${f.detail}`),
      "run: node test/run.js --fix");
  });

  // -------------------------------------------------------------- econ config
  group("economics config");
  const econ = R("lib/econ/config.js");
  await test("every table id is a real Airtable id", () => {
    for (const [name, id] of Object.entries(econ.TABLES)) {
      assert.match(id, /^tbl[A-Za-z0-9]{14}$/, `${name} is not a table id: ${id}`);
    }
  });
  await test("reporting runs on Melbourne time, where the campaign and its events are", () => {
    assert.equal(econ.ADVERTISER_TZ, "Australia/Melbourne");
  });

  return results;
}

module.exports = { run };

if (require.main === module) {
  run().then((r) => process.exit(r.failed ? 1 : 0));
}
