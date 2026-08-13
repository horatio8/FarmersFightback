// Regression: load every page in a real browser and assert it actually works.
//
// This is the "impression" pass — it renders each page the way a visitor gets
// it and records a fingerprint of what came out, so a change that quietly
// empties a page, breaks a script, or drops a call to action fails the build
// rather than being discovered by a supporter.
//
// Costs nothing to run: the pages are served from the working tree, our own
// API is answered from fixtures, and every third-party request is fulfilled
// locally. No production traffic, no Airtable or CN quota, no API tokens.

const fs = require("fs");
const path = require("path");
const { createRun, assert } = require("./lib/tap");
const site = require("./lib/site");

const BASELINE = path.join(__dirname, "baselines", "pages.json");

// A layout this far off the viewport is broken whatever font is in use.
const ABSURD_OVERFLOW = 140;
// Sub-pixel rounding and scrollbar differences between runs.
const OVERFLOW_TOLERANCE = 4;

// Third-party hosts the pages are allowed to talk to. Anything else appearing
// is a new tracker or dependency that nobody reviewed.
const ALLOWED_THIRD_PARTY = [
  /^https?:\/\/([a-z0-9-]+\.)*unpkg\.com\//,
  /^https?:\/\/([a-z0-9-]+\.)*clarity\.ms\//,
  /^https?:\/\/([a-z0-9-]+\.)*facebook\.(com|net)\//,
  /^https?:\/\/([a-z0-9-]+\.)*google(apis|tagmanager)?\.com\//,
  /^https?:\/\/fonts\.gstatic\.com\//,
  /^https?:\/\/([a-z0-9-]+\.)*youtube(-nocookie)?\.com\//,
  /^https?:\/\/([a-z0-9-]+\.)*ytimg\.com\//,
  /^https?:\/\/([a-z0-9-]+\.)*stripe\.com\//,
  /^https?:\/\/([a-z0-9-]+\.)*doubleclick\.net\//,
  /^https?:\/\/([a-z0-9-]+\.)*vercel(-insights)?\.(com|app)\//,
];

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch { return {}; }
}
function saveBaseline(b) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n");
}

// Wait for the page to stop moving before measuring anything.
//
// These pages compile their JSX in the browser, so a page mounts in stages: on
// /demandcarroll the DOM briefly holds 385 of its eventual 1452 words, for
// about two hundred milliseconds, roughly two and a half seconds in. Sampling
// the page on a timer lands inside that window often enough to fail a build for
// no reason, and polling for "the same reading twice" only narrows the odds —
// it does not close them, because the partial state can outlast the interval.
//
// So this does not sample. It watches for mutations and waits for the DOM to go
// quiet: once nothing has changed for QUIET_MS, the page has finished. That is
// an actual signal rather than a guess about how slow the machine is.
const QUIET_MS = 700;
const SETTLE_TIMEOUT_MS = 25000;

async function settle(page) {
  await page.waitForFunction(() => {
    const root = document.getElementById("root");
    return !root || root.children.length > 0;
  }, { timeout: 20000 }).catch(() => {});

  // Returning the FontFaceSet itself is not serialisable, so await it inside
  // the page and hand back a plain value.
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    return true;
  }).catch(() => {});

  await page.evaluate(({ quiet, cap }) => new Promise((resolve) => {
    let timer = null;
    const done = () => { try { obs.disconnect(); } catch {} clearTimeout(hard); resolve(true); };
    const bump = () => { clearTimeout(timer); timer = setTimeout(done, quiet); };
    const obs = new MutationObserver(bump);
    obs.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
    // A page that never stops animating must not hang the run.
    const hard = setTimeout(done, cap);
    bump();
  }), { quiet: QUIET_MS, cap: SETTLE_TIMEOUT_MS }).catch(() => {});
}

// What a rendered page is reduced to. Deliberately structural rather than
// pixel-based: a screenshot diff fails on a font hinting change, while this
// fails only when the page's substance moves.
async function impression(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const headings = [...document.querySelectorAll("h1,h2")].filter(vis)
      .map((h) => h.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    const ctas = [...document.querySelectorAll("a,button")].filter(vis)
      .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0 && t.length < 60);
    const imgs = [...document.querySelectorAll("img")];
    return {
      title: document.title,
      words: text.split(" ").filter(Boolean).length,
      headings: headings.slice(0, 12),
      ctaCount: ctas.length,
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input,textarea,select").length,
      images: imgs.length,
      // An image with no alt ATTRIBUTE is unlabelled. alt="" is different: it
      // is the correct way to mark a decorative image, and the hero photos use
      // it deliberately, so it must not be counted as a defect.
      imagesUnlabelled: imgs.filter((i) => i.getAttribute("alt") === null).length,
      h1: document.querySelectorAll("h1").length,
      links: document.querySelectorAll("a[href]").length,
      // Cheap layout fingerprint: how tall, and does anything spill sideways.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function run({ update = false } = {}) {
  const { group, test, skip, results } = createRun("regression");

  // On a developer's machine, no browser means "you have not installed it
  // yet" and skipping is the right answer. In CI it means the run tested
  // nothing, and a green build that tested nothing is worse than a red one.
  const required = Boolean(process.env.CI);
  const unavailable = async (why) => {
    if (!required) { skip("browser regression", why); return results; }
    group("browser regression");
    await test("chromium is available to run the pages", () => {
      throw new Error(`${why} — CI must not pass without rendering the site`);
    });
    return results;
  };

  const chromium = (() => {
    try { return site.requireDep("playwright-core").chromium; } catch { return null; }
  })();
  if (!chromium) return unavailable("playwright-core not installed — run npm install inside test/");

  // Use a binary we can see; otherwise let playwright-core resolve the one it
  // installed itself, which is what happens in CI.
  const exe = site.chromiumPath();
  let browser;
  try {
    browser = await chromium.launch({
      ...(exe ? { executablePath: exe } : {}),
      args: ["--no-sandbox"],
    });
  } catch (e) {
    return unavailable(`could not start chromium (${e.message.split("\n")[0]})`);
  }

  const pages = site.listPages();
  const server = site.createServer();
  const port = await site.listen(server);
  const base = `http://127.0.0.1:${port}`;
  const baseline = loadBaseline();
  const nextBaseline = {};

  try {
    for (const p of pages) {
      group(`${p.url}  ${p.gated ? "(gated)" : ""}`);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const tab = await ctx.newPage();
      const jsErrors = [];
      const consoleErrors = [];
      const badResponses = [];
      const thirdParty = [];

      tab.on("pageerror", (e) => jsErrors.push(String(e)));
      tab.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        if (/Failed to load resource/i.test(t)) return; // covered by badResponses
        consoleErrors.push(t);
      });
      tab.on("response", (r) => {
        if (r.status() < 400 || !r.url().startsWith(base)) return;
        // A gated page's context call answering 401/403 without a token is the
        // gate doing its job. Anything else — a 404, a 500 — is a real break.
        if (p.gated && (r.status() === 401 || r.status() === 403)) return;
        badResponses.push(`${r.status()} ${r.url().slice(base.length)}`);
      });
      await site.routeOffline(tab, base, thirdParty);

      await tab.goto(base + p.url, { waitUntil: "load", timeout: 30000 });
      await settle(tab);

      const shot = await impression(tab);
      nextBaseline[p.url] = shot;
      const before = baseline[p.url];

      await test("no uncaught JavaScript errors", () => assert.empty(jsErrors, "page threw"));
      await test("nothing logged to console.error", () => assert.empty(consoleErrors, "console errors"));
      await test("every first-party request resolved", () => assert.empty(badResponses, "broken requests"));

      await test("talks only to reviewed third parties", () => {
        const unknown = [...new Set(thirdParty)]
          .filter((u) => !ALLOWED_THIRD_PARTY.some((re) => re.test(u)));
        assert.empty(unknown, "unreviewed third-party request");
      });

      await test("has a title", () => {
        assert.ok(shot.title && shot.title.length > 4, `weak title: ${JSON.stringify(shot.title)}`);
      });

      if (p.content && !p.gated) {
        await test("rendered real content, not an empty shell", () => {
          assert.ok(shot.words >= 40, `only ${shot.words} words rendered`);
          assert.ok(shot.headings.length >= 1, "no visible heading");
        });
        await test("offers something to do", () => {
          assert.ok(shot.ctaCount >= 1, "no visible link or button");
        });
        await test("has exactly one top-level heading", () => {
          // Two h1s means a screen reader announces two page titles, and
          // search engines pick whichever they like.
          assert.equal(shot.h1, 1, `found ${shot.h1} <h1> elements`);
        });
      }

      await test("every image is labelled for a screen reader", () => {
        // alt="" is allowed and correct for decoration; a missing attribute is
        // read out as the file name.
        assert.equal(shot.imagesUnlabelled, 0,
          `${shot.imagesUnlabelled} of ${shot.images} images have no alt attribute at all`);
      });

      if (p.gated) {
        await test("stays shut without credentials", () => {
          assert.ok(shot.inputs <= 3, `a gated page exposed ${shot.inputs} inputs before any credential`);
        });
      }

      // Overflow is measured, not absolutely bounded.
      //
      // This harness cannot load Google Fonts, so every page renders in a
      // fallback face that is wider than the real one — enough to push the nav
      // past the viewport by itself. Asserting "zero overflow" would therefore
      // fail on a font substitution the public never sees. What IS meaningful
      // is change: the same fallback every run means a jump above the recorded
      // figure is a real layout regression. A grossly broken layout still trips
      // the absolute ceiling.
      await test("desktop layout no wider than it was", () => {
        const was = before ? before.overflow : null;
        assert.ok(shot.overflow <= ABSURD_OVERFLOW,
          `${shot.overflow}px of horizontal overflow is broken regardless of fonts`);
        if (was !== null) {
          assert.ok(shot.overflow <= was + OVERFLOW_TOLERANCE,
            `horizontal overflow grew from ${was}px to ${shot.overflow}px`);
        }
      });

      // Mobile is most of this audience.
      const mob = await ctx.newPage();
      await site.routeOffline(mob, base, []);
      await mob.setViewportSize({ width: 360, height: 740 });
      await mob.goto(base + p.url, { waitUntil: "load", timeout: 30000 });
      await settle(mob);
      const over = await mob.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      nextBaseline[p.url].mobileOverflow = over;
      await test("phone layout no wider than it was", () => {
        const was = before && typeof before.mobileOverflow === "number" ? before.mobileOverflow : null;
        assert.ok(over <= ABSURD_OVERFLOW,
          `${over}px of overflow at 360px wide is broken regardless of fonts`);
        if (was !== null) {
          assert.ok(over <= was + OVERFLOW_TOLERANCE,
            `overflow at 360px grew from ${was}px to ${over}px`);
        }
      });
      await mob.close();

      if (before && !update) {
        await test("still renders as much as it used to", () => {
          // A page losing a third of its copy is the shape of an accident.
          const drop = before.words > 0 ? (before.words - shot.words) / before.words : 0;
          assert.ok(drop <= 0.34,
            `content dropped ${(drop * 100).toFixed(0)}% (was ${before.words} words, now ${shot.words})`);
        });
        await test("kept its calls to action", () => {
          assert.ok(shot.ctaCount >= Math.floor(before.ctaCount * 0.6),
            `calls to action fell from ${before.ctaCount} to ${shot.ctaCount}`);
        });
        await test("kept its form fields", () => {
          assert.ok(shot.inputs >= before.inputs,
            `form inputs fell from ${before.inputs} to ${shot.inputs}`);
        });
      } else if (!before) {
        skip("compared against the recorded impression", "first run, baseline being recorded");
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Only bank a new baseline when the run is clean, or when explicitly asked.
  // Recording a broken page as "normal" is how a suite stops finding anything.
  if (update || results.failed === 0) saveBaseline({ ...baseline, ...nextBaseline });

  return results;
}

module.exports = { run, loadBaseline, saveBaseline, BASELINE };

if (require.main === module) {
  run({ update: process.argv.includes("--update") }).then((r) => process.exit(r.failed ? 1 : 0));
}
