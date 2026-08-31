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
const { enqueueSignupSMS } = require("./_cellcast");

// Where a signer lands after the main petition, decided HERE per signer so
// the split is owner-tunable without touching code:
//
//   PETITION_SHARE_PERCENT = 0..100
//
// That percentage of signers is sent to /share (the referral/share page);
// the rest get the /donate ask. Unset or invalid means 0 -- everyone to the
// donation ask, the long-standing behaviour. Examples: 70 sends roughly 70
// of every 100 signers to /share; 100 sends everyone.
//
// NOTE for whoever flips it: Vercel bakes env vars into a deployment, so
// after changing the value in Settings -> Environment Variables you must hit
// Redeploy for it to take effect. The variable can be set differently for
// Preview and Production, so a split can be trialled on preview first.
//
// The verdict rides back to the browser as thanks_destination in the signup
// response, and into the Petition Signed event payload so each arm's
// donations can be measured afterwards.
function rollThanksDestination(rand = Math.random()) {
  const raw = Number(process.env.PETITION_SHARE_PERCENT);
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  return rand * 100 < pct ? "/share" : "/donate";
}

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
          // Share Conversion = a recipient who arrived via the referrer's
          // link AND actually signed. Share Click (load-only) is logged
          // separately by /api/share-click when the petition page loads
          // with ?ref= present.
          await logEvent({
            contactRecordId: referrerRecordId,
            event_type: "Share Conversion",
            payload: {
              recruited_contact_id: contactUuid,
              ref_code: String(ref).toUpperCase(),
            },
            referral_code_used: ref,
            source_channel: "Referral",
          }).catch((e) => console.error("Share Conversion log:", e.message));
        }
      } catch (e) {
        console.error("referral resolution failed:", e.message);
      }
    }

    const metaEventId = `petition_${contactUuid}_${Date.now()}`;
    const thanksDestination = rollThanksDestination();

    // The Contact is already saved by this point, so a failure here loses the
    // log entry, not the supporter — and must not be allowed to fail the
    // request. It was allowed to once: on 17-18 Aug 2026 the Events table hit
    // its record ceiling, this line threw, and every signup returned an error
    // for 25 hours to people whose details were sitting safely in Airtable.
    // The log has its own base now; this makes the next such failure a gap in
    // the log rather than an outage.
    await logEvent({
      contactRecordId,
      event_type: "Petition Signed",
      // Full raw request body — anything the frontend posts is captured,
      // including fields we don't currently parse (consent, country,
      // campaign, additional utm_* params, future form fields, etc.).
      payload: { ...body, thanks_destination: thanksDestination },
      fbclid,
      referral_code_used: ref || undefined,
      source_channel: channel,
      meta_event_id: metaEventId,
    }).catch((e) => console.error("Petition Signed log failed (contact saved):", e.message));

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

    // Workstream 1: queue the post-signup SMS (15-55s delay, quiet hours,
    // A/B assigned, one-per-signer-ever, donors + opt-outs skipped).
    // Never blocks or fails the signup.
    let sms = null;
    if (mobile) {
      sms = await enqueueSignupSMS({
        contactFields: { ...record.fields, referral_code: referralCode },
        mobile,
        first_name,
      }).catch((e) => ({ error: e.message }));
    }

    return res.status(200).json({
      success: true,
      contact_id: contactUuid,
      referral_code: referralCode,
      meta_event_id: metaEventId,
      is_new_contact: isNew,
      thanks_destination: thanksDestination,
      sms,
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

module.exports.rollThanksDestination = rollThanksDestination;
