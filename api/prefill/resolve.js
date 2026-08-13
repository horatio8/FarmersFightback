// GET /api/prefill/resolve?p=<campaign-nucleus profile uuid>
//
// Server-side prefill for tokenised email links. The link carries nothing but
// an opaque Campaign Nucleus profile id; this endpoint exchanges it for that
// person's details, reading them from CN — never from Airtable, which does
// not hold a complete record of everyone CN mails.
//
// Why a UUID and nothing else:
//   * 122 bits of entropy — not guessable, not enumerable, and it appears
//     nowhere public.
//   * The referral code is explicitly NOT accepted. Those are published in
//     every share link (/page?ref=CODE, posted to Facebook), so honouring one
//     here would handonyone who has seen a shared link that supporter's email
//     address and mobile number.
//   * An email address is not accepted either, for the same reason: it would
//     turn this into an oracle that returns a mobile number for any address
//     someone cares to try.
//
// The CN API key stays server-side. The response is no-store, rate limited,
// and identical for "no such profile" and "malformed id" so the endpoint
// cannot be used to test whether an id exists.

const rateLimit = require("../survey/_ratelimit");
const { cnFetch } = require("../_cn");

// Canonical 8-4-4-4-12 hex. Anything else is refused before it reaches CN.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CN merge tags do not follow its own profile field names — live sends use
// %recipient.first%, not %recipient.first_name% — and no campaign this
// account has ever sent contains an id tag, so the name for it cannot be read
// off history and CN's API does not publish the list. The link therefore
// carries every plausible name and we take the first that resolved. Wrong
// guesses arrive as the literal "%recipient.x%" and are ignored.
const ID_PARAMS = ["p", "p2", "p3", "p4", "p5", "p6"];

function pickId(url) {
  for (const k of ID_PARAMS) {
    const v = String(url.searchParams.get(k) || "").trim();
    if (UUID_RE.test(v)) return { id: v, param: k };
  }
  return null;
}

// Australian mobiles come back from CN in mixed shapes (61412…, +61412…,
// 0412…). The form expects the local form.
function localMobile(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("61") && d.length >= 11) return "0" + d.slice(2);
  if (d.startsWith("0")) return d;
  if (d.length === 9) return "0" + d;
  return d;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const rl = rateLimit.check(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false });
  }

  const url = new URL(req.url, "https://x");
  const hit = pickId(url);
  // Uniform miss: never distinguish "no id supplied", "not a uuid" and
  // "no such profile".
  const miss = { ok: true, found: false };
  if (!hit) return res.status(200).json(miss);

  try {
    const out = await cnFetch(`/profiles/${encodeURIComponent(hit.id)}`, null, "GET");
    if (!out || !out.ok || !out.json) return res.status(200).json(miss);
    const p = out.json.data || out.json;
    if (!p || !p.id) return res.status(200).json(miss);

    // Only the four fields the form needs. Nothing else about the person
    // crosses the wire, whatever else the profile happens to hold.
    return res.status(200).json({
      ok: true,
      found: true,
      // Which tag name won, so a send can be checked without exposing
      // anything: it names the merge tag, not the person.
      via: hit.param,
      prefill: {
        first: p.first_name || "",
        last: p.last_name || "",
        email: p.email || "",
        mobile: localMobile(p.mobile || p.phone || ""),
        postcode: p.zip || "",
      },
    });
  } catch (e) {
    console.error("prefill/resolve:", e.message);
    return res.status(200).json(miss);
  }
};
