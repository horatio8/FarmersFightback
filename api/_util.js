// Shared utilities for the donation-maximisation build: auth guards,
// Melbourne-time quiet-hours scheduling, phone hashing, Stripe form
// encoding. Underscore-prefixed => not deployed as a function.

const crypto = require("crypto");

function phoneHash(e164) {
  return crypto.createHash("sha256").update(String(e164)).digest("hex");
}

// Cellcast returns inbound "from" numbers as AU mobiles with the country
// code and leading zero stripped (e.g. "412027211"). Normalise to the
// same +61E.164 form Contacts.mobile is stored in, so STOP suppression
// can match the sender to a contact.
function cellcastToE164(raw) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("61")) return "+" + d;
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 9) return "+61" + d; // 4xxxxxxxx mobile (or 9-digit local)
  return "+61" + d;
}

// --- auth guards -----------------------------------------------------

// Vercel cron invocations send Authorization: Bearer <CRON_SECRET> when the
// env var is set. Enforce when configured; otherwise allow but warn (so the
// endpoints still work before James sets the secret, just not locked down).
function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("CRON_SECRET not set — cron endpoint is unauthenticated");
    return true;
  }
  if ((req.headers.authorization || "") === `Bearer ${secret}`) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ADMIN_BASIC_AUTH="user:pass" guards /api/ab-report, /leaderboard, backfill.
function requireBasicAuth(req, res) {
  const conf = process.env.ADMIN_BASIC_AUTH;
  if (!conf) {
    res.status(503).json({ error: "ADMIN_BASIC_AUTH env var not set" });
    return false;
  }
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Basic ")) {
    const got = Buffer.from(hdr.slice(6), "base64").toString("utf8");
    if (got === conf) return true;
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="ff-admin"');
  res.status(401).send("auth required");
  return false;
}

// --- Melbourne time / quiet hours -------------------------------------

// Minutes east of UTC for Australia/Melbourne at the given instant
// (handles AEST +600 / AEDT +660 automatically).
function melbourneOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Melbourne",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function melbourneParts(date) {
  const off = melbourneOffsetMinutes(date);
  const local = new Date(date.getTime() + off * 60000);
  return {
    y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(),
    hour: local.getUTCHours(), minute: local.getUTCMinutes(), offset: off,
  };
}

function parseHHMM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return fallback;
  return { h: Number(m[1]), min: Number(m[2]) };
}

// Given a candidate send time, push it inside quiet hours if needed:
// deliveries only between SMS_QUIET_START (08:00) and SMS_QUIET_END (20:00)
// Melbourne time; outside that window, next 08:05 + 0-10 min jitter.
function clampToQuietHours(candidate) {
  const start = parseHHMM(process.env.SMS_QUIET_START, { h: 8, min: 0 });
  const end = parseHHMM(process.env.SMS_QUIET_END, { h: 20, min: 0 });
  const p = melbourneParts(candidate);
  const mins = p.hour * 60 + p.minute;
  const startMins = start.h * 60 + start.min;
  const endMins = end.h * 60 + end.min;
  if (mins >= startMins && mins < endMins) return candidate;

  // Next window opening (today if before start, else tomorrow), 08:05 + jitter.
  const jitterMs = Math.floor(Math.random() * 10 * 60000);
  const dayShift = mins >= endMins ? 1 : 0;
  const openUTC = Date.UTC(p.y, p.m, p.d + dayShift, start.h, start.min + 5) - p.offset * 60000;
  return new Date(openUTC + jitterMs);
}

// Random 15-55s (env-tunable) delay from now, then quiet-hours clamp.
function scheduleSignupSMS(now = new Date()) {
  const minS = Number(process.env.SMS_DELAY_MIN_S) || 15;
  const maxS = Number(process.env.SMS_DELAY_MAX_S) || 55;
  const delayS = minS + Math.random() * Math.max(0, maxS - minS);
  return clampToQuietHours(new Date(now.getTime() + delayS * 1000));
}

// --- Stripe form-encoded client (shared with rally-checkout pattern) ---

function toFormBody(obj, prefix = "") {
  const parts = [];
  const enc = encodeURIComponent;
  const walk = (val, key) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) val.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof val === "object") Object.keys(val).forEach((k) => walk(val[k], `${key}[${k}]`));
    else parts.push(`${enc(key)}=${enc(String(val))}`);
  };
  Object.keys(obj).forEach((k) => walk(obj[k], prefix ? `${prefix}[${k}]` : k));
  return parts.join("&");
}

function stripeClient(secretKey) {
  return async function stripeFetch(path, opts = {}) {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      const err = new Error(`Stripe ${r.status}: ${body.slice(0, 400)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };
}

function hostBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "www.farmersfightback.com";
  return `${proto}://${host}`;
}

// Canonical full-name splitter: first token = first name, remainder = last
// name ("John Van Dyke" → { fn: "John", ln: "Van Dyke" }). Matches the
// identity ladder's convention in _airtable.matchOrCreateContact so the same
// person parses identically on every path (webhook, lapse sweep, rally).
function splitName(name) {
  if (!name || typeof name !== "string") return { fn: undefined, ln: undefined };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: undefined, ln: undefined };
  return { fn: parts[0], ln: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

module.exports = {
  phoneHash,
  cellcastToE164,
  splitName,
  requireCron,
  requireBasicAuth,
  melbourneParts,
  clampToQuietHours,
  scheduleSignupSMS,
  toFormBody,
  stripeClient,
  hostBase,
};
