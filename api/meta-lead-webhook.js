// Vercel serverless function: receives Meta (Facebook/Instagram) Lead Ads
// notifications, fetches the full lead from the Graph API, lands the lead
// in Airtable, pushes it to Campaign Nucleus for email follow-up, and
// fires Meta CAPI "Lead" for attribution.
//
// Setup on the Meta side (one-time):
//   1. developers.facebook.com → create / pick an App
//   2. Add the "Webhooks" product. Subscribe to object type "Page",
//      field "leadgen". Callback URL: https://<your-domain>/api/meta-lead-webhook
//      Verify Token: any random string you make up.
//   3. Settings → Basic → copy the App Secret.
//   4. Tools → Graph API Explorer → generate a long-lived Page Access
//      Token for the Page that hosts your Lead Ads. (Needs scopes:
//      pages_show_list, leads_retrieval, pages_manage_metadata.)
//   5. Subscribe the Page to the App for the leadgen field.
//      curl -X POST -F "subscribed_fields=leadgen" -F "access_token={PAGE_TOKEN}" \
//        https://graph.facebook.com/v21.0/{PAGE_ID}/subscribed_apps
//   6. For each Lead Form, grab its form_id from Meta Business Suite →
//      Instant Forms (or via Graph API). Add to META_LEAD_FORM_MAP.
//   7. Test from Meta's Lead Ads Testing tool:
//      https://developers.facebook.com/tools/lead-ads-testing
//
// Required environment variables:
//   META_APP_SECRET            X-Hub-Signature-256 verification
//   META_PAGE_ACCESS_TOKEN     fetching lead details from Graph API
//   META_WEBHOOK_VERIFY_TOKEN  any random string; must match the value you
//                              set in the Meta App's webhook config
//   META_LEAD_FORM_MAP         JSON map: form_id → petition_slug. E.g.
//                              {"123456":"hold-the-gate","789012":"baldwins"}
//   CN_RECEIVER_URLS           JSON map: petition_slug → Campaign Nucleus
//                              form-receiver URL. E.g.
//                              {"hold-the-gate":"https://teller.campaignnucleus.com/forms/receiver/abc",
//                               "baldwins":"https://teller.campaignnucleus.com/forms/receiver/def",
//                               "_default":"https://teller.campaignnucleus.com/forms/receiver/xyz"}

const crypto = require("crypto");
const {
  matchOrCreateContact,
  setReferralCodeIfMissing,
  logEventIdempotent,
} = require("./_airtable");
const { postEvent: postMetaEvent } = require("./_meta");
const { normalizeLeadFields } = require("./_lead-fields");

const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const GRAPH_VERSION = "v21.0";

function parseJsonEnv(name) {
  try { return JSON.parse(process.env[name] || "{}"); } catch { return {}; }
}

// Raw body required for X-Hub-Signature-256 verification.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyMetaSignature(rawBody, header, secret) {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length);
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fetchLead(leadgenId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?fields=id,created_time,ad_id,form_id,field_data,campaign_id,adset_id,platform&access_token=${PAGE_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Meta lead fetch ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function pushToCampaignNucleus(receiverUrl, fields, attribution) {
  if (!receiverUrl) return { skipped: "no CN URL configured" };
  const body = new URLSearchParams({
    first_name: fields.first_name || "",
    last_name: fields.last_name || "",
    email: fields.email || "",
    phone: fields.mobile || "",
    postcode: fields.postcode || "",
    source: "meta_lead_ad",
    ...attribution,
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

async function processOneLead({ leadId, formId, adId, adsetId, formMap, cnUrls, originRequest }) {
  const lead = await fetchLead(leadId);
  const fields = normalizeLeadFields(lead.field_data);
  if (!fields.email && !fields.mobile) {
    console.error(`Meta lead ${leadId} has no email or mobile, skipping`);
    return { leadId, skipped: "no contact fields" };
  }

  const petitionSlug = formMap[String(formId)] || formMap[formId] || null;
  const cnUrl = (petitionSlug && cnUrls[petitionSlug]) || cnUrls._default || "";

  // 1. Match or create contact
  const { record, isNew } = await matchOrCreateContact({
    ...fields,
    source_channel: "Facebook",
  });
  const contactRecordId = record.id;
  const contactUuid = record.fields.contact_id;
  const referralCode = await setReferralCodeIfMissing(contactRecordId, record.fields);

  // 2. Append-only Events log (idempotent on lead_id so Meta retries dedup)
  const metaEventId = `meta_lead_${leadId}`;
  await logEventIdempotent({
    contactRecordId,
    event_type: "Petition Signed",
    payload: {
      source: "meta_lead_ad",
      leadgen_id: leadId,
      form_id: formId,
      ad_id: adId,
      adset_id: adsetId,
      campaign_id: lead.campaign_id,
      platform: lead.platform,
      petition_slug: petitionSlug,
      field_data: lead.field_data,
      ...fields,
    },
    source_channel: "Facebook",
    meta_event_id: metaEventId,
  });

  // 3. Push to Campaign Nucleus (per-petition or default).
  const cnResult = await pushToCampaignNucleus(cnUrl, fields, {
    meta_lead_id: leadId,
    meta_form_id: formId,
    meta_ad_id: adId,
    meta_campaign_id: lead.campaign_id,
    petition_slug: petitionSlug || "",
  });

  // 4. Fire Meta CAPI "Lead" for ad attribution.
  try {
    await postMetaEvent({
      event_name: "Lead",
      event_id: metaEventId,
      event_source_url: "https://www.farmersfightback.com/",
      action_source: "system_generated",
      user_data: {
        em: fields.email,
        ph: fields.mobile,
        fn: fields.first_name,
        ln: fields.last_name,
        zp: fields.postcode,
        country: "au",
        external_id: contactUuid,
      },
    });
  } catch (e) {
    console.error("Meta CAPI Lead failed:", e.message);
  }

  return {
    leadId,
    contact_id: contactUuid,
    referral_code: referralCode,
    is_new_contact: isNew,
    petition_slug: petitionSlug,
    cn: cnResult,
  };
}

module.exports = async function handler(req, res) {
  // Meta's webhook subscription handshake.
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(challenge || "");
    }
    return res.status(403).json({ error: "Verification failed" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  if (!APP_SECRET || !PAGE_TOKEN || !VERIFY_TOKEN) {
    console.error("Meta lead webhook misconfigured: missing one of META_APP_SECRET, META_PAGE_ACCESS_TOKEN, META_WEBHOOK_VERIFY_TOKEN");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  let raw;
  try { raw = await readRawBody(req); } catch (e) { return res.status(400).send("Failed to read body"); }
  if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"], APP_SECRET)) {
    return res.status(401).send("Invalid signature");
  }

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("Invalid JSON"); }

  const formMap = parseJsonEnv("META_LEAD_FORM_MAP");
  const cnUrls = parseJsonEnv("CN_RECEIVER_URLS");

  // Collect all leadgen changes from the batch and process in parallel.
  const tasks = [];
  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== "leadgen") continue;
      const v = change.value || {};
      if (!v.leadgen_id) continue;
      tasks.push(processOneLead({
        leadId: v.leadgen_id,
        formId: v.form_id,
        adId: v.ad_id,
        adsetId: v.adgroup_id,
        formMap,
        cnUrls,
      }).catch((e) => ({ error: e.message, leadId: v.leadgen_id })));
    }
  }

  try {
    const results = await Promise.all(tasks);
    return res.status(200).json({ received: true, processed: results });
  } catch (err) {
    console.error("meta-lead-webhook error:", err);
    // Return 500 → Meta retries with backoff (up to ~36 hours).
    return res.status(500).json({ error: "Processing failed" });
  }
};
