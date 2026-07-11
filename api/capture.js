// Email-action partial capture (Email the Liberal Party page).
//
// POST /api/capture
//   { session_id, first_name?, last_name?, email?, mobile?, consent?,
//     honeypot?, variation_shown?, utm_source?, utm_medium?, utm_campaign?,
//     user_agent?, send_clicked? }
//
// Upserts a row in the `Signups` Airtable table keyed on session_id. Omitted
// fields are left unchanged (never cleared). Status flips to `complete` the
// moment first_name + last_name + email are all present; otherwise `partial`.
// Response is write-only: { ok:true, status } — never echoes stored data.
//
// On the transition to `complete` (once per session) it also drops the
// supporter into the Contacts identity ladder (matchOrCreateContact) and
// pushes them to Campaign Nucleus (tagged email_action_vni). Both are
// best-effort and never fail the request.
//
// Env: AIRTABLE_API_KEY, AIRTABLE_BASE_ID (via ./_airtable), CN_API_KEY (via
// ./_cn). Honeypot + a small per-instance per-IP rate limit guard the route.

const {
  findOne, createRow, updateRow, nowIso, normEmail, normPhone, matchOrCreateContact,
} = require("./_airtable");
const { cnProfileMatch } = require("./_cn");

const SIGNUPS_TABLE = process.env.AIRTABLE_SIGNUPS_TABLE || "Signups";

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
  "https://farmersfightback-tellerconsulting.vercel.app",
]);

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

function esc(s) { return String(s).replace(/'/g, "\\'"); }

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Per-instance rate limit: 30 requests / IP / minute. Best-effort — resets on
// cold start and isn't shared across lambda instances, which is acceptable
// backstop behaviour for a write-only capture beacon.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateHits.set(ip, arr);
  return arr.length > RATE_MAX;
}

// Trim occasional stale entries so the Map doesn't grow unbounded.
function sweepRate() {
  if (rateHits.size < 5000) return;
  const now = Date.now();
  for (const [ip, arr] of rateHits) {
    if (!arr.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(ip);
  }
}

function pickStr(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
}

// Push a completed supporter into Campaign Nucleus. Best-effort; resolves to
// true only on a confirmed OK so the caller can set cn_synced.
async function syncToCN(fields) {
  const out = await cnProfileMatch({
    first_name: fields.first_name || undefined,
    last_name: fields.last_name || undefined,
    email: fields.email || undefined,
    mobile: fields.mobile || undefined,
    tags: ["email_action_vni"],
  }).catch((e) => { console.error("capture CN sync error:", e.message); return { ok: false }; });
  return !!(out && out.ok);
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Honeypot: pretend everything is fine, write nothing.
  if (pickStr(body.honeypot)) return res.status(200).json({ ok: true, status: "partial" });

  const ip = clientIp(req);
  sweepRate();
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests" });

  const session_id = pickStr(body.session_id, 80);
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  try {
    const existing = await findOne(SIGNUPS_TABLE, `{session_id}='${esc(session_id)}'`);
    const cur = (existing && existing.fields) || {};

    // Monotonic seq guard: a late-arriving older snapshot must never overwrite
    // newer data. Only applies when BOTH incoming and stored seq are numbers;
    // records/requests without seq behave as before (accepted).
    const incomingSeq = (body.seq !== undefined && body.seq !== null
      && Number.isFinite(Number(body.seq))) ? Number(body.seq) : undefined;
    const storedSeq = Number.isFinite(Number(cur.seq)) && cur.seq !== null && cur.seq !== ""
      ? Number(cur.seq) : undefined;
    if (incomingSeq !== undefined && storedSeq !== undefined && incomingSeq <= storedSeq) {
      return res.status(200).json({ ok: true, status: cur.status || "partial", stale: true });
    }

    // Build the patch from provided fields only (omitted = leave unchanged).
    const patch = {};
    const first_name = pickStr(body.first_name, 80);
    const last_name = pickStr(body.last_name, 80);
    // Server-side validation mirror of the client: ignore an incoming email
    // unless it looks like a real address, and ignore a mobile unless it
    // normalizes to an AU +614xxxxxxxx number. Ignored values are treated as
    // omitted (stored value left unchanged) so junk can never overwrite good
    // data — this is the core defence against the partial-capture bug.
    const rawEmail = body.email !== undefined ? normEmail(body.email) : undefined;
    const email = (rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) ? rawEmail : undefined;
    const rawMobile = body.mobile !== undefined ? normPhone(body.mobile) : undefined;
    const mobile = (rawMobile && /^\+614\d{8}$/.test(rawMobile)) ? rawMobile : undefined;
    if (first_name !== undefined) patch.first_name = first_name;
    if (last_name !== undefined) patch.last_name = last_name;
    if (email) patch.email = email;
    if (mobile) patch.mobile = mobile;
    if (incomingSeq !== undefined) patch.seq = incomingSeq;
    if (body.consent !== undefined) patch.consent = !!body.consent;
    if (body.send_clicked !== undefined) patch.send_clicked = !!body.send_clicked;
    // Exact email content at the moment Send was clicked (post-edit/rewrite).
    const sent_subject = pickStr(body.sent_subject, 300);
    const sent_body = pickStr(body.sent_body, 4000);
    if (sent_subject !== undefined) patch.sent_subject = sent_subject;
    if (sent_body !== undefined) patch.sent_body = sent_body;
    if (body.variation_shown !== undefined) {
      const n = Number(body.variation_shown);
      if (Number.isFinite(n) && n >= 1 && n <= 10) patch.variation_shown = n;
    }
    const utm_source = pickStr(body.utm_source, 200);
    const utm_medium = pickStr(body.utm_medium, 200);
    const utm_campaign = pickStr(body.utm_campaign, 200);
    const user_agent = pickStr(body.user_agent, 1000);
    if (utm_source !== undefined) patch.utm_source = utm_source;
    if (utm_medium !== undefined) patch.utm_medium = utm_medium;
    if (utm_campaign !== undefined) patch.utm_campaign = utm_campaign;
    if (user_agent !== undefined) patch.user_agent = user_agent;

    // Merged identity determines status. complete = first + last + email all
    // present (mobile not required).
    const mFirst = patch.first_name !== undefined ? patch.first_name : cur.first_name;
    const mLast = patch.last_name !== undefined ? patch.last_name : cur.last_name;
    const mEmail = patch.email !== undefined ? patch.email : cur.email;
    const status = (mFirst && mLast && mEmail) ? "complete" : "partial";
    patch.status = status;

    const prevStatus = cur.status || "";
    const transitionedToComplete = status === "complete" && prevStatus !== "complete";

    patch.updated_at = nowIso();
    if (!existing) patch.created_at = nowIso();

    // CN sync fires on the transition to complete when not already synced.
    if (transitionedToComplete && cur.cn_synced !== true) {
      try {
        const synced = await syncToCN({
          first_name: mFirst, last_name: mLast, email: mEmail,
          mobile: patch.mobile !== undefined ? patch.mobile : cur.mobile,
        });
        if (synced) patch.cn_synced = true;
      } catch (e) {
        console.error("capture CN sync failed:", e.message);
      }
    }

    if (existing) await updateRow(SIGNUPS_TABLE, existing.id, patch);
    else await createRow(SIGNUPS_TABLE, { session_id, ...patch });

    // Once per session, on the transition to complete, drop the supporter into
    // the Contacts identity ladder. Dedupes on the ladder and only bumps the
    // public signature counter for genuinely new contacts. Never fails the req.
    if (transitionedToComplete) {
      try {
        await matchOrCreateContact({
          first_name: mFirst,
          last_name: mLast,
          email: mEmail,
          mobile: patch.mobile !== undefined ? patch.mobile : cur.mobile,
          source_channel: "Other",
        });
      } catch (e) {
        console.error("capture matchOrCreateContact failed:", e.message);
      }
    }

    return res.status(200).json({ ok: true, status });
  } catch (e) {
    console.error("capture:", e.message);
    return res.status(500).json({ error: "capture failed" });
  }
};
