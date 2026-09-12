#!/usr/bin/env node
// Local stand-in for Vercel: static files from the project root, /api/* to
// the handler files, the same rewrites as vercel.json. No dependencies.
//
//   node scripts/dev-server.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const vercel = require(path.join(ROOT, "vercel.json"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".jsx": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
const port = Number(process.argv[2] || 3100);

function rewrite(pathname) {
  for (const r of vercel.rewrites || []) {
    const re = new RegExp("^" + r.source.replace(/:[^/]+/g, "[^/]+") + "$");
    if (re.test(pathname)) return r.destination;
  }
  return pathname;
}
function resFor(res) {
  const out = { statusCode: 200 };
  out.setHeader = (k, v) => res.setHeader(k, v);
  out.status = (c) => { res.statusCode = c; return out; };
  out.json = (b) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(b)); return out; };
  out.end = (b) => res.end(b);
  return out;
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${port}`);
  if (u.pathname.startsWith("/api/")) {
    const file = path.join(ROOT, "api", u.pathname.slice(5).replace(/[^a-z0-9-]/gi, "") + ".js");
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("no such api"); }
    let body = "";
    for await (const chunk of req) body += chunk;
    const fake = { method: req.method, url: req.url, headers: req.headers, query: Object.fromEntries(u.searchParams), body: body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {} };
    delete require.cache[file];
    try { await require(file)(fake, resFor(res)); } catch (e) { res.statusCode = 500; res.end("handler crashed: " + e.message); }
    return;
  }
  let p = rewrite(u.pathname);
  if (p === "/") p = "/index.html";
  let file = path.join(ROOT, p);
  if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found: " + p); }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`farmersvotes dev server on http://localhost:${port}`));
