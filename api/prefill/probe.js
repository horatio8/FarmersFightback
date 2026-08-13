// GET /api/prefill/probe?p=…&p2=…&…
//
// A one-click diagnostic for building a Campaign Nucleus send. Put the probe
// link in a test email to yourself, click it, and it reports which merge tag
// CN actually resolved — the question no amount of reading CN's API can
// answer, because it publishes neither the tag list nor a way to render one.
//
// Deliberately says nothing about the person. It reports tag NAMES, whether
// each resolved, and whether the resolved id matched a profile. The only
// personal thing it will echo is a masked first name, so you can tell at a
// glance that it found the right human.

const rateLimit = require("../survey/_ratelimit");
const { cnFetch } = require("../_cn");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classify(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "empty";
  // CN leaves the tag verbatim when it has no variable of that name.
  if (s.charAt(0) === "%" || s.indexOf("%recipient") !== -1) return "unresolved";
  if (UUID_RE.test(s)) return "uuid";
  return "resolved-but-not-a-uuid";
}

function mask(s) {
  const v = String(s || "");
  if (!v) return "";
  return v.slice(0, 1) + "*".repeat(Math.max(1, v.length - 1));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const rl = rateLimit.check(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false });
  }

  const url = new URL(req.url, "https://x");
  const params = {};
  let winner = null;
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "token") continue;
    const kind = classify(v);
    params[k] = kind;
    if (kind === "uuid" && !winner) winner = { param: k, id: v };
  }

  const out = {
    ok: true,
    what_this_means: winner
      ? `Campaign Nucleus resolves the profile id as the "${winner.param}" tag. Prefill will work.`
      : "No parameter came through as a profile id. See params below: 'unresolved' means CN has no merge tag of that name.",
    params,
  };

  if (winner) {
    try {
      const r = await cnFetch(`/profiles/${encodeURIComponent(winner.id)}`, null, "GET");
      const p = r && r.ok && r.json ? (r.json.data || r.json) : null;
      out.profile_found = Boolean(p && p.id);
      // Masked, purely so you can confirm it found the right person.
      if (p && p.id) out.matched = { first: mask(p.first_name), has_email: Boolean(p.email), has_mobile: Boolean(p.mobile || p.phone) };
    } catch (e) {
      out.profile_found = false;
    }
  }

  return res.status(200).end(JSON.stringify(out, null, 2));
};
