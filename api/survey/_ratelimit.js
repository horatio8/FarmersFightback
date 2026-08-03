// Per-IP rate limit for token resolution.
//
// Why this endpoint specifically: a referral code is 6 characters from a 31
// character alphabet, so the space is 887,503,681 and roughly 36,000 codes are
// live. That is one real supporter in every ~24,000 guesses, which is a
// scraping rate rather than a theoretical bound. Masking means a hit yields
// "J***s" instead of a supporter record, but nothing should be able to sit and
// grind through the space confirming which codes are real.
//
// Deliberately a fixed window in process memory, not a shared store. Serverless
// instances are per-region and recycled, so this is a speed bump rather than a
// guarantee: it turns "grind the space from one host" into "you need a botnet",
// which is the honest limit of what can be done without adding Redis. If this
// ever needs to be a hard bound, move the counter to Airtable or Upstash.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
// Bound the map so a spray of spoofed forwarded-for values cannot grow it
// without limit; oldest windows are evicted first.
const MAX_TRACKED = 5000;

const hits = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

function sweep(now) {
  for (const [k, v] of hits) {
    if (now - v.start >= WINDOW_MS) hits.delete(k);
  }
  if (hits.size > MAX_TRACKED) {
    const excess = hits.size - MAX_TRACKED;
    let i = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      if (++i >= excess) break;
    }
  }
}

// → { ok: true } or { ok: false, retryAfter: <seconds> }
function check(req, { max = MAX_PER_WINDOW } = {}) {
  const now = Date.now();
  const ip = clientIp(req);
  const cur = hits.get(ip);

  if (!cur || now - cur.start >= WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 100) sweep(now);
    return { ok: true };
  }

  cur.n += 1;
  if (cur.n > max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - cur.start)) / 1000)) };
  }
  return { ok: true };
}

module.exports = { check, clientIp, WINDOW_MS, MAX_PER_WINDOW };
