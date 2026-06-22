// Vercel serverless function: generic capture for any interaction —
// surveys, RSVPs, partial form abandons, and Zapier-relayed Meta Lead
// Ads submissions. Writes to Airtable Events with identity ladder
// match-or-create. Does NOT fire Meta — wire the specific event types
// you want optimised through their own routes.
//
// Optional Campaign Nucleus push: if the body (or body.payload) includes
// petition_slug, AND CN_RECEIVER_URLS env var holds a mapping for that
// slug, the contact is form-encoded and POSTed to the matching CN
// receiver URL for email follow-up automation. Failures don't break the
// Airtable write — CN push is best-effort.
//
// POST /api/event-log
// Body (JSON):
//   event_type (required) — one of the Events.event_type select choices
//   email | mobile        — at least one needed for identity match
//   first_name, last_name, postcode, fbclid, fbp, ref, source_channel
//   payload               — anything; defaults to the whole body
//   payload.petition_slug — optional, triggers CN push if mapped
//
// Env:
//   CN_RECEIVER_URLS — JSON: {"hold-the-gate":"https://...","baldwins":"https://...","_default":"..."}

const {
  matchOrCreateContact,
  setReferralCodeIfMissing,
  logEvent,
  updateContactStatusFromEvent,
} = require("./_airtable");

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

function parseCNUrls() {
  try { return JSON.parse(process.env.CN_RECEIVER_URLS || "{}"); } catch { return {}; }
}

function pickPetitionSlug(body, payload) {
  // Look in the most obvious places — payload.petition_slug (canonical),
  // top-level petition_slug (shortcut for simpler integrations).
  const inPayload = payload && typeof payload === "object" ? payload.petition_slug : null;
  return inPayload || body.petition_slug || null;
}

async function pushToCampaignNucleus(receiverUrl, fields, extra) {
  if (!receiverUrl) return null;
  const body = new URLSearchParams({
    first_name: fields.first_name || "",
    last_name: fields.last_name || "",
    email: fields.email || "",
    phone: fields.mobile || "",
    postcode: fields.postcode || "",
    ...(extra || {}),
  });
  try {
    const r = await fetch(receiverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error("CN push failed:", e.message);
    return { ok: false, error: e.message };
  }
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
      event_type,
      payload,
      source_channel,
      ref,
    } = body;
    if (!event_type) return res.status(400).json({ error: "event_type required" });

    // Some upstream relays (notably the two Zapier Lead Ads connectors) put
    // the lead's identity fields at the top level of the body, others nest
    // them under payload.lead_data, others put them in payload.* directly.
    // Read all three so contact creation works no matter the shape.
    const p = (payload && typeof payload === "object") ? payload : {};
    const ld = (p.lead_data && typeof p.lead_data === "object") ? p.lead_data : {};
    const firstNonEmpty = (...keys) => {
      for (const k of keys) {
        if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k];
        if (ld[k]   !== undefined && ld[k]   !== null && ld[k]   !== "") return ld[k];
        if (p[k]    !== undefined && p[k]    !== null && p[k]    !== "") return p[k];
      }
      return undefined;
    };
    const first_name = firstNonEmpty("first_name");
    const last_name = firstNonEmpty("last_name");
    const email = firstNonEmpty("email");
    const mobile = firstNonEmpty("mobile", "phone", "phone_number");
    const postcode = firstNonEmpty("postcode", "post_code", "zip", "zip_code", "postal_code");
    const fbclid = firstNonEmpty("fbclid");
    const fbp = firstNonEmpty("fbp");

    if (!email && !mobile && !(first_name && last_name && postcode)) {
      return res
        .status(400)
        .json({ error: "email, mobile, or first+last+postcode required" });
    }

    // Distinguish Meta Lead Ads from any other Facebook-tagged interaction
    // (e.g. a fbclid-bearing landing) so reports can isolate paid-form
    // submissions from organic FB referrals. Overrides whatever the Zap
    // (or other caller) sent for source_channel.
    const isMetaLead = String(p.source || "").toLowerCase() === "meta_lead_ad";
    const effectiveSourceChannel = isMetaLead ? "Meta Lead" : source_channel;

    const { record } = await matchOrCreateContact({
      first_name,
      last_name,
      email,
      mobile,
      postcode,
      fbclid,
      fbp,
      source_channel: effectiveSourceChannel,
    });

    // Ensure every contact (web form, Meta lead via Zapier, survey, etc.)
    // gets a referral_code so they can participate in the share-with-friends
    // loop. Petition-signup did this already; bring event-log into line.
    try {
      await setReferralCodeIfMissing(record.id, record.fields);
    } catch (e) {
      console.error("referral_code set failed:", e.message);
    }

    const eventRecord = await logEvent({
      contactRecordId: record.id,
      event_type,
      payload: payload || body,
      fbclid,
      referral_code_used: ref || undefined,
      source_channel: effectiveSourceChannel || undefined,
    });

    try {
      await updateContactStatusFromEvent(
        record.id,
        event_type,
        record.fields.status
      );
    } catch (e) {
      console.error("status update failed:", e.message);
    }

    // Optional Campaign Nucleus push for Zapier-relayed Meta leads (and
    // any other inbound that supplies a petition_slug we have a CN URL
    // mapping for). Best-effort — failure here doesn't fail the request.
    let cn_result = null;
    const petitionSlug = pickPetitionSlug(body, payload);
    if (petitionSlug) {
      const cnUrls = parseCNUrls();
      const cnUrl = cnUrls[petitionSlug] || cnUrls._default || "";
      if (cnUrl) {
        cn_result = await pushToCampaignNucleus(cnUrl, {
          first_name, last_name, email, mobile, postcode,
        }, {
          source: p.source || "event-log",
          petition_slug: petitionSlug,
          meta_lead_id: p.leadgen_id || ld.id || p.id || "",
          meta_form_id: p.form_id || ld.form_id || "",
          meta_ad_id: p.ad_id || ld.ad_id || "",
        });
      }
    }

    return res.status(200).json({
      success: true,
      contact_id: record.fields.contact_id,
      event_id: eventRecord.fields.event_id,
      cn: cn_result,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("event-log error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
