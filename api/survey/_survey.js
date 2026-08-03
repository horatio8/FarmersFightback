// Gatepost survey engine — shared server helpers (FF preview instance).
//
// Persists to two Airtable tables in the existing FF base (app8m8laqgIClPw2Z):
//   Survey Contacts   — one row per person, keyed by `uid` (the tokenised id)
//   Survey Responses  — one row per contact per survey, built up answer-by-answer
//
// Config is loaded by static require() so Vercel's file tracer bundles it.
// Adding a survey = one line in SURVEYS; adding a client = one line in CLIENTS.

const crypto = require("crypto");
const { findOne, listRows, createRow, updateRow, uuid, nowIso, normEmail, normPhone,
  findContactByReferralCode } = require("../_airtable");
const { maskRecord } = require("../_mask");

const SURVEY_CONTACTS = process.env.SURVEY_CONTACTS_TABLE || "Survey Contacts";
const SURVEY_RESPONSES = process.env.SURVEY_RESPONSES_TABLE || "Survey Responses";

// Static config registry (traced + bundled by Vercel).
const SURVEYS = {
  supporters: require("../../survey/config/supporters.survey.json"),
};
const CLIENTS = {
  "farmers-fightback": require("../../survey/config/farmers-fightback.client.json"),
};
// Preview: every survey maps to the one client.
const DEFAULT_CLIENT = "farmers-fightback";

function getSurvey(slug) {
  return SURVEYS[String(slug || "").toLowerCase()] || null;
}
function getClient() {
  return CLIENTS[DEFAULT_CLIENT];
}

// URL-safe, non-sequential, non-guessable. base64url of 80 random bits ≈ 14 chars.
function makeUid() {
  return crypto.randomBytes(10).toString("base64url");
}

// Formula-string escape (single quote is the only char that breaks it).
function esc(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// The src value the Responses.src singleSelect accepts.
function normSrc(src, hadUid) {
  const s = String(src || "").toLowerCase();
  if (["email", "sms", "social", "fallback"].includes(s)) return s;
  return hadUid ? "email" : "social";
}

function detectDevice(ua) {
  const s = String(ua || "").toLowerCase();
  if (/ipad|tablet/.test(s)) return "tablet";
  if (/mobi|android|iphone/.test(s)) return "mobile";
  return "desktop";
}

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://survey.farmersfightback.com",
  "https://go.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
]);
// Returns true if the request should proceed (and sets CORS headers). Returns
// false only for a preflight OPTIONS, which the caller should 204.
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  let allow = null;
  if (ALLOWED_ORIGINS.has(origin)) allow = origin;
  else if (origin.endsWith("-tellerconsulting.vercel.app")) allow = origin;
  else if (origin.endsWith(".farmersfightback.com")) allow = origin;
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return req.method !== "OPTIONS";
}

function readBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

// ---- Contacts -----------------------------------------------------------

async function findContactByUid(uid) {
  const u = String(uid || "").trim();
  if (!u) return null;
  return findOne(SURVEY_CONTACTS, `{uid}='${esc(u)}'`);
}

// Adopt a uid that is really a CRM referral code.
//
// The tokenised link carries whatever sits in the CN profile's
// FarmersFightback_UID field, which we populate with the contact's
// referral_code. The first time such a link is opened there is no Survey
// Contact yet, so mirror the CRM record into one keyed by that same code. From
// then on findContactByUid() hits directly and this never runs again.
//
// Returns null when the code matches nobody, which the caller treats exactly
// like a bad token: the neutral capture screen, no enumeration signal.
async function adoptContactByReferralCode(code) {
  const c = String(code || "").trim();
  if (!c) return null;
  const crm = await findContactByReferralCode(c);
  if (!crm) return null;

  const f = crm.fields || {};
  // Store the code as the uid so the link keeps working and one link serves
  // both survey identity and referral attribution.
  return createSurveyContact({
    uid: c.toUpperCase(),
    first_name: f.first_name || undefined,
    last_name: f.last_name || undefined,
    email: f.email || undefined,
    mobile: f.mobile || undefined,
    postcode: f.postcode || undefined,
    token_source: "crm",
    cn_profile_ref: f.contact_id || undefined,
    created_at: nowIso(),
    last_seen_at: nowIso(),
  });
}
async function findSurveyContactByEmail(email) {
  const e = normEmail(email);
  if (!e) return null;
  return findOne(SURVEY_CONTACTS, `LOWER({email})='${esc(e)}'`);
}
async function createSurveyContact(fields) {
  return createRow(SURVEY_CONTACTS, fields);
}
async function touchContact(recordId) {
  try { await updateRow(SURVEY_CONTACTS, recordId, { last_seen_at: nowIso() }); } catch (e) {
    console.error("touchContact:", e.message);
  }
}

// ---- Responses ----------------------------------------------------------

// The one active/most-recent response for this contact + survey. The contact's
// primary field is `uid`, so ARRAYJOIN({contact}) yields the uid.
async function findResponse(uid, slug) {
  const rows = await listRows(SURVEY_RESPONSES, {
    formula: `AND({survey_slug}='${esc(slug)}',ARRAYJOIN({contact})='${esc(uid)}')`,
    maxRecords: 5,
    sort: [{ field: "started_at", direction: "desc" }],
  });
  return rows[0] || null;
}

async function createResponse({ contactRecordId, slug, version, src, campaign, device }) {
  const fields = {
    response_id: uuid(),
    contact: contactRecordId ? [contactRecordId] : undefined,
    survey_slug: slug,
    survey_version: String(version || ""),
    status: "in_progress",
    src: src || undefined,
    campaign_code: campaign || undefined,
    started_at: nowIso(),
    device: device || undefined,
    raw_json: "{}",
  };
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
  return createRow(SURVEY_RESPONSES, fields);
}

// Map the cumulative answers object onto the Responses typed columns.
// `field` in survey config is exactly the Airtable column name. Arrays
// (multi-select) join to a comma string; scale stores as a number.
function answersToColumns(survey, answers) {
  const out = {};
  const numberFields = new Set();
  for (const screen of survey.screens || []) {
    if (!screen.field) continue;
    if (screen.type === "scale_1_5") numberFields.add(screen.field);
  }
  for (const [k, v] of Object.entries(answers || {})) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v.join(", ");
    } else if (numberFields.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const KNOWN_FIELDS = ["first_name", "last_name", "email", "mobile", "postcode"];

// Known contact data used for the greeting and for skip_if_known. Values are
// MASKED — the browser never receives the real ones.
//
// The token in the link is a bearer credential, and a referral code is one that
// supporters post publicly, so anyone holding a link is treated as its owner.
// Masking is what keeps that from being worth exploiting: a guessed or forwarded
// link yields "J***s" and "*******882", not a supporter record.
//
// Presence still carries the meaning it always did. A masked value is non-empty
// exactly when the real one was, so the client's isKnown() check is unchanged
// and skip_if_known keeps working without ever seeing a real value.
function knownFrom(contactFields) {
  return maskRecord(contactFields || {}, KNOWN_FIELDS);
}

// The real values, server-side only. Used to seed answers for questions we skip
// because we already know them — the client cannot do this any more, since all
// it holds is the mask, and writing "3***" into someone's postcode answer would
// corrupt the response.
function trueKnownFrom(contactFields) {
  const cf = contactFields || {};
  const out = {};
  KNOWN_FIELDS.forEach((k) => {
    if (cf[k] != null && String(cf[k]).trim() !== "") out[k] = String(cf[k]).trim();
  });
  return out;
}

// Answers for skipped-but-known questions, merged server-side into whatever the
// response already holds. Only fills gaps: a real answer the supporter gave
// always wins over the value on their contact record.
//
// Seeding is deliberately limited to screens whose answer field IS the known
// field (B1: field "postcode", skip_if_known "postcode"). B3 skips on
// skip_if_known "mobile" but answers into "mobile_optin", an SMS consent
// flag — knowing someone's number is not consent to text them, and writing
// their number in as the answer would both mistype the field and manufacture
// an opt-in they never gave. Anything where the two differ is skipped from the
// flow but left unanswered, which is what the client did before this moved
// server-side.
function seedKnownAnswers(survey, contactFields, answered) {
  const truth = trueKnownFrom(contactFields);
  const out = { ...(answered || {}) };
  (survey.screens || []).forEach((s) => {
    const key = s.skip_if_known;
    if (!key || !s.field || s.field !== key) return;
    if (truth[key] == null) return;
    if (out[s.field] != null && String(out[s.field]).trim() !== "") return;
    out[s.field] = truth[key];
  });
  return out;
}

// The one bootstrap object resolve.js and capture.js both return, so a
// token hit and a fallback capture land the client in exactly the same shape.
function bootstrapPayload({ survey, client, contactRecord, response }) {
  const cf = (contactRecord && contactRecord.fields) || {};
  let answered = {};
  const raw = (response && response.fields && response.fields.raw_json) || "";
  if (raw) { try { answered = JSON.parse(raw) || {}; } catch { answered = {}; } }
  // Deliberately NOT seeding skipped-but-known answers here. `answered` is
  // echoed to the browser for resume, so seeding at bootstrap would hand back
  // the real postcode and undo the masking two lines below. Seeding happens in
  // complete.js instead, at write time, where the value goes to Airtable and
  // nowhere else.

  return {
    ok: true,
    slug: survey.slug,
    version: survey.version,
    survey: { slug: survey.slug, version: survey.version, title: survey.title, intro: survey.intro, screens: survey.screens },
    brand: client.brand,
    copy: client.copy,
    cap: client.donation,
    needs_capture: false,
    // `name` greets them and is masked like everything else: "G'day J***s."
    contact: { name: knownFrom(cf).first_name || "", known: knownFrom(cf) },
    response_id: (response && response.fields && response.fields.response_id) || null,
    status: (response && response.fields && response.fields.status) || "in_progress",
    answered,
    src: (response && response.fields && response.fields.src) || null,
    campaign_code: (response && response.fields && response.fields.campaign_code) || null,
  };
}

module.exports = {
  SURVEY_CONTACTS,
  SURVEY_RESPONSES,
  knownFrom,
  trueKnownFrom,
  seedKnownAnswers,
  bootstrapPayload,
  getSurvey,
  getClient,
  makeUid,
  esc,
  normSrc,
  detectDevice,
  applyCors,
  readBody,
  findContactByUid,
  adoptContactByReferralCode,
  findSurveyContactByEmail,
  createSurveyContact,
  touchContact,
  findResponse,
  createResponse,
  answersToColumns,
  // re-exports for endpoints
  findOne,
  listRows,
  createRow,
  updateRow,
  uuid,
  nowIso,
  normEmail,
  normPhone,
};
