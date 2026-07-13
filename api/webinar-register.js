// Donor webinar registration (spec §5.3).
//
// POST /api/webinar-register
//   { t, session, first_name, last_name, email, mobile?, attendance_intent }
//   → 200 { ok: true, join_url: string|null }
//   → 400 { error }            bad fields
//   → 403 { private: true }    invalid/expired token or session mismatch
//   → 503 { error: "not configured" } when WEBINAR_TOKEN_SECRET is unset
//
// Flow: (a) best-effort CN signup when the Webinars row carries a CN event
// id — failure is logged and never blocks; (b) upsert the Airtable
// Registrations mirror keyed on the exact token, so re-registration with the
// same magic link updates intent/fields instead of duplicating.

const { findOne, createRow, updateRow, uuid, nowIso, normEmail, normPhone } = require("./_airtable");
const { cnFetch } = require("./_cn");
const {
  REGISTRATIONS_TABLE,
  INTENTS,
  isConfigured,
  verifyToken,
  escFormula,
  normSession,
  findWebinarBySession,
  findContactByContactId,
} = require("./_webinar");

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort CN signup: any 2xx counts as synced; anything else is logged
// and ignored (CN is the system of record, but our page must never fail a
// donor because CN hiccupped).
async function cnSignup(webinarFields, reg) {
  const eventId = webinarFields.webinar_id;
  if (!eventId) return { synced: false, id: "" };
  const out = await cnFetch(`/events/${encodeURIComponent(eventId)}/signups`, {
    first_name: reg.first_name,
    last_name: reg.last_name,
    email: reg.email,
    phone: reg.mobile || undefined,
    custom_fields: { attendance_intent: reg.attendance_intent },
  });
  if (out && out.ok) {
    const j = out.json || {};
    const id = j.id || (j.data && j.data.id) || (j.signup && j.signup.id) || "";
    return { synced: true, id: id ? String(id) : "" };
  }
  console.error("webinar CN signup failed:", JSON.stringify(out || {}).slice(0, 300));
  return { synced: false, id: "" };
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!isConfigured()) return res.status(503).json({ error: "not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const token = String(body.t || "");
  const session = normSession(body.session);
  const v = verifyToken(token);
  if (!v || !session || v.session !== session) {
    return res.status(403).json({ private: true });
  }

  const first_name = String(body.first_name || "").trim().slice(0, 80);
  const last_name = String(body.last_name || "").trim().slice(0, 80);
  const email = normEmail(body.email);
  const rawMobile = String(body.mobile || "").trim();
  const mobile = rawMobile ? normPhone(rawMobile) : "";
  const attendance_intent = String(body.attendance_intent || "").trim();

  if (!first_name) return res.status(400).json({ error: "First name is required." });
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  // Mobile is optional; when supplied it must normalise to something sane.
  if (rawMobile && !/^\+?\d{8,15}$/.test(mobile)) {
    return res.status(400).json({ error: "Please enter a valid mobile number." });
  }
  if (!INTENTS.includes(attendance_intent)) {
    return res.status(400).json({ error: "Please choose whether you can attend." });
  }

  try {
    const webinar = await findWebinarBySession(session);
    if (!webinar) return res.status(404).json({ error: "session not found" });
    const wf = webinar.fields || {};

    const reg = { first_name, last_name, email, mobile, attendance_intent };

    // (a) CN signup — best-effort, never blocks the Airtable mirror.
    let cn = { synced: false, id: "" };
    try {
      cn = await cnSignup(wf, reg);
    } catch (e) {
      console.error("webinar CN signup threw:", e.message);
    }

    // (b) Upsert Registrations keyed on the exact magic-link token (one
    // token = one contact + one webinar, so this is the natural unique key).
    const existing = await findOne(REGISTRATIONS_TABLE, `{token}='${escFormula(token)}'`);
    if (existing) {
      const patch = {
        first_name,
        last_name,
        email,
        mobile: mobile || undefined,
        attendance_intent,
        registered_at: nowIso(),
      };
      if (cn.synced) {
        patch.cn_synced = true;
        if (cn.id && !(existing.fields || {}).cn_signup_id) patch.cn_signup_id = cn.id;
      }
      Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
      await updateRow(REGISTRATIONS_TABLE, existing.id, patch);
    } else {
      const contact = await findContactByContactId(v.contact_id);
      const fields = {
        registration_id: uuid(),
        contact: contact ? [contact.id] : undefined,
        webinar: [webinar.id],
        first_name,
        last_name,
        email,
        mobile: mobile || undefined,
        attendance_intent,
        cn_signup_id: cn.id || undefined,
        cn_synced: cn.synced || undefined,
        registered_at: nowIso(),
        token,
        source_channel: "email",
      };
      Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
      await createRow(REGISTRATIONS_TABLE, fields);
    }

    return res.status(200).json({ ok: true, join_url: wf.join_url || null });
  } catch (e) {
    console.error("webinar-register error:", e.message);
    return res.status(500).json({ error: "Couldn't complete your registration. Please try again." });
  }
};
