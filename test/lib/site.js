// Everything the suite needs to know about the site, and a server to run it.
//
// Deliberately offline. The regression pass drives real Chromium over the real
// pages, but it serves them from the working tree and answers every
// third-party request itself, so a full run costs no production traffic, no
// Airtable or Campaign Nucleus quota, and no API tokens of any kind. That is
// what makes it cheap enough to run on every commit.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");

// --- dependency resolution -------------------------------------------------
//
// Playwright and the React/Babel UMD bundles are dev-only. Look in the repo
// first, then anywhere the runner was told to look, so the suite works both in
// CI (npm install) and on a machine where they already live elsewhere.
function depDirs() {
  // test/node_modules first: the manifest lives in test/, because the site
  // itself has no dependencies and a package.json at the repo root would
  // change how Vercel builds it.
  const dirs = [path.join(ROOT, "test", "node_modules"), path.join(ROOT, "node_modules")];
  if (process.env.TEST_MODULES) dirs.push(process.env.TEST_MODULES);
  const scratch = process.env.TEST_MODULES_FALLBACK;
  if (scratch) dirs.push(scratch);
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function resolveDep(rel) {
  for (const dir of depDirs()) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function requireDep(name) {
  for (const dir of depDirs()) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(p);
    }
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(name);
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Then any revision inside a browsers directory, whether that is this
  // sandbox's /opt/pw-browsers or the cache `playwright install` writes to.
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    path.join(process.env.HOME || "/root", ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const dir of roots) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith("chromium")) continue;
        for (const rel of [["chrome-linux", "chrome"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
          const p = path.join(dir, entry, ...rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {}
  }
  // Nothing found: let playwright-core resolve its own install.
  return null;
}

// --- page inventory --------------------------------------------------------

// Pages the suite must never treat as public: they are gated, and asserting
// "renders content" against them would be asserting the gate is broken.
const GATED = new Set(["/reception", "/admin/econ", "/admin", "/survey", "/webinar"]);

// Pages whose whole job is to be a redirect target or an error state.
const NOT_CONTENT = new Set(["/404"]);

function listPages() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "test") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".html")) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      // vercel.json sets cleanUrls, so /a/index.html serves at /a and
      // /b.html at /b. Test the URL a visitor actually gets.
      let url = "/" + rel.replace(/index\.html$/, "").replace(/\.html$/, "");
      if (url.length > 1 && url.endsWith("/")) url = url.slice(0, -1);
      out.push({ file: rel, path: full, url, gated: GATED.has(url), content: !NOT_CONTENT.has(url) });
    }
  };
  walk(ROOT);
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

function readVercel() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
}

// --- offline static server -------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jsx": "text/babel; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

// A 1x1 transparent PNG, so an <img> that points at a real asset path still
// lays out even when the binary isn't in the tree.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// Answer with a specific HTTP status rather than 200. Used where the honest
// response IS a refusal — a gated page's context call without a token.
function status(code, body) {
  return { __status: code, __body: body };
}

// Everything the pages fetch from our own origin during a test. Each returns a
// shape the page can actually use, so components render their real states
// rather than their error states.
function defaultApi() {
  return {
    "/api/signature-count": { count: 122812, display: "122,812", raw: 60550, offset: 62262, updated_at: new Date().toISOString(), stale: false },
    "/api/capture": { status: "partial" },
    "/api/prefill/resolve": { ok: true, found: false },
    "/api/leaderboard": { rows: [] },
    "/api/youtube": { items: [] },
    "/api/rally-claim": { valid: false, error: "This claim link isn't valid." },
    "/api/reception/resolve": { valid: false, error: "This invitation link isn't valid." },
    // Admin surfaces fetch their own data. Stubbed so the page renders its
    // real layout rather than its error state, without touching Airtable.
    "/api/admin/econ-dashboard": { ok: true, generated_at: new Date().toISOString(), topline: {}, ads: [], notifications: [] },
    "/api/admin/social-dashboard": { ok: true, accounts: [], posts: [] },
    "/api/webinar/state": { ok: true, session: null },
    // A visitor with no token gets the gate, not the briefing. Modelling the
    // 200 here would be modelling a security hole.
    "/api/webinar-context": status(403, { private: true }),
    "/api/survey/resolve": { ok: true, needs_capture: true, survey: { slug: "supporters", screens: [] } },
  };
}

function createServer({ apiOverrides = {}, onRequest } = {}) {
  const api = { ...defaultApi(), ...apiOverrides };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://local");
    const p = decodeURIComponent(u.pathname);
    if (onRequest) onRequest(req, p, u);

    // Our own API, answered from a fixture. No network, no quota, no tokens.
    if (p.startsWith("/api/")) {
      const stub = api[p];
      if (stub === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "not stubbed" }));
      }
      const code = stub && stub.__status ? stub.__status : 200;
      const body = stub && stub.__status ? stub.__body : stub;
      res.writeHead(code, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    // Vercel injects this; locally it is noise.
    if (p.startsWith("/_vercel/")) { res.writeHead(200, { "Content-Type": "application/javascript" }); return res.end(""); }

    const candidates = [];
    if (p === "/") candidates.push("index.html");
    else {
      const rel = p.replace(/^\/+/, "");
      candidates.push(rel, `${rel}.html`, path.join(rel, "index.html"));
    }
    for (const c of candidates) {
      const full = path.join(ROOT, c);
      if (!full.startsWith(ROOT)) break; // no traversal out of the tree
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        return res.end(fs.readFileSync(full));
      }
    }
    // Images that live outside the repo (uploads) still need to resolve.
    if (/\.(png|jpe?g|webp|gif|ico|svg)$/i.test(p)) {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PIXEL);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// --- offline third-party mirror -------------------------------------------

// Libraries the pages load from unpkg. Served from local copies so a run needs
// no internet, and so an outage upstream can never turn into a red build.
const CDN_MAP = [
  { match: "react-dom@18.3.1/umd/react-dom.development.js", file: "react-dom/umd/react-dom.development.js" },
  { match: "react-dom@18.3.1/umd/react-dom.production.min.js", file: "react-dom/umd/react-dom.production.min.js" },
  { match: "react@18.3.1/umd/react.development.js", file: "react/umd/react.development.js" },
  { match: "react@18.3.1/umd/react.production.min.js", file: "react/umd/react.production.min.js" },
  { match: "@babel/standalone@7.29.0/babel.min.js", file: "@babel/standalone/babel.min.js" },
];

function cdnBody(url) {
  for (const entry of CDN_MAP) {
    if (url.includes(entry.match)) {
      const p = resolveDep(entry.file);
      if (p) return fs.readFileSync(p, "utf8");
      // A missing library must fail loudly, not silently blank the page.
      return `throw new Error(${JSON.stringify("test harness: missing local copy of " + entry.file)});`;
    }
  }
  return null;
}

// Route every off-origin request. Libraries are served locally; analytics and
// fonts are answered with something harmless and RECORDED, so tests can assert
// on what a third party was told.
async function routeOffline(page, base, seen) {
  await page.route("**://**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const lib = cdnBody(url);
    if (lib !== null) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: lib });
    }
    if (seen) seen.push(url);
    if (/\.css(\?|$)/.test(url)) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    }
    return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });
}

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

module.exports = {
  ROOT,
  listPages,
  readVercel,
  createServer,
  listen,
  routeOffline,
  requireDep,
  resolveDep,
  chromiumPath,
  sha,
  status,
  GATED,
};
