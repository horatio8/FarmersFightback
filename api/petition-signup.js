// Vercel serverless function: native petition capture.
// - Identity ladder match-or-create in Airtable Contacts.
// - Generates/keeps a referral code for this contact (for share URLs).
// - Resolves inbound ?ref= → links referred_by + logs Share Click on the
//   referrer.
// - Logs a Petition Signed event in Airtable Events.
// - Fires Meta Conversions API "Lead" with the same event_id the browser
//   pixel uses, so they dedupe in Meta Events Manager.
//
// POST /api/petition-signup
// Body (JSON):
//   first_name, last_name, email, mobile, postcode, fbclid, fbp, ref,
//   utm_source, utm_medium, utm_campaign
// Response (JSON): { success, contact_id, referral_code, meta_event_id, is_new_contact }

const {
  matchOrCreateContact,
  findContactByReferralCode,
  setReferralCodeIfMissing,
  linkReferredBy,
  logEvent,
  updateContactStatusFromEvent,
} = require("./_airtable");
const { postEvent } = require("./_meta");

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
  // Per-deployment preview URLs: <project>-<hash>-tellerconsulting.vercel.app
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    const {
      first_name,
      last_name,
      email,
      mobile,
      postcode,
      fbclid,
      fbp,
      ref,
      utm_source,
    } = body;

    if (!email && !mobile) {
      return res.status(400).json({ error: "email or mobile required" });
    }

    const channel = fbclid
      ? "Facebook"
      : ref
      ? "Referral"
      : utm_source
      ? "Other"
      : "Direct";

    const { record, isNew } = await matchOrCreateContact({
      first_name,
      last_name,
      email,
      mobile,
      postcode,
      fbclid,
      fbp,
      source_channel: channel,
    });
    const contactRecordId = record.id;
    const contactUuid = record.fields.contact_id;

    const referralCode = await setReferralCodeIfMissing(contactRecordId, record.fields);

    let referrerRecordId = null;
    if (ref) {
      try {
        const referrer = await findContactByReferralCode(ref);
        if (referrer && referrer.id !== contactRecordId) {
          referrerRecordId = referrer.id;
          if (isNew) {
            await linkReferredBy(contactRecordId, referrerRecordId).catch((e) =>
              console.error("linkReferredBy:", e.message)
            );
          }
          await logEvent({
            contactRecordId: referrerRecordId,
            event_type: "Share Click",
            payload: {
              recruited_contact_id: contactUuid,
              ref_code: String(ref).toUpperCase(),
            },
            referral_code_used: ref,
            source_channel: "Referral",
          }).catch((e) => console.error("Share Click log:", e.message));
        }
      } catch (e) {
        console.error("referral resolution failed:", e.message);
      }
    }

    const metaEventId = `petition_${contactUuid}_${Date.now()}`;

    await logEvent({
      contactRecordId,
      event_type: "Petition Signed",
      payload: {
        first_name,
        last_name,
        email,
        mobile,
        postcode,
        fbclid,
        fbp,
        ref: ref || null,
      },
      fbclid,
      referral_code_used: ref || undefined,
      source_channel: channel,
      meta_event_id: metaEventId,
    });

    try {
      await updateContactStatusFromEvent(
        contactRecordId,
        "Petition Signed",
        record.fields.status
      );
    } catch (e) {
      console.error("status update failed:", e.message);
    }

    // Fire Meta Lead. Don't fail the request if Meta has a transient issue —
    // we already have the durable record in Airtable.
    try {
      await postEvent({
        event_name: "Lead",
        event_id: metaEventId,
        event_source_url:
          req.headers.referer || "https://www.farmersfightback.com/",
        action_source: "website",
        user_data: {
          em: email,
          ph: mobile,
          fn: first_name,
          ln: last_name,
          zp: postcode,
          country: "au",
          external_id: contactUuid,
          fbc: fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined,
          fbp,
        },
        ip:
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress,
        userAgent: req.headers["user-agent"],
      });
    } catch (e) {
      console.error("Meta Lead fire failed:", e.message, e.detail || "");
    }

    return res.status(200).json({
      success: true,
      contact_id: contactUuid,
      referral_code: referralCode,
      meta_event_id: metaEventId,
      is_new_contact: isNew,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("petition-signup error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
