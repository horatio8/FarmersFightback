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

  await test("the working password is FarmersForever, forgiving of case and spacing", () => {
    // Owner call, 18 Aug 2026 (after a brief same-day retirement): the door
    // key is FarmersForever. It gets read off a text and retyped on a phone,
    // so an autocapitalised F is a support call, not security.
    assert.equal(rec.activePasscode(), "FarmersForever");
    for (const v of ["FarmersForever", "farmersforever", "FARMERSFOREVER",
      "  FarmersForever  ", "Farmers Forever", "fArMeRsFoReVeR"]) {
      assert.ok(rec.passcodeOk(v), `must accept ${JSON.stringify(v)}`);
    }
  });
  await test("wrong guesses are refused, including near misses", () => {
    for (const v of ["", null, undefined, "farmersforeve", "farmersforever1", "letmein",
      "FarmersFightback", "HoldTheGate29"]) {
      assert.ok(!rec.passcodeOk(v), `should refuse ${JSON.stringify(v)}`);
    }
  });
  await test("a configured RECEPTION_PASSCODE overrides the default", () => {
    const saved = process.env.RECEPTION_PASSCODE;
    process.env.RECEPTION_PASSCODE = "PaddockGate2026";
    try {
      assert.ok(rec.passcodeOk("paddock gate 2026"), "the configured value works");
      assert.ok(!rec.passcodeOk("FarmersForever"), "and replaces the default rather than joining it");
    } finally {
      if (saved === undefined) delete process.env.RECEPTION_PASSCODE;
      else process.env.RECEPTION_PASSCODE = saved;
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
    assert.equal(rec.EVENT.name, "Private Reception");
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

  // ------------------------------------------------- capture across reloads
  //
  // The /demand form upserts on session_id, which lives in sessionStorage and
  // survives a reload, and orders writes on a seq the client used to restart
  // at zero on every page load. The result was that a supporter who began the
  // form, came back and finished had every write rejected as a late duplicate
  // — silently, with a 200. These tests pin the sequence that broke.
  group("capture: a supporter who comes back to finish");
  const captureHandler = R("api/capture.js");

  function captureHarness() {
    const rows = new Map();
    let writes = 0;
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
      if (method === "GET") {
        const m = decodeURIComponent(u).match(/\{session_id\}='([^']+)'/);
        const rec = m && rows.get(m[1]);
        return reply({ records: rec ? [{ id: "rec" + m[1].slice(0, 12), fields: rec }] : [] });
      }
      if (method === "POST") {
        const f = JSON.parse(opts.body).records[0].fields;
        writes += 1; rows.set(f.session_id, { ...f });
        return reply({ records: [{ id: "rec" + f.session_id.slice(0, 12), fields: f }] });
      }
      if (method === "PATCH") {
        const f = JSON.parse(opts.body).fields;
        writes += 1;
        const sid = [...rows.keys()].find((k) => u.includes(k.slice(0, 12)));
        rows.set(sid, { ...rows.get(sid), ...f });
        return reply({ id: "x", fields: rows.get(sid) });
      }
      return reply({});
    };
    return {
      rows,
      writes: () => writes,
      restore: () => { global.fetch = realFetch; },
      async post(payload) {
        const r = { code: 0, body: null };
        r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; };
        r.json = (b) => { r.body = b; return r; }; r.end = () => r;
        await captureHandler({
          method: "POST",
          headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` },
          socket: {},
          body: payload,
        }, r);
        return r.body;
      },
    };
  }

  await test("a supporter who fills the form in one sitting is captured", async () => {
    const h = captureHarness();
    try {
      const s = "sess-one-sitting";
      const base = Date.now();
      await h.post({ session_id: s, seq: base + 1, first_name: "Jane" });
      await h.post({ session_id: s, seq: base + 2, first_name: "Jane", last_name: "Farmer" });
      const out = await h.post({ session_id: s, seq: base + 3, first_name: "Jane", last_name: "Farmer", email: "jane@example.com" });
      assert.equal(out.status, "complete");
      assert.equal(h.rows.get(s).email, "jane@example.com");
    } finally { h.restore(); }
  });

  await test("a supporter who reloads and finishes later is still captured", async () => {
    const h = captureHarness();
    try {
      const s = "sess-came-back";
      // First visit: they get as far as a first name, then leave.
      await h.post({ session_id: s, seq: Date.now() + 1, first_name: "Robert" });
      const afterFirst = h.writes();

      // Second visit in the same tab. session_id is unchanged; the counter is
      // reseeded from the clock, so it must still be ahead of what was stored.
      const later = Date.now() + 1000;
      await h.post({ session_id: s, seq: later + 1, first_name: "Robert", last_name: "Grazier" });
      const out = await h.post({ session_id: s, seq: later + 2, first_name: "Robert", last_name: "Grazier", email: "robert@example.com" });

      assert.ok(h.writes() > afterFirst, "the second visit wrote nothing at all");
      assert.notEqual(out.stale, true, "the completed form was rejected as a stale duplicate");
      assert.equal(out.status, "complete", "status never reached complete, so no Contact and no CN sync");
      assert.equal(h.rows.get(s).email, "robert@example.com", "their email address was thrown away");
    } finally { h.restore(); }
  });

  await test("the seq the page sends is seeded from the clock, not from zero", () => {
    // The regression itself: React.useRef(0) resets on every page load while
    // session_id does not, so the counter must not start at a small integer.
    const src = fsx.readFileSync(path.join(ROOT, "app.jsx"), "utf8");
    assert.noMatch(src, /const seqRef = React\.useRef\(0\)/,
      "seqRef seeded at 0 restarts on reload and every write is dropped as stale");
    assert.match(src, /const seqRef = React\.useRef\(Date\.now\(\)\)/,
      "seqRef must be seeded from the clock so it stays ahead across page loads");
  });

  await test("a genuinely out-of-order snapshot is still ignored", async () => {
    // The guard has a real job: two captures in flight at once, the older one
    // landing second. Fixing the reload case must not disarm that.
    const h = captureHarness();
    try {
      const s = "sess-race";
      const base = Date.now();
      await h.post({ session_id: s, seq: base + 10, first_name: "Jane", last_name: "Farmer", email: "jane@example.com" });
      const late = await h.post({ session_id: s, seq: base + 4, first_name: "Ja" });
      assert.equal(late.stale, true, "an older in-flight snapshot must not overwrite newer data");
      assert.equal(h.rows.get(s).first_name, "Jane", "the newer value was clobbered");
    } finally { h.restore(); }
  });

  // ------------------------------------------------ whatsapp invite redirects
  //
  // /wa1 and /wa2 go into auto-replies that thousands of people will read, and
  // the only thing they measure is which invite wording pulls better. A
  // regression here is invisible: the link still works, the numbers just stop
  // being true.
  group("whatsapp invite redirects");
  const wa = R("api/wa-redirect.js");

  function waRes() {
    const r = { code: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  }
  async function tapLink(path, ua) {
    const logged = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      logged.push(JSON.parse(opts.body || "{}"));
      const body = { records: [{ id: "recX", fields: {} }] };
      return {
        ok: true, status: 200, headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };
    try {
      const res = waRes();
      await wa({ method: "GET", url: `/api/wa-redirect?v=${path}`, headers: { "user-agent": ua || "" } }, res);
      const payloads = logged
        .map((b) => (b.records && b.records[0] && b.records[0].fields) || {})
        .map((f) => { try { return JSON.parse(f.payload || "{}"); } catch { return {}; } });
      return { res, payloads };
    } finally { global.fetch = realFetch; }
  }

  const IPHONE_IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Instagram 330.0";

  await test("both paths send the supporter to the WhatsApp channel", async () => {
    for (const p of ["wa1", "wa2"]) {
      const { res } = await tapLink(p, IPHONE_IG);
      assert.equal(res.code, 307, `${p} must answer 307`);
      assert.includes(res.headers.location, "whatsapp.com/channel/", `${p} destination`);
    }
  });

  await test("the redirect is never cached, or repeat clicks stop being counted", async () => {
    const { res } = await tapLink("wa1", IPHONE_IG);
    assert.includes(res.headers["cache-control"], "no-store");
    assert.notEqual(res.code, 301, "a permanent redirect would be cached by in-app webviews");
    assert.notEqual(res.code, 308, "a permanent redirect would be cached by in-app webviews");
  });

  await test("each path records its own variant, so the test can be read", async () => {
    const a = await tapLink("wa1", IPHONE_IG);
    const b = await tapLink("wa2", IPHONE_IG);
    assert.equal(a.payloads[0].variant, "A");
    assert.equal(b.payloads[0].variant, "B");
  });

  await test("link-preview fetchers redirect but are not counted", async () => {
    // Messenger and Instagram fetch the URL to build the preview card on every
    // send. Counting those would measure messages sent, not people clicking.
    for (const bot of ["facebookexternalhit/1.1", "WhatsApp/2.23", "Slackbot-LinkExpanding 1.0"]) {
      const { res, payloads } = await tapLink("wa1", bot);
      assert.equal(res.code, 307, "a preview fetcher must still get the redirect");
      assert.empty(payloads, `${bot} was counted as a click`);
    }
  });

  await test("a real in-app tap IS counted", async () => {
    for (const real of [IPHONE_IG, "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 [FBAN/FB4A;FBAV/450.0]"]) {
      const { payloads } = await tapLink("wa1", real);
      assert.equal(payloads.length, 1, "a genuine supporter tap must be recorded");
    }
  });

  await test("nothing identifying is stored", async () => {
    const { payloads } = await tapLink("wa1", IPHONE_IG);
    const p = payloads[0];
    assert.equal(p.ua, "iOS/instagram", "the full user agent must be reduced to a coarse label");
    assert.excludes(JSON.stringify(p), "AppleWebKit", "the raw UA string leaked into storage");
    assert.excludes(Object.keys(p).join(","), "ip", "no IP may be stored");
  });

  await test("an unknown variant still reaches the channel", async () => {
    const { res } = await tapLink("wa9", IPHONE_IG);
    assert.equal(res.code, 307);
    assert.includes(res.headers.location, "whatsapp.com/channel/");
  });

  await test("a storage failure never blocks the supporter", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error("airtable down"); };
    try {
      const res = waRes();
      await wa({ method: "GET", url: "/api/wa-redirect?v=wa1", headers: { "user-agent": IPHONE_IG } }, res);
      assert.equal(res.code, 307, "a logging failure must not cost a supporter the link");
      assert.includes(res.headers.location, "whatsapp.com/channel/");
    } finally { global.fetch = realFetch; }
  });

  await test("both public paths are wired to the tracked function, not an edge redirect", () => {
    // A vercel.json redirect would resolve before any function ran, giving a
    // working link and zero data — the exact failure this build exists to avoid.
    const rw = (vercel.rewrites || []);
    for (const p of ["/wa1", "/wa2"]) {
      const rule = rw.find((r) => r.source === p);
      assert.ok(rule, `${p} has no rewrite`);
      assert.includes(rule.destination, "/api/wa-redirect", `${p} must pass through the function`);
    }
    const redirects = (vercel.redirects || []).filter((r) => ["/wa1", "/wa2"].includes(r.source));
    assert.empty(redirects.map((r) => r.source), "an edge redirect would bypass tracking");
  });

  // ------------------------------------------- /fun signups mirrored into CN
  //
  // A FUNdraiser signup is written to Airtable and, in parallel, posted into
  // the Campaign Nucleus landing page so it reaches the email list. The whole
  // point is that it is the SECOND destination: a CN problem must never cost
  // a ticket sale.
  group("fundraiser signups: the Campaign Nucleus mirror");
  const cn = R("api/_cn.js");

  function cnHarness(responder) {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body || "{}"), method: opts.method });
      if (responder) return responder();
      const body = { data: { id: "entry-1" } };
      return {
        ok: true, status: 200, headers: { get: () => "application/json" },
        json: async () => body, text: async () => JSON.stringify(body),
      };
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
  }

  await test("a signup is posted to the FUNdraiser form", async () => {
    const h = cnHarness();
    try {
      await cn.cnFunSignup({
        first_name: "Jane", last_name: "Farmer",
        email: "jane@example.com", phone: "0412345678", postcode: "3387",
      });
      assert.equal(h.calls.length, 1, "exactly one entry should be posted");
      assert.includes(h.calls[0].url, `/forms/${cn.CN_FUN_FORM_ID}/entries`);
      assert.equal(h.calls[0].method, "POST");
    } finally { h.restore(); }
  });

  await test("the entry carries the details the form collects", async () => {
    const h = cnHarness();
    try {
      await cn.cnFunSignup({
        first_name: "Jane", last_name: "Farmer",
        email: "jane@example.com", phone: "0412345678", postcode: "3387",
      });
      const b = h.calls[0].body;
      assert.equal(b.email, "jane@example.com");
      assert.equal(b.first_name, "Jane");
      assert.equal(b.last_name, "Farmer");
      assert.equal(b.full_name, "Jane Farmer", "CN lists entries by full name");
      assert.equal(b.phone, "0412345678");
      assert.equal(b.postcode, "3387");
    } finally { h.restore(); }
  });

  await test("signups are attributed, so CN reporting can tell them apart", async () => {
    const h = cnHarness();
    try {
      await cn.cnFunSignup({ email: "a@example.com", route: "ticket" });
      const b = h.calls[0].body;
      assert.equal(b.utm_campaign, "fundraiser");
      assert.equal(b.utm_source, "farmersfightback.com");
      // utm_content, not utm_medium: CN accepts medium and silently drops it,
      // so the paid/comp split would have been blank in their reporting.
      assert.equal(b.utm_content, "ticket");
      assert.equal(b.utm_medium, undefined, "utm_medium is never stored by CN");
    } finally { h.restore(); }
  });

  await test("a Campaign Nucleus failure never throws at the caller", async () => {
    // rally-checkout awaits this mid-sale. If it threw, a CN outage would
    // take the ticket down with it.
    const h = cnHarness(() => { throw new Error("CN is down"); });
    try {
      const out = await cn.cnFunSignup({ email: "a@example.com" });
      assert.equal(out.ok, false, "it should report failure, not raise it");
    } finally { h.restore(); }
  });

  await test("a signup with no email is skipped rather than posted empty", async () => {
    const h = cnHarness();
    try {
      const out = await cn.cnFunSignup({ first_name: "Jane" });
      assert.equal(out.skipped, true);
      assert.empty(h.calls, "nothing should be sent without an address");
    } finally { h.restore(); }
  });

  await test("both /fun signup routes mirror, and neither can fail the sale", () => {
    // Paid tickets and comp claims are both signups on /fun.
    for (const f of ["api/rally-checkout.js", "api/rally-claim.js"]) {
      const src = fsx.readFileSync(path.join(ROOT, f), "utf8");
      assert.includes(src, "cnFunSignup", `${f} does not mirror to CN`);
      assert.match(src, /cnFunSignup\([\s\S]{0,400}?\}\)\.catch\(/,
        `${f} must swallow a CN failure, not let it break the flow`);
    }
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

  // ------------------------------------------------------- the split log base
  //
  // On 18 Aug 2026 the Events table hit Airtable's record ceiling and every
  // petition signup failed for 25 hours, because the signup writes a
  // "Petition Signed" event. The log now lives in a base of its own. Two
  // things make that dangerous and both are pinned here: a linked record
  // cannot point across bases, and a table id is only valid inside the base
  // that owns it. Get either wrong and the writes fail exactly as before.
  group("the events log lives in its own base");

  // Re-require a module tree with different env, so both the split and the
  // rollback can be exercised in one process.
  function withEnv(env, rels) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const rel of rels) delete require.cache[require.resolve(path.join(ROOT, rel))];
    const mods = rels.map((rel) => R(rel));
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      for (const rel of rels) delete require.cache[require.resolve(path.join(ROOT, rel))];
    };
    return { mods, restore };
  }

  // Records every Airtable request so a test can assert which base was hit.
  function airtableSpy() {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const [, , base, table] = u.pathname.split("/"); // /v0/<base>/<table>
      const method = (opts.method || "GET").toUpperCase();
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ base, table: decodeURIComponent(table), method, body, query: u.searchParams });
      // Reads come back empty — these tests are about where a request is
      // addressed, and an empty table makes every caller take its write path.
      const fields = body && body.records ? body.records[0].fields : (body && body.fields) || {};
      const payload = method === "GET"
        ? { records: [] }
        : { records: [{ id: "recSPY000000001", fields }], id: "recSPY000000001", fields };
      return { ok: true, status: 200, json: async () => payload, text: async () => "{}" };
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
  }

  const MAIN = process.env.AIRTABLE_BASE_ID;
  // The chain: main base (pre-split rows), slice 1 (filled 18 Aug 2026),
  // and the live slice that takes every new write.
  const SLICE1 = "appE8OEBzFLzOfdMm";
  const LOG_BASE = "appxb9ykk2eXbuoIB";

  await test("an event is written to the log base, and only there", async () => {
    const spy = airtableSpy();
    try {
      const at = R("api/_airtable.js");
      await at.logEvent({ event_type: "SMS Click", payload: { a: 1 }, fanout: false });
    } finally { spy.restore(); }
    const writes = spy.calls.filter((c) => c.method === "POST");
    assert.equal(writes.length, 1, "one write expected");
    assert.equal(writes[0].base, LOG_BASE, "the event went to the wrong base");
    assert.notEqual(writes[0].base, MAIN, "the main base is the one that ran out of room");
  });

  await test("the contact travels as a plain id, because links cannot cross bases", async () => {
    const spy = airtableSpy();
    try {
      const at = R("api/_airtable.js");
      await at.logEvent({
        contactRecordId: "recCONTACT00001",
        event_type: "SMS Click", payload: {}, fanout: false,
      });
    } finally { spy.restore(); }
    const f = spy.calls.find((c) => c.method === "POST").body.records[0].fields;
    assert.equal(f.contact_id, "recCONTACT00001", "contact_id must carry the id");
    assert.equal(f.contact, undefined, "a linked record here would be rejected by Airtable");
  });

  await test("the typed tables stay in the main base, and drop their link back", async () => {
    const spy = airtableSpy();
    try {
      const at = R("api/_airtable.js");
      await at.logEvent({
        contactRecordId: "recCONTACT00001",
        event_type: "Petition Signed",
        payload: { first_name: "Jo", email: "jo@example.com" },
      });
    } finally { spy.restore(); }
    const projection = spy.calls.find((c) => c.method === "POST" && c.table === "Petition Signatures");
    assert.ok(projection, "the signature projection must still be written");
    assert.equal(projection.base, MAIN, "signatures did not move; only the log did");
    const f = projection.body.records[0].fields;
    assert.deepEqual(f.contact, ["recCONTACT00001"], "the contact link is same-base and must survive");
    assert.equal(f.event, undefined, "a link to the log would now cross bases");
  });

  await test("a full scan of the log reads every slice, so no era of history is dropped", async () => {
    const spy = airtableSpy();
    try {
      const at = R("api/_airtable.js");
      await at.listRows("Events", { formula: "{referral_code_used}!=''" });
    } finally { spy.restore(); }
    const bases = spy.calls.filter((c) => c.method === "GET").map((c) => c.base);
    assert.ok(bases.includes(MAIN), "the referral rollup is all-time; the oldest rows still count");
    assert.ok(bases.includes(SLICE1), "slice 1 holds most of the migrated history");
    assert.ok(bases.includes(LOG_BASE), "live rows must be counted too");
  });

  await test("a scan of any other table still reads one base", async () => {
    const spy = airtableSpy();
    try {
      const at = R("api/_airtable.js");
      await at.listRows("Contacts", {});
    } finally { spy.restore(); }
    const bases = new Set(spy.calls.map((c) => c.base));
    assert.equal(bases.size, 1, "only Events moved");
    assert.ok(bases.has(MAIN), "contacts are in the main base");
  });

  await test("the social pipeline addresses the log by its own id in its own base", async () => {
    const spy = airtableSpy();
    const { mods, restore } = withEnv({}, ["lib/social/config.js", "lib/social/airtable.js", "lib/social/identity.js"]);
    const [cfg, , identity] = mods;
    try {
      await identity.appendEvent("evt-1", "Social Comment", { t: 1 }, { contact: "recCONTACT00001" });
    } finally { restore(); spy.restore(); }
    const write = spy.calls.find((c) => c.method === "POST");
    assert.equal(write.base, cfg.EVENTS_BASE_ID, "wrong base");
    assert.equal(write.table, cfg.EVENTS_TABLE_ID, "a table id is only valid inside its own base");
    assert.notEqual(cfg.EVENTS_TABLE_ID, cfg.TABLES.EVENTS, "the two bases hold different table ids");
    const f = write.body.records[0].fields;
    assert.equal(f.contact_id, "recCONTACT00001", "the contact must travel as an id here too");
    assert.equal(f.contact, undefined, "no cross-base link");
  });

  await test("the social dedup check looks in the old base as well as the new one", async () => {
    const spy = airtableSpy();
    const { mods, restore } = withEnv({}, ["lib/social/config.js", "lib/social/airtable.js", "lib/social/identity.js"]);
    const [cfg, , identity] = mods;
    try {
      await identity.appendEvent("evt-2", "Social Comment", {}, {});
    } finally { restore(); spy.restore(); }
    const reads = spy.calls.filter((c) => c.method === "GET");
    assert.ok(reads.some((c) => c.base === cfg.EVENTS_BASE_ID), "must check the live log");
    for (const h of cfg.EVENTS_HISTORY) {
      assert.ok(reads.some((c) => c.base === h.base && c.table === h.table),
        `an event already logged in retired slice ${h.base} is not new`);
    }
    assert.ok(cfg.EVENTS_HISTORY.length >= 2, "both retired slices must be in the chain");
  });

  await test("pointing the env back at the main base undoes the split without a deploy", async () => {
    const spy = airtableSpy();
    const { mods, restore } = withEnv(
      { AIRTABLE_EVENTS_BASE_ID: MAIN, AIRTABLE_EVENTS_TABLE_ID: "tblhCWL3mckJl6YQ7" },
      ["api/_airtable.js", "lib/social/config.js", "lib/social/airtable.js", "lib/social/identity.js"],
    );
    const [at, cfg, , identity] = mods;
    try {
      await at.logEvent({ contactRecordId: "recCONTACT00001", event_type: "SMS Click", payload: {}, fanout: false });
      await identity.appendEvent("evt-3", "Social Comment", {}, { contact: "recCONTACT00001" });
    } finally { restore(); spy.restore(); }
    assert.equal(cfg.EVENTS_SPLIT, false, "rollback means no split");
    for (const w of spy.calls.filter((c) => c.method === "POST")) {
      assert.equal(w.base, MAIN, "everything is back in one base");
      const f = w.body.records[0].fields;
      assert.deepEqual(f.contact, ["recCONTACT00001"], "same base again, so the link comes back");
      assert.equal(f.contact_id, undefined, "the text stand-in is only for the split");
    }
  });

  await test("paged reads repeat the exact query, because an offset is only valid against it", async () => {
    // Airtable's offset token is bound to the query that issued it. A capped
    // read spanning several pages must therefore send identical parameters
    // with every page — recomputing maxRecords as "what's left" would pair a
    // changed query with a stale offset.
    const realFetch = global.fetch;
    const queries = [];
    global.fetch = async (url) => {
      const u = new URL(String(url));
      queries.push(u.searchParams);
      const first = !u.searchParams.get("offset");
      const n = first ? 100 : 50;
      const body = {
        records: Array.from({ length: n }, (_, i) => ({ id: `rec${first ? "A" : "B"}${i}`, fields: {} })),
        ...(first ? { offset: "itrTOKEN/recCURSOR" } : {}),
      };
      return { ok: true, status: 200, json: async () => body, text: async () => "{}" };
    };
    try {
      const at = R("api/_airtable.js");
      const rows = await at.listRows("Contacts", { maxRecords: 150, formula: "{email}!=''" });
      assert.equal(rows.length, 150, "the cap spans pages");
    } finally { global.fetch = realFetch; }
    assert.equal(queries.length, 2, "two pages expected");
    for (const k of ["maxRecords", "filterByFormula", "pageSize"]) {
      assert.equal(queries[1].get(k), queries[0].get(k), `${k} changed between pages`);
    }
  });

  await test("a Stripe retry finds its event on either side of the split", async () => {
    // Stripe retries a failed webhook delivery for up to three days — long
    // enough to straddle the split. If the dedup lookup saw only the new
    // base, the retry would double-log the donation and fan out a second row.
    const spy = airtableSpy();
    const seen = spy.calls; // addressed below; the spy returns empty reads
    global.fetch = ((inner) => async (url, opts = {}) => {
      const u = new URL(String(url));
      const base = u.pathname.split("/")[2];
      if ((opts.method || "GET").toUpperCase() === "GET" && base === MAIN
          && decodeURIComponent(u.search).includes("meta_event_id")) {
        return { ok: true, status: 200, text: async () => "{}",
          json: async () => ({ records: [{ id: "recOLDEVENT0001", fields: { meta_event_id: "don_1" } }] }) };
      }
      return inner(url, opts);
    })(global.fetch);
    try {
      const at = R("api/_airtable.js");
      const rec = await at.logEventIdempotent({ event_type: "Donation", payload: {}, meta_event_id: "don_1" });
      assert.equal(rec.id, "recOLDEVENT0001", "the pre-split event must be found, not re-logged");
    } finally { spy.restore(); }
    assert.empty(seen.filter((c) => c.method === "POST").map((c) => c.table),
      "a found event means nothing is written");
  });

  await test("a signup survives a log that will not accept writes", async () => {
    // The exact shape of the 25-hour outage: the Contact saves, the event
    // does not. The supporter must still be told they signed, because they
    // did — their details are in Airtable.
    const realFetch = global.fetch;
    let contactWritten = false;
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const table = decodeURIComponent(u.pathname.split("/")[3] || "");
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b, ok = true, status = 200) =>
        ({ ok, status, json: async () => b, text: async () => JSON.stringify(b) });
      if (u.hostname !== "api.airtable.com") return reply({});
      if (table === "Events") {
        return reply({ error: { type: "LIMIT_CHECK_TOO_MANY_RECORDS_IN_TABLE" } }, false, 422);
      }
      if (method === "GET") return reply({ records: [] });
      if (table === "Contacts" && method === "POST") contactWritten = true;
      const fields = opts.body ? (JSON.parse(opts.body).fields || {}) : {};
      return reply({ id: "recNEWCONTACT01", fields, records: [{ id: "recNEWCONTACT01", fields }] });
    };
    const signup = R("api/petition-signup.js");
    const res = { code: 0, body: null };
    res.setHeader = () => {};
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => res;
    try {
      await signup({
        method: "POST",
        headers: {},
        body: { first_name: "Jo", last_name: "Bloggs", email: "jo@example.com" },
      }, res);
    } finally { global.fetch = realFetch; }
    assert.ok(contactWritten, "the contact must be saved before the event is logged");
    assert.equal(res.code, 200, "a failed log entry must not be reported as a failed signup");
    assert.ok(res.body && res.body.success, "the supporter is told they signed, because they did");
  });

  group("moving the old events across");
  const migrate = R("api/admin/migrate-events.js");

  await test("an old row is translated, not copied verbatim", () => {
    const mapped = migrate.mapOldEvent({
      event_id: "e-1",
      contact: ["recCONTACT00001"],
      event_type: "Petition Signed",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: "{}",
      escalation_flags: ["Abuse", "Media"],
      sentiment_score: 0.5,
      fanout_status: "Fanned Out",
    });
    assert.equal(mapped.contact_id, "recCONTACT00001", "the link becomes plain text");
    assert.equal(mapped.contact, undefined, "a linked record cannot cross bases");
    assert.equal(mapped.escalation_flags, "Abuse, Media", "multi-select becomes a joined string");
    assert.equal(mapped.sentiment_score, 0.5, "numbers pass through");
    assert.equal(mapped.fanout_status, "Fanned Out", "fan-out state travels; nothing re-fans-out");
  });

  await test("a row the new base does not confirm holding is never deleted", async () => {
    // The scenario that would lose data: the copy silently fails (or the API
    // key cannot see the new base), and the delete runs anyway. The migrator
    // must gate every delete on an independent read-back of the new base.
    const realFetch = global.fetch;
    const deleted = [];
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const base = u.pathname.split("/")[2];
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => "{}" });
      if (method === "DELETE") { deleted.push(...u.searchParams.getAll("records[]")); return reply({ records: [] }); }
      if (base === "app_test" && method === "GET") {
        return reply({ records: [
          { id: "recOLD01", fields: { event_id: "e-ok", event_type: "SMS Click", timestamp: "2026-08-01T00:00:00.000Z" } },
          { id: "recOLD02", fields: { event_id: "e-lost", event_type: "SMS Click", timestamp: "2026-08-01T00:00:00.000Z" } },
        ] });
      }
      // The new base: accepts every write, but only ever admits to holding
      // e-ok — as if e-lost's copy evaporated.
      if (method === "GET") {
        return reply({ records: [{ id: "recNEW01", fields: { event_id: "e-ok" } }] });
      }
      return reply({ records: (JSON.parse(opts.body).records || []).map((r, i) => ({ id: `recNEW${i}`, fields: r.fields })) });
    };
    const res = { code: 0, body: null };
    res.setHeader = () => {}; res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; }; res.end = () => res;
    try {
      await migrate({ method: "GET", url: `/api/admin/migrate-events?token=${process.env.ADMIN_TOKEN}&write=1`, headers: {} }, res);
    } finally { global.fetch = realFetch; }
    assert.equal(res.code, 200, `migrate failed: ${JSON.stringify(res.body)}`);
    assert.deepEqual(deleted, ["recOLD01"], "only the confirmed row may be deleted");
    assert.equal(res.body.kept_unconfirmed, 1, "the unconfirmed row is kept and reported");
    assert.equal(res.body.done, false, "kept rows mean the job is not done");
  });

  group("outage signup backfill");
  const outage = R("api/admin/backfill-outage-signups.js");

  await test("the reconstructed event is honest about what it is", () => {
    const ev = outage.buildBackfillEvent({
      id: "recABC",
      createdTime: "2026-08-17T22:14:03.000Z",
      fields: {
        contact_id: "uuid-1", first_name: "Jo", last_name: "Bloggs",
        email: "jo@example.com", first_source_channel: "Facebook", fbclid: "fb.1",
      },
    });
    assert.equal(ev.event_type, "Petition Signed");
    assert.equal(ev.timestamp, "2026-08-17T22:14:03.000Z",
      "backdated to when they actually signed, so daily rollups stay truthful");
    assert.equal(ev.meta_event_id, "outage_backfill_uuid-1",
      "a deterministic key is what makes re-runs safe");
    assert.equal(ev.payload.source, "outage-backfill", "never disguised as a live signup");
    assert.equal(ev.source_channel, "Facebook");
    assert.equal(ev.payload.email, "jo@example.com",
      "identity travels in the payload so the signature projection is complete");
  });

  group("petition thanks split");
  await test("the env var is the whole dial: 0/unset = donate, 100 = share, clamped in between", () => {
    const signup = R("api/petition-signup.js");
    const saved = process.env.PETITION_SHARE_PERCENT;
    try {
      delete process.env.PETITION_SHARE_PERCENT;
      assert.equal(signup.rollThanksDestination(0.0), "/donate", "unset means everyone gets the ask");
      process.env.PETITION_SHARE_PERCENT = "100";
      assert.equal(signup.rollThanksDestination(0.999), "/share", "100 sends everyone to share");
      process.env.PETITION_SHARE_PERCENT = "30";
      assert.equal(signup.rollThanksDestination(0.299), "/share", "roll below the cut goes to share");
      assert.equal(signup.rollThanksDestination(0.301), "/donate", "roll above the cut goes to donate");
      process.env.PETITION_SHARE_PERCENT = "banana";
      assert.equal(signup.rollThanksDestination(0.0), "/donate", "garbage reads as 0, never as open floodgates");
      process.env.PETITION_SHARE_PERCENT = "250";
      assert.equal(signup.rollThanksDestination(0.999), "/share", "values over 100 clamp to 100");
      process.env.PETITION_SHARE_PERCENT = "-5";
      assert.equal(signup.rollThanksDestination(0.0), "/donate", "negatives clamp to 0");
    } finally {
      if (saved === undefined) delete process.env.PETITION_SHARE_PERCENT;
      else process.env.PETITION_SHARE_PERCENT = saved;
    }
  });

  await test("the verdict reaches the browser and the event log", async () => {
    // The client redirects wherever thanks_destination says, and the event
    // payload records the arm so donations per arm can be measured later.
    const saved = process.env.PETITION_SHARE_PERCENT;
    process.env.PETITION_SHARE_PERCENT = "100";
    const realFetch = global.fetch;
    let eventPayload = null;
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const table = decodeURIComponent(u.pathname.split("/")[3] || "");
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
      if (u.hostname !== "api.airtable.com") return reply({});
      if (table === "Events" && method === "POST") {
        const f = JSON.parse(opts.body).records[0].fields;
        if (f.event_type === "Petition Signed") eventPayload = JSON.parse(f.payload);
        return reply({ records: [{ id: "recEVT0000000001", fields: f }] });
      }
      if (method === "GET") return reply({ records: [] });
      const fields = opts.body ? (JSON.parse(opts.body).fields || {}) : {};
      return reply({ id: "recNEWCONTACT01", fields, records: [{ id: "recNEWCONTACT01", fields }] });
    };
    const signup = R("api/petition-signup.js");
    const res = { code: 0, body: null };
    res.setHeader = () => {}; res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; }; res.end = () => res;
    try {
      await signup({
        method: "POST", headers: {},
        body: { first_name: "Zz", last_name: "SplitRoll", email: "zz.split.roll@example.org" },
      }, res);
    } finally {
      global.fetch = realFetch;
      if (saved === undefined) delete process.env.PETITION_SHARE_PERCENT;
      else process.env.PETITION_SHARE_PERCENT = saved;
    }
    assert.equal(res.code, 200, `signup failed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.thanks_destination, "/share", "the browser is told where to go");
    assert.ok(eventPayload, "a Petition Signed event must be logged");
    assert.equal(eventPayload.thanks_destination, "/share", "the arm is recorded for later measurement");
  });

  await test("flows outside the signup API get their verdict from /api/thanks-destination", async () => {
    const saved = process.env.PETITION_SHARE_PERCENT;
    process.env.PETITION_SHARE_PERCENT = "100";
    const handler = R("api/thanks-destination.js");
    const res = { code: 0, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    try {
      handler({ method: "GET" }, res);
    } finally {
      if (saved === undefined) delete process.env.PETITION_SHARE_PERCENT;
      else process.env.PETITION_SHARE_PERCENT = saved;
    }
    assert.equal(res.code, 200);
    assert.equal(res.body.destination, "/share", "honours the same dial as the signup path");
    assert.equal(res.headers["Cache-Control"], "no-store",
      "a cached verdict would glue an edge's visitors to one arm");
  });

  group("signup SMS is switched off");
  await test("a signup never queues or sends a text", async () => {
    // Owner decision, 28 Aug 2026. The switch is code-side: no env change can
    // silently re-enable it (SIGNUP_SMS_ENABLED=1 must be set deliberately).
    const realFetch = global.fetch;
    let fetched = 0;
    global.fetch = async () => { fetched += 1; throw new Error("nothing should be called"); };
    try {
      const cc = R("api/_cellcast.js");
      const out = await cc.enqueueSignupSMS({
        contactFields: { referral_code: "ABC123" },
        mobile: "0400111222", first_name: "Jo",
      });
      assert.equal(out.skipped, "signup sms switched off");
      assert.equal(fetched, 0, "no Cellcast call, no Airtable queue row — nothing at all");
    } finally { global.fetch = realFetch; }
  });

  group("ticket sales close");
  const rally = R("api/_rally.js");
  const BEFORE_CUTOFF = Date.parse("2026-08-25T00:00:00Z");
  const AFTER_CUTOFF = Date.parse("2026-08-26T14:00:00.001Z");

  function ticketsStub(rows) {
    const realFetch = global.fetch;
    let called = 0;
    global.fetch = async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => "{}",
        json: async () => ({ records: rows.map((q, i) => ({ id: `rec${i}`, fields: { total_qty: q } })) }) };
    };
    return { calls: () => called, restore: () => { global.fetch = realFetch; } };
  }

  await test("sales stay open under the cap before the cutoff", async () => {
    const stub = ticketsStub([600, 400, 43]); // 1,043 — one seat left
    try {
      const st = await rally.ticketSalesState(BEFORE_CUTOFF);
      assert.equal(st.closed, false, "1,043 sold is still open");
      assert.equal(st.sold, 1043);
    } finally { stub.restore(); }
  });

  await test("the 1,044th ticket closes sales", async () => {
    const stub = ticketsStub([600, 400, 44]);
    try {
      const st = await rally.ticketSalesState(BEFORE_CUTOFF);
      assert.equal(st.closed, true, "at the cap means closed");
      assert.equal(st.reason, "sold_out");
      assert.match(st.message, /sorry/i, "the refusal carries the apology");
    } finally { stub.restore(); }
  });

  await test("midnight ending Wed 26 Aug (Melbourne) closes sales regardless of count", async () => {
    const stub = ticketsStub([1]);
    try {
      const st = await rally.ticketSalesState(AFTER_CUTOFF);
      assert.equal(st.closed, true);
      assert.equal(st.reason, "time");
      assert.equal(stub.calls(), 0, "the time check must not depend on Airtable being up");
    } finally { stub.restore(); }
  });

  await test("a down database fails open before the cutoff, never closed", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error("airtable down"); };
    try {
      const st = await rally.ticketSalesState(BEFORE_CUTOFF);
      assert.equal(st.closed, false, "an outage must not stop the last days of sales");
    } finally { global.fetch = realFetch; }
  });

  group("reconciliation tallies");
  const reconcile = R("api/admin/reconcile.js");

  await test("tallies handle both select shapes and blanks", () => {
    const rows = [
      { fields: { status: "Petition Signed" } },
      { fields: { status: { name: "Petition Signed" } } },
      { fields: { status: "Donor" } },
      { fields: {} },
    ];
    assert.deepEqual(reconcile.tally(rows, "status"),
      { "Petition Signed": 2, Donor: 1, "(blank)": 1 },
      "string and {name} selects must count as the same value");
  });

  await test("duplicate keys are surfaced, single and blank ones are not", () => {
    const rows = [
      { fields: { stripe_object_id: "pi_1" } },
      { fields: { stripe_object_id: "pi_1" } },
      { fields: { stripe_object_id: "pi_2" } },
      { fields: {} },
      { fields: {} },
    ];
    assert.deepEqual(reconcile.dupes(rows, "stripe_object_id"),
      [{ value: "pi_1", rows: 2 }],
      "two blank rows are not a duplicate payment");
  });

  // ------------------------------------------- fundraising account cutover
  group("fundraising account cutover");
  const cutover = R("api/_stripe-fundraising.js");
  const BEFORE_CUTOVER = new Date("2026-08-31T13:59:59Z");
  const AFTER_CUTOVER = new Date("2026-08-31T14:00:00Z");

  function withStripeEnv(vals, fn) {
    const keys = [
      "STRIPE_SECRET_KEY", "STRIPE_FUNDRAISING_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET", "STRIPE_FUNDRAISING_WEBHOOK_SECRET",
      "STRIPE_RALLY_SECRET_KEY", "STRIPE_RALLY_WEBHOOK_SECRET",
    ];
    const saved = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      if (vals[k] === undefined) delete process.env[k]; else process.env[k] = vals[k];
    }
    const restore = () => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    };
    const out = fn();
    if (out && typeof out.finally === "function") return out.finally(restore);
    restore();
    return out;
  }

  await test("midnight 1 Sep (Melbourne) flips new sessions to the Wallaloo & Gre Gre key", () => {
    assert.equal(cutover.CUTOVER_UTC, "2026-08-31T14:00:00.000Z",
      "AEST midnight is 14:00 UTC the day before");
    // The W&G account is already wired in as the rally key — no new
    // credential needed for the flip.
    withStripeEnv({ STRIPE_SECRET_KEY: "sk_old", STRIPE_RALLY_SECRET_KEY: "sk_rally" }, () => {
      assert.equal(cutover.fundraisingCutoverActive(BEFORE_CUTOVER), false);
      assert.equal(cutover.fundraisingCutoverActive(AFTER_CUTOVER), true);
      assert.equal(cutover.fundraisingKey(BEFORE_CUTOVER), "sk_old", "before midnight: legacy account");
      assert.equal(cutover.fundraisingKey(AFTER_CUTOVER), "sk_rally", "after midnight: the rally key IS the W&G account");
    });
    withStripeEnv({
      STRIPE_SECRET_KEY: "sk_old", STRIPE_RALLY_SECRET_KEY: "sk_rally",
      STRIPE_FUNDRAISING_SECRET_KEY: "sk_new",
    }, () => {
      assert.equal(cutover.fundraisingKey(AFTER_CUTOVER), "sk_new",
        "an explicit fundraising key overrides the rally key");
    });
  });

  await test("a missing new key after the cutover fails OPEN onto the legacy account", () => {
    // A misconfigured switch must never stop donations — worst case the
    // money lands where it always has, and the logs shout about it.
    withStripeEnv({ STRIPE_SECRET_KEY: "sk_old" }, () => {
      assert.equal(cutover.fundraisingKey(AFTER_CUTOVER), "sk_old");
    });
  });

  await test("session readbacks try both accounts, most-likely creator first", () => {
    withStripeEnv({ STRIPE_SECRET_KEY: "sk_old", STRIPE_RALLY_SECRET_KEY: "sk_rally" }, () => {
      assert.deepEqual(cutover.fundraisingReadKeys(BEFORE_CUTOVER), ["sk_old", "sk_rally"]);
      assert.deepEqual(cutover.fundraisingReadKeys(AFTER_CUTOVER), ["sk_rally", "sk_old"]);
    });
    withStripeEnv({ STRIPE_SECRET_KEY: "sk_old" }, () => {
      assert.deepEqual(cutover.fundraisingReadKeys(AFTER_CUTOVER), ["sk_old"],
        "an unset W&G key never puts undefined in the try-list");
    });
  });

  const whSigned = (raw, secret) => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = require("crypto").createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    return `t=${t},v1=${v1}`;
  };
  const whReq = (raw, sig) => {
    const h = {};
    return {
      method: "POST",
      headers: { "stripe-signature": sig },
      on(ev, fn) {
        h[ev] = fn;
        if (ev === "end") setImmediate(() => { h.data(Buffer.from(raw)); h.end(); });
      },
    };
  };
  const whRes = () => {
    const r = { code: 0, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = b; return r; };
    return r;
  };

  await test("the webhook accepts events signed by either account", async () => {
    // Existing monthly donors rebill on the legacy account forever, so its
    // signing secret must keep verifying alongside the new account's.
    // An event type the handler ignores: verification runs, nothing else does.
    const raw = JSON.stringify({ type: "charge.updated", data: { object: {} } });
    await withStripeEnv({
      STRIPE_SECRET_KEY: "sk_old", STRIPE_FUNDRAISING_SECRET_KEY: "sk_new",
      STRIPE_WEBHOOK_SECRET: "whsec_old", STRIPE_FUNDRAISING_WEBHOOK_SECRET: "whsec_new",
    }, async () => {
      const webhook = R("api/stripe-webhook.js");
      for (const secret of ["whsec_old", "whsec_new"]) {
        const res = whRes();
        // eslint-disable-next-line no-await-in-loop
        await webhook(whReq(raw, whSigned(raw, secret)), res);
        assert.equal(res.code, 200, `${secret} must verify`);
        assert.equal(res.body.ignored, "charge.updated");
      }
      const res = whRes();
      await webhook(whReq(raw, whSigned(raw, "whsec_wrong")), res);
      assert.equal(res.code, 400, "an unknown signer is still rejected");
    });
  });

  await test("the W&G webhook books tickets as tickets and donations as donations", async () => {
    // After the cutover one account carries BOTH revenue streams, delivered
    // to the same endpoint. A ticket recorded as a donation (or vice versa)
    // corrupts two ledgers at once, so routing is by what the session IS:
    // rally-checkout stamps ff_content_type=rally_ticket, donations don't.
    const savedMeta = {};
    for (const [k, v] of Object.entries({ META_PIXEL_ID: "px_test", META_CAPI_TOKEN: "tok_meta" })) {
      savedMeta[k] = process.env[k]; process.env[k] = v;
    }
    const realFetch = global.fetch;
    const eventTypesLogged = [];
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
      if (u.hostname !== "api.airtable.com") return reply({ events_received: 1 });
      if (method === "GET") return reply({ records: [] });
      const body = JSON.parse(opts.body || "{}");
      const fields = body.fields || (body.records && body.records[0] && body.records[0].fields) || {};
      if (fields.event_type) eventTypesLogged.push(fields.event_type);
      return reply({ id: "recX", fields, records: [{ id: "recX", fields }] });
    };
    try {
      await withStripeEnv({
        STRIPE_SECRET_KEY: "sk_old", STRIPE_WEBHOOK_SECRET: "whsec_old",
        STRIPE_RALLY_SECRET_KEY: "sk_rally", STRIPE_RALLY_WEBHOOK_SECRET: "whsec_rally",
      }, async () => {
        // Fresh modules so _meta and the webhook consts see this env.
        for (const m of ["api/_meta.js", "api/stripe-webhook.js", "api/rally-webhook.js"]) {
          delete require.cache[path.join(ROOT, m)];
        }
        const rallyHook = R("api/rally-webhook.js");
        const send = async (event) => {
          const raw = JSON.stringify(event);
          const res = whRes();
          await rallyHook(whReq(raw, whSigned(raw, "whsec_rally")), res);
          return res;
        };

        const ticket = await send({
          type: "checkout.session.completed",
          data: { object: {
            id: "cs_tix1", mode: "payment", payment_status: "paid",
            amount_total: 5500, currency: "aud",
            metadata: { ff_content_type: "rally_ticket", adult_qty: "2" },
            customer_details: { email: "tick@example.org", name: "Tick Buyer" },
          } },
        });
        assert.equal(ticket.code, 200, `ticket event failed: ${JSON.stringify(ticket.body)}`);
        assert.equal(ticket.body.type, "rally_ticket", "a stamped ticket takes the ticket path");

        const donation = await send({
          type: "checkout.session.completed",
          data: { object: {
            id: "cs_don1", mode: "payment", payment_status: "paid",
            amount_total: 6500, currency: "aud",
            metadata: { org: "ff", content_name: "One-off Donation" },
            customer_details: { email: "give@example.org", name: "Gen Donor" },
          } },
        });
        assert.equal(donation.code, 200, `donation event failed: ${JSON.stringify(donation.body)}`);
        assert.equal(donation.body.type, "donation", "an unstamped session takes the donation path");
        assert.equal(donation.body.fired, "Purchase");

        const rebill = await send({ type: "invoice.paid", data: { object: { id: "in_1", status: "open" } } });
        assert.equal(rebill.body.type, "donation", "invoice.paid on this account is donation traffic");

        assert.includes(eventTypesLogged.join(","), "Rally Ticket Purchased", "the ticket must reach the ticket ledger");
        assert.includes(eventTypesLogged.join(","), "Donation", "the donation must reach the donation ledger");
      });
    } finally {
      global.fetch = realFetch;
      for (const [k, v] of Object.entries(savedMeta)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  await test("the legacy account's webhook books donations exactly as before", async () => {
    // The original functionality: one-off donations and monthly rebills on
    // the legacy account keep landing as Donation events with the same
    // labels. Existing monthly donors live here forever.
    const savedMeta = {};
    for (const [k, v] of Object.entries({ META_PIXEL_ID: "px_test", META_CAPI_TOKEN: "tok_meta" })) {
      savedMeta[k] = process.env[k]; process.env[k] = v;
    }
    const realFetch = global.fetch;
    const donationPayloads = [];
    global.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      const method = (opts.method || "GET").toUpperCase();
      const reply = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
      if (u.hostname !== "api.airtable.com") return reply({ events_received: 1, metadata: {} });
      if (method === "GET") return reply({ records: [] });
      const body = JSON.parse(opts.body || "{}");
      const fields = body.fields || (body.records && body.records[0] && body.records[0].fields) || {};
      if (fields.event_type === "Donation") donationPayloads.push(JSON.parse(fields.payload));
      return reply({ id: "recX", fields, records: [{ id: "recX", fields }] });
    };
    try {
      await withStripeEnv({
        STRIPE_SECRET_KEY: "sk_old", STRIPE_WEBHOOK_SECRET: "whsec_old",
        STRIPE_RALLY_SECRET_KEY: "sk_rally", STRIPE_RALLY_WEBHOOK_SECRET: "whsec_rally",
      }, async () => {
        for (const m of ["api/_meta.js", "api/stripe-webhook.js"]) {
          delete require.cache[path.join(ROOT, m)];
        }
        const webhook = R("api/stripe-webhook.js");
        const send = async (event) => {
          const raw = JSON.stringify(event);
          const res = whRes();
          await webhook(whReq(raw, whSigned(raw, "whsec_old")), res);
          return res;
        };

        const oneoff = await send({
          type: "checkout.session.completed",
          data: { object: {
            id: "cs_legacy1", mode: "payment", payment_status: "paid",
            amount_total: 3500, currency: "aud",
            metadata: { org: "ff", content_name: "One-off Donation" },
            customer_details: { email: "old.donor@example.org", name: "Old Donor" },
          } },
        });
        assert.equal(oneoff.code, 200, `one-off failed: ${JSON.stringify(oneoff.body)}`);
        assert.equal(oneoff.body.fired, "Purchase");

        const rebill = await send({
          type: "invoice.paid",
          data: { object: {
            id: "in_legacy1", status: "paid",
            amount_paid: 2500, currency: "aud",
            customer_email: "monthly.donor@example.org", customer_name: "Monthly Donor",
          } },
        });
        assert.equal(rebill.code, 200, `rebill failed: ${JSON.stringify(rebill.body)}`);
        assert.equal(rebill.body.fired, "Purchase");
      });
    } finally {
      global.fetch = realFetch;
      for (const [k, v] of Object.entries(savedMeta)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    assert.equal(donationPayloads.length, 2, "both charges must reach the Donation ledger");
    assert.equal(donationPayloads[0].content_name, "One-off Donation");
    assert.equal(donationPayloads[1].content_name, "Monthly Donation");
  });

  await test("the thank-you readback finds a session whichever account created it", async () => {
    // A donor who pays at 23:58 lands back on /donate at 00:01 — the
    // session lives on the account that made it, so the readback tries
    // both instead of erroring the thank-you page.
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const auth = (opts.headers && opts.headers.Authorization) || "";
      if (auth.includes("sk_old")) {
        return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ amount_total: 6500, currency: "aud", mode: "payment", payment_status: "paid", customer_details: { email: "x@y.z" } }),
        text: async () => "{}",
      };
    };
    try {
      await withStripeEnv({ STRIPE_SECRET_KEY: "sk_old", STRIPE_RALLY_SECRET_KEY: "sk_rally" }, async () => {
        const checkout = R("api/checkout.js");
        const res = { code: 0, body: null };
        res.setHeader = () => {}; res.status = (c) => { res.code = c; return res; };
        res.json = (b) => { res.body = b; return res; }; res.end = () => res;
        await checkout({ method: "GET", url: "/api/checkout?session_id=cs_wg_123", headers: {} }, res);
        assert.equal(res.code, 200, `readback failed: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.session.paid, true, "the W&G-held session must still be found");
        assert.equal(res.body.session.amount_total, 6500);
      });
    } finally { global.fetch = realFetch; }
  });

  await test("no page links a hardcoded Stripe Payment Link any more", () => {
    // Payment Links belong permanently to the legacy account — a surviving
    // one would keep taking money there after the cutover. site.json's
    // copies are exempt: they are error-path fallbacks only, used when
    // /api/checkout is down (better the old account than a lost gift).
    for (const rel of ["app.jsx", "fundraiser/funnel.jsx"]) {
      const src = require("fs").readFileSync(path.join(ROOT, rel), "utf8");
      assert.noMatch(src, /buy\.stripe\.com|donate\.stripe\.com/,
        `${rel} still points at a legacy Payment Link`);
    }
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
