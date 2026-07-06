// Cellcast SMS client + message templates + the signup-SMS enqueue rule
// (Workstream 1). Sends are queued into the Airtable "SMS Sends" table and
// dispatched by /api/cron/sms-queue; nothing here blocks a signup.
//
// Env:
//   CELLCAST_API_KEY   Cellcast v1 API key (sent as Authorization: Bearer).
//                      Absent => enqueue still works, dispatch no-ops with a
//                      logged warning (ship dark).
//   CELLCAST_API_BASE  optional override, default https://api.cellcast.com/api/v1
//   CELLCAST_FROM      optional sender id (alpha <=11 chars, or numeric).
//                      NOTE: an alpha sender is one-way — replies (incl. STOP)
//                      don't come back, so leave unset to use the shared number
//                      if you rely on the get-responses STOP poll.
//   AB_FORCE_VARIANT   off | A | B — force new sends to the winning variant
//   SMS_INCLUDE_CONTACT_REF  "0" to never append ?c=<code> to links

const {
  normPhone,
  findContactByMobile,
  findOne,
  createRow,
  nowIso,
  uuid,
} = require("./_airtable");
const { phoneHash, scheduleSignupSMS, clampToQuietHours } = require("./_util");

const SMS_SENDS_TABLE = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const GSM_LIMIT = 160;
// Cellcast v1 REST API. Bearer-authenticated; base overridable for staging.
const CELLCAST_BASE = (process.env.CELLCAST_API_BASE || "https://api.cellcast.com/api/v1").replace(/\/$/, "");

// Final copy from the brief (v2). {first} merged at enqueue time; {link}
// gets ?c=<referral_code> appended only when the merged message still fits
// in one 160-char segment.
const TEMPLATES = {
  signup_ab: {
    A: { link: "farmersfightback.com/fund",
      text: "{first}, Ben Duxson from Farmers Fightback. Thanks for signing. Chip in to keep the fight alive: {link} Reply STOP to opt out" },
    B: { link: "farmersfightback.com/fight",
      text: "{first}, VNI West is carving up Australia's food bowl. Help Farmers Fightback make the Govt listen: {link} Reply STOP to opt out" },
  },
  donation_lapse_24h: {
    A: { link: "farmersfightback.com/fund",
      text: "{first}, you were one click from backing Aussie farmers yesterday. Finish what you started: {link} Reply STOP to opt out" },
    B: { link: "farmersfightback.com/fund",
      text: "{first}, you were one click from backing Aussie farmers yesterday. Finish what you started: {link} Reply STOP to opt out" },
  },
};

function renderSMS(template, variant, { first_name, cref } = {}) {
  const t = (TEMPLATES[template] || {})[variant];
  if (!t) return null;
  const first = String(first_name || "").trim().split(/\s+/)[0] || "Friend";
  const base = t.text.replace("{first}", first).replace("{link}", t.link);
  if (cref && process.env.SMS_INCLUDE_CONTACT_REF !== "0") {
    const withRef = t.text.replace("{first}", first).replace("{link}", `${t.link}?c=${cref}`);
    if (withRef.length <= GSM_LIMIT) return withRef;
  }
  if (base.length > GSM_LIMIT) {
    console.warn(`SMS ${template}/${variant} is ${base.length} chars (>160) after merge`);
  }
  return base;
}

// Deterministic 50/50: last hex nibble parity of the phone hash.
function assignVariant(hash) {
  const forced = String(process.env.AB_FORCE_VARIANT || "off").toUpperCase();
  if (forced === "A" || forced === "B") return forced;
  return parseInt(hash.slice(-1), 16) % 2 === 0 ? "A" : "B";
}

async function sendViaCellcast({ phone, message }) {
  const key = process.env.CELLCAST_API_KEY;
  if (!key) return { skipped: true, reason: "CELLCAST_API_KEY not set" };
  const body = { message, contacts: [phone] };
  if (process.env.CELLCAST_FROM) body.sender = process.env.CELLCAST_FROM;
  const r = await fetch(`${CELLCAST_BASE}/gateway`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  // v1 gateway: { status:true, data:{ queueResponse:[{MessageId,...}],
  // invalidContacts, unsubscribeContacts } }. Low balance => 422 status:false;
  // bad token => 401 {code:401,message:"Token expired"}. A queued send always
  // returns a MessageId — its absence (invalid/unsubscribed/low balance) is a
  // non-send, so surface it as an error rather than record a phantom send.
  if (!r.ok || json.status !== true) {
    return { ok: false, status: r.status, error: JSON.stringify(json).slice(0, 300) };
  }
  const q = json.data?.queueResponse?.[0] || {};
  if (!q.MessageId) {
    return { ok: false, status: r.status, error: JSON.stringify(json.data || json).slice(0, 300) };
  }
  return { ok: true, cellcast_id: q.MessageId };
}

// One automation text per signer, ever: dedupe on phone hash + template
// regardless of status (a failed row still counts as "we tried").
async function alreadyQueued(hash, template) {
  const existing = await findOne(
    SMS_SENDS_TABLE,
    `AND({phone_hash}='${hash}', {template}='${template}')`
  );
  return !!existing;
}

// Called from petition-signup after a successful signup. Never throws.
// Skips: no mobile, existing donors (they get WS5 treatment), opted-out
// contacts, and anyone who has ever been queued a signup text.
async function enqueueSignupSMS({ contactFields, mobile, first_name }) {
  try {
    const phone = normPhone(mobile);
    if (!phone || !phone.startsWith("+")) return { skipped: "no valid mobile" };
    const status = contactFields?.status?.name || contactFields?.status || "";
    if (status === "Donor Only" || status === "Signatory + Donor") return { skipped: "existing donor" };
    if (contactFields?.sms_opt_out) return { skipped: "opted out" };
    const hash = phoneHash(phone);
    if (await alreadyQueued(hash, "signup_ab")) return { skipped: "already queued" };

    const variant = assignVariant(hash);
    const message = renderSMS("signup_ab", variant, {
      first_name,
      cref: contactFields?.referral_code || "",
    });
    const notBefore = scheduleSignupSMS();
    await createRow(SMS_SENDS_TABLE, {
      send_id: uuid(),
      phone,
      phone_hash: hash,
      template: "signup_ab",
      variant,
      message,
      status: "queued",
      not_before: notBefore.toISOString(),
      queued_at: nowIso(),
    });
    return { queued: true, variant, not_before: notBefore.toISOString() };
  } catch (e) {
    console.error("enqueueSignupSMS failed:", e.message);
    return { error: e.message };
  }
}

// Queue the +24h donation-lapse nudge (WS4.4). Dedupe per phone+template.
async function enqueueDonationLapseSMS({ mobile, first_name, referral_code, baseTime }) {
  try {
    const phone = normPhone(mobile);
    if (!phone || !phone.startsWith("+")) return { skipped: "no valid mobile" };
    const contact = await findContactByMobile(phone).catch(() => null);
    if (contact?.fields?.sms_opt_out) return { skipped: "opted out" };
    const hash = phoneHash(phone);
    if (await alreadyQueued(hash, "donation_lapse_24h")) return { skipped: "already queued" };
    const at = clampToQuietHours(new Date((baseTime ? new Date(baseTime) : new Date()).getTime() + 24 * 3600 * 1000));
    await createRow(SMS_SENDS_TABLE, {
      send_id: uuid(),
      phone,
      phone_hash: hash,
      template: "donation_lapse_24h",
      variant: "A",
      message: renderSMS("donation_lapse_24h", "A", { first_name, cref: referral_code || "" }),
      status: "queued",
      not_before: at.toISOString(),
      queued_at: nowIso(),
    });
    return { queued: true };
  } catch (e) {
    console.error("enqueueDonationLapseSMS failed:", e.message);
    return { error: e.message };
  }
}

module.exports = {
  SMS_SENDS_TABLE,
  renderSMS,
  assignVariant,
  sendViaCellcast,
  enqueueSignupSMS,
  enqueueDonationLapseSMS,
};
