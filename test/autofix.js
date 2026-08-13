// Static checks that can repair what they find.
//
// Every rule here is a defect the suite can both DETECT and FIX deterministically
// from the file itself. That is the bar for inclusion: if a fix needs judgement,
// it belongs in a test that fails and asks a human, not in here. Nothing in this
// file calls a network, a model, or an API — a repair costs one file read and one
// file write.
//
//   node test/autofix.js          report only
//   node test/autofix.js --fix    repair, then report what changed
//
// Each rule is { id, describe, scan(ctx) -> findings[] }, where a finding may
// carry apply() to repair itself. Fixes must be idempotent: the verify pass
// re-runs every rule after fixing and fails the build if anything remains.

const fs = require("fs");
const path = require("path");
const { ROOT, listPages, sha } = require("./lib/site");

// Pages that deliberately keep analytics off, or are not public surfaces.
const NO_ANALYTICS = new Set(["/404", "/admin", "/admin/econ"]);
// Private pages that must stay out of search results.
const MUST_NOINDEX = new Set(["/reception", "/admin", "/admin/econ"]);

function read(file) { return fs.readFileSync(file, "utf8"); }
function write(file, s) { fs.writeFileSync(file, s); }

// Local asset referenced with a cache-busting query, e.g. app.jsx?v=20260813-3.
// The version has to change whenever the file does, or a returning visitor is
// served the copy already in their browser cache — the exact failure that
// silently ships an old bundle after a deploy.
const VERSIONED = /(?:src|href)="([^"?#]+\.(?:jsx|js|css))\?v=([^"]*)"/g;

function resolveAsset(pageFile, ref) {
  const base = ref.startsWith("/") ? ROOT : path.dirname(pageFile);
  const rel = ref.startsWith("/") ? ref.slice(1) : ref;
  const full = path.join(base, rel);
  return fs.existsSync(full) ? full : null;
}

const RULES = [
  {
    id: "cache-bust-stale",
    describe: "a versioned asset changed but its ?v= did not, so returning visitors get the cached copy",
    scan({ pages, manifest, nextManifest }) {
      const out = [];
      for (const page of pages) {
        const src = read(page.path);
        for (const m of src.matchAll(VERSIONED)) {
          const [whole, ref, version] = m;
          const assetPath = resolveAsset(page.path, ref);
          if (!assetPath) continue;
          const digest = sha(read(assetPath));
          const key = `${ref}@${version}`;
          nextManifest[key] = digest;
          const known = manifest[key];
          if (known && known !== digest) {
            const fresh = `${version.replace(/-h[0-9a-f]{6}$/, "")}-h${digest.slice(0, 6)}`;
            out.push({
              file: page.file,
              detail: `${ref} changed since it was last published as ?v=${version}`,
              apply() {
                let s = read(page.path);
                s = s.split(whole).join(whole.replace(`?v=${version}`, `?v=${fresh}`));
                write(page.path, s);
                delete nextManifest[key];
                nextManifest[`${ref}@${fresh}`] = digest;
              },
            });
          }
        }
      }
      return out;
    },
  },

  {
    id: "meta-charset",
    describe: "a page without a charset can render mojibake for anything non-ASCII",
    scan({ pages }) {
      return pages.filter((p) => !/<meta[^>]+charset=/i.test(read(p.path))).map((page) => ({
        file: page.file,
        detail: "no <meta charset>",
        apply() {
          let s = read(page.path);
          s = s.replace(/<head([^>]*)>/i, `<head$1>\n  <meta charset="UTF-8"/>`);
          write(page.path, s);
        },
      }));
    },
  },

  {
    id: "meta-viewport",
    describe: "without a viewport a phone renders the desktop layout zoomed out, and this audience is on phones",
    scan({ pages }) {
      return pages.filter((p) => !/name="viewport"/i.test(read(p.path))).map((page) => ({
        file: page.file,
        detail: "no viewport meta",
        apply() {
          let s = read(page.path);
          s = s.replace(/(<meta[^>]+charset=[^>]*>)/i,
            `$1\n  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>`);
          write(page.path, s);
        },
      }));
    },
  },

  {
    id: "analytics-missing",
    describe: "a public page with no Vercel insights tag reports no traffic, so its performance is invisible",
    scan({ pages }) {
      return pages
        .filter((p) => !NO_ANALYTICS.has(p.url))
        .filter((p) => !read(p.path).includes("/_vercel/insights/script.js"))
        .map((page) => ({
          file: page.file,
          detail: "no Vercel insights script",
          apply() {
            let s = read(page.path);
            s = s.replace(/<\/head>/i, `  <script defer src="/_vercel/insights/script.js"></script>\n</head>`);
            write(page.path, s);
          },
        }));
    },
  },

  {
    id: "private-page-indexable",
    describe: "a gated page without noindex can surface in search results, which defeats the gate",
    scan({ pages }) {
      return pages
        .filter((p) => MUST_NOINDEX.has(p.url))
        .filter((p) => !/name="robots"[^>]*noindex/i.test(read(p.path)))
        .map((page) => ({
          file: page.file,
          detail: "private page is missing <meta name=robots content=noindex>",
          apply() {
            let s = read(page.path);
            s = s.replace(/<meta[^>]+name="viewport"[^>]*>/i,
              (m) => `${m}\n  <meta name="robots" content="noindex,nofollow,noarchive"/>`);
            write(page.path, s);
          },
        }));
    },
  },

  {
    id: "prefill-after-trackers",
    describe: "prefill.js must load before Clarity and the Meta Pixel, or a tokenised link's details reach them in the URL",
    scan({ pages }) {
      const out = [];
      for (const page of pages) {
        const s = read(page.path);
        const iPrefill = s.indexOf("assets/prefill.js");
        if (iPrefill === -1) continue;
        const iClarity = s.indexOf("clarity.ms");
        const iPixel = s.indexOf("fbevents.js");
        const first = [iClarity, iPixel].filter((i) => i !== -1).sort((a, b) => a - b)[0];
        if (first === undefined || iPrefill < first) continue;
        out.push({
          file: page.file,
          detail: "prefill.js loads after a tracking tag, so the tag can read the URL first",
          apply() {
            let src = read(page.path);
            const tag = src.match(/[ \t]*<script src="\/assets\/prefill\.js[^"]*"><\/script>\n?/);
            if (!tag) return;
            src = src.replace(tag[0], "");
            // Reinsert immediately after the stylesheet, ahead of every tag.
            src = src.replace(/(<link rel="stylesheet"[^>]*>\n)/i, `$1\n${tag[0]}`);
            write(page.path, src);
          },
        });
      }
      return out;
    },
  },

  {
    id: "unsafe-blank-link",
    describe: "target=_blank without rel=noopener hands the opened page control of this one",
    scan({ pages }) {
      const out = [];
      for (const page of pages) {
        const s = read(page.path);
        const bad = [...s.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)]
          .filter((m) => !/rel="[^"]*noopener/.test(m[0]));
        if (!bad.length) continue;
        out.push({
          file: page.file,
          detail: `${bad.length} target=_blank link(s) without rel=noopener`,
          apply() {
            let src = read(page.path);
            src = src.replace(/<a\b[^>]*target="_blank"[^>]*>/g, (tag) => {
              if (/rel="[^"]*noopener/.test(tag)) return tag;
              // Keep any rel already there (nofollow, external) and add to it.
              if (/rel="[^"]*"/.test(tag)) {
                return tag.replace(/rel="([^"]*)"/, (whole, existing) => {
                  const parts = new Set(String(existing).split(/\s+/).filter(Boolean));
                  parts.add("noopener");
                  parts.add("noreferrer");
                  return `rel="${[...parts].join(" ")}"`;
                });
              }
              return tag.replace(/<a\b/, '<a rel="noopener noreferrer"');
            });
            write(page.path, src);
          },
        });
      }
      return out;
    },
  },

  {
    id: "html-lang-missing",
    describe: "without a language a screen reader guesses the accent, and translation tools mangle the page",
    scan({ pages }) {
      return pages.filter((p) => !/<html[^>]+lang=/i.test(read(p.path))).map((page) => ({
        file: page.file,
        detail: "<html> has no lang attribute",
        apply() {
          const s = read(page.path);
          write(page.path, s.replace(/<html\b([^>]*)>/i, (m, attrs) =>
            `<html${attrs} lang="en-AU">`));
        },
      }));
    },
  },

  {
    id: "insecure-http-asset",
    describe: "an http:// asset is blocked as mixed content on an https page, so it simply does not load",
    scan({ pages }) {
      const out = [];
      for (const page of pages) {
        const s = read(page.path);
        const bad = [...s.matchAll(/(?:src|href)="(http:\/\/[^"]+)"/g)]
          // A namespace or DTD identifier is a name, not a request.
          .filter((m) => !/w3\.org|schema\.org|purl\.org/.test(m[1]));
        if (!bad.length) continue;
        out.push({
          file: page.file,
          detail: `${bad.length} asset(s) loaded over plain http`,
          apply() {
            let src = read(page.path);
            for (const m of bad) src = src.split(m[0]).join(m[0].replace("http://", "https://"));
            write(page.path, src);
          },
        });
      }
      return out;
    },
  },

  {
    id: "favicon-missing",
    describe: "a page with no icon shows a blank tab, which reads as a broken or spoofed site",
    scan({ pages }) {
      return pages
        .filter((p) => !/rel="[^"]*icon/i.test(read(p.path)))
        .map((page) => {
          // Match what the rest of the site does: an SVG icon with a PNG
          // fallback, addressed relative to where this page sits in the tree.
          const up = "../".repeat(page.file.split("/").length - 1);
          return {
            file: page.file,
            detail: "no favicon link",
            apply() {
              const s = read(page.path);
              write(page.path, s.replace(/<\/head>/i,
                `  <link rel="icon" type="image/svg+xml" href="${up}assets/favicon.svg"/>\n`
                + `  <link rel="alternate icon" href="${up}assets/logo.png"/>\n</head>`));
            },
          };
        });
    },
  },

  {
    id: "dot-html-link",
    describe: "linking to /page.html costs every visitor a 308 redirect, because cleanUrls serves it at /page",
    scan({ pages }) {
      const out = [];
      const known = new Set(listPages().map((p) => p.url));
      for (const page of pages) {
        const s = read(page.path);
        const bad = [...s.matchAll(/href="(\/[A-Za-z0-9_\-/]+)\.html"/g)]
          .filter((m) => known.has(m[1]));
        if (!bad.length) continue;
        out.push({
          file: page.file,
          detail: `${bad.length} link(s) to a .html path that redirects`,
          apply() {
            let src = read(page.path);
            for (const m of bad) src = src.split(m[0]).join(`href="${m[1]}"`);
            write(page.path, src);
          },
        });
      }
      return out;
    },
  },
];

const MANIFEST = path.join(__dirname, "baselines", "assets.json");

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return {}; }
}
function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

function runRules() {
  const pages = listPages();
  const manifest = loadManifest();
  const nextManifest = {};
  const findings = [];
  for (const rule of RULES) {
    for (const f of rule.scan({ pages, manifest, nextManifest })) {
      findings.push({ rule: rule.id, describe: rule.describe, ...f });
    }
  }
  return { findings, nextManifest };
}

// Detect, repair, then detect again. A rule that reports the same finding after
// its own fix is a broken rule, and saying so is more useful than looping.
function autofix({ fix = false, quiet = false } = {}) {
  const first = runRules();
  const log = (...a) => { if (!quiet) console.log(...a); };

  if (!first.findings.length) {
    log("autofix: nothing to repair");
    saveManifest(first.nextManifest);
    return { fixed: [], remaining: [], clean: true };
  }

  if (!fix) {
    log(`autofix: ${first.findings.length} issue(s) found (run with --fix to repair)`);
    for (const f of first.findings) log(`  - [${f.rule}] ${f.file}: ${f.detail}`);
    return { fixed: [], remaining: first.findings, clean: false };
  }

  const fixed = [];
  for (const f of first.findings) {
    if (typeof f.apply !== "function") continue;
    try { f.apply(); fixed.push(f); } catch (e) {
      f.error = e.message;
    }
  }

  const second = runRules();
  saveManifest(second.nextManifest);
  for (const f of fixed) log(`  fixed [${f.rule}] ${f.file}: ${f.detail}`);
  for (const f of second.findings) log(`  STILL BROKEN [${f.rule}] ${f.file}: ${f.detail}`);
  log(`autofix: repaired ${fixed.length}, ${second.findings.length} remaining`);
  return { fixed, remaining: second.findings, clean: second.findings.length === 0 };
}

if (require.main === module) {
  const res = autofix({ fix: process.argv.includes("--fix") });
  process.exit(res.clean ? 0 : 1);
}

module.exports = { autofix, runRules, RULES, loadManifest, saveManifest, MANIFEST };
