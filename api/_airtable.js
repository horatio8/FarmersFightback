// Shared Airtable client + identity matching + event logging.
// Used by /api/petition-signup, /api/event-log, and /api/stripe-webhook.
//
// Env:
//   AIRTABLE_API_KEY          Personal access token with data:read + data:write
//   AIRTABLE_BASE_ID          e.g. app8m8laqgIClPw2Z
//   AIRTABLE_CONTACTS_TABLE   default "Contacts"
//   AIRTABLE_EVENTS_TABLE     default "Events"

const crypto = require("crypto");

const BASE = process.env.AIRTABLE_BASE_ID;
const KEY = process.env.AIRTABLE_API_KEY;
const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";
const API = "https://api.airtable.com/v0";

function uuid() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}
function normEmail(e) {
  return e ? String(e).trim().toLowerCase() : "";
}
function normPhone(p) {
  if (!p) return "";
  const trimmed = String(p).trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (hasPlus) return "+" + digits;
  // Australian mobile heuristics — assume AU if 0-leading 10 digits.
  if (digits.length === 10 && digits.startsWith("0")) return "+61" + digits.slice(1);
  if (digits.startsWith("61") && digits.length === 11) return "+" + digits;
  return digits;
}
function normLower(s) {
  return s ? String(s).trim().toLowerCase() : "";
}
function escapeFormula(s) {
  // Single quotes wrap formula strings — escape the only character that breaks them.
  return String(s).replace(/'/g, "\\'");
}

async function atFetch(path, opts = {}) {
  if (!BASE || !KEY) {
    const err = new Error("AIRTABLE_BASE_ID or AIRTABLE_API_KEY not set");
    err.code = "MISCONFIGURED";
    throw err;
  }
  const r = await fetch(`${API}/${BASE}/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`Airtable ${r.status}: ${body.slice(0, 500)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function findOne(tableName, formula) {
  const params = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: "1",
    pageSize: "1",
  });
  const r = await atFetch(`${encodeURIComponent(tableName)}?${params}`);
  return r.records && r.records[0] ? r.records[0] : null;
}

async function findContactByEmail(email) {
  const e = normEmail(email);
  if (!e) return null;
  return findOne(CONTACTS, `LOWER({email})='${escapeFormula(e)}'`);
}
async function findContactByMobile(mobile) {
  const m = normPhone(mobile);
  if (!m) return null;
  return findOne(CONTACTS, `{mobile}='${escapeFormula(m)}'`);
}
async function findContactByNamePostcode(first, last, postcode) {
  const f = normLower(first);
  const l = normLower(last);
  const p = (postcode || "").trim();
  if (!f || !l || !p) return null;
  const formula = `AND(LOWER({first_name})='${escapeFormula(f)}',LOWER({last_name})='${escapeFormula(l)}',{postcode}='${escapeFormula(p)}')`;
  return findOne(CONTACTS, formula);
}
async function findContactByReferralCode(code) {
  if (!code) return null;
  return findOne(CONTACTS, `{referral_code}='${escapeFormula(String(code).toUpperCase())}'`);
}
async function findEventByMetaEventId(metaEventId) {
  if (!metaEventId) return null;
  return findOne(EVENTS, `{meta_event_id}='${escapeFormula(metaEventId)}'`);
}

// Visually unambiguous Crockford-style alphabet (no 0/O, 1/I/L).
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function makeReferralCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}
async function generateUniqueReferralCode(maxTries = 8) {
  for (let i = 0; i < maxTries; i++) {
    const code = makeReferralCode();
    // eslint-disable-next-line no-await-in-loop
    const exists = await findContactByReferralCode(code);
    if (!exists) return code;
  }
  return makeReferralCode(8);
}

async function createContact(fields) {
  const r = await atFetch(encodeURIComponent(CONTACTS), {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return r.records[0];
}
async function updateContact(recordId, fields) {
  return atFetch(`${encodeURIComponent(CONTACTS)}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });
}

// Identity ladder: email → mobile → name+postcode → create.
// On match: backfill empty fields, refresh last_updated, preserve first-touch values.
async function matchOrCreateContact(input) {
  const email = normEmail(input.email);
  const mobile = normPhone(input.mobile);
  const first = (input.first_name || "").trim();
  const last = (input.last_name || "").trim();
  const postcode = (input.postcode || "").trim();

  let found = null;
  if (email) found = await findContactByEmail(email);
  if (!found && mobile) found = await findContactByMobile(mobile);
  if (!found && first && last && postcode) found = await findContactByNamePostcode(first, last, postcode);

  if (found) {
    const cur = found.fields || {};
    const patch = { last_updated: nowIso() };
    const fillIfMissing = (k, v) => {
      if (v && !cur[k]) patch[k] = v;
    };
    fillIfMissing("first_name", first);
    fillIfMissing("last_name", last);
    fillIfMissing("email", email);
    fillIfMissing("mobile", mobile);
    fillIfMissing("postcode", postcode);
    fillIfMissing("fbclid", input.fbclid);
    fillIfMissing("fbp", input.fbp);
    fillIfMissing("first_source_channel", input.source_channel);
    await updateContact(found.id, patch);
    // Reflect the patch locally for callers that read fields after the call.
    found.fields = { ...cur, ...patch };
    return { record: found, isNew: false };
  }

  const fields = {
    contact_id: uuid(),
    first_name: first || undefined,
    last_name: last || undefined,
    email: email || undefined,
    mobile: mobile || undefined,
    postcode: postcode || undefined,
    fbclid: input.fbclid || undefined,
    fbp: input.fbp || undefined,
    first_source_channel: input.source_channel || undefined,
    date_first_seen: nowIso(),
    last_updated: nowIso(),
  };
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
  const created = await createContact(fields);
  return { record: created, isNew: true };
}

async function setReferralCodeIfMissing(recordId, currentFields) {
  if (currentFields && currentFields.referral_code) return currentFields.referral_code;
  const code = await generateUniqueReferralCode();
  await updateContact(recordId, { referral_code: code });
  return code;
}

async function linkReferredBy(newContactRecordId, referrerRecordId) {
  return updateContact(newContactRecordId, { referred_by: [referrerRecordId] });
}

async function logEvent({ contactRecordId, event_type, payload, fbclid, referral_code_used, source_channel, meta_event_id, timestamp }) {
  const fields = {
    event_id: uuid(),
    contact: contactRecordId ? [contactRecordId] : undefined,
    event_type,
    timestamp: timestamp || nowIso(),
    payload: typeof payload === "string" ? payload : JSON.stringify(payload || {}),
    fbclid: fbclid || undefined,
    referral_code_used: referral_code_used ? String(referral_code_used).toUpperCase() : undefined,
    source_channel: source_channel || undefined,
    meta_event_id: meta_event_id || undefined,
  };
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
  const r = await atFetch(encodeURIComponent(EVENTS), {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return r.records[0];
}

// Skip insert if an event with the same meta_event_id already exists — used by
// the Stripe webhook so retries don't double-log.
async function logEventIdempotent(args) {
  if (args.meta_event_id) {
    const existing = await findEventByMetaEventId(args.meta_event_id);
    if (existing) return existing;
  }
  return logEvent(args);
}

function nextStatusFromEvent(eventType, currentStatus) {
  const isSign = eventType === "Petition Signed";
  const isDonate = eventType === "Donation";
  if (!isSign && !isDonate) return currentStatus;
  const cur = currentStatus && currentStatus.name ? currentStatus.name : currentStatus;
  if (isSign) {
    if (cur === "Donor Only" || cur === "Signatory + Donor") return "Signatory + Donor";
    return "Signatory Only";
  }
  if (cur === "Signatory Only" || cur === "Signatory + Donor") return "Signatory + Donor";
  return "Donor Only";
}

async function updateContactStatusFromEvent(contactRecordId, eventType, currentStatus) {
  const next = nextStatusFromEvent(eventType, currentStatus);
  if (!next) return null;
  const cur = currentStatus && currentStatus.name ? currentStatus.name : currentStatus;
  if (next === cur) return next;
  await updateContact(contactRecordId, { status: next });
  return next;
}

module.exports = {
  matchOrCreateContact,
  findContactByReferralCode,
  setReferralCodeIfMissing,
  linkReferredBy,
  logEvent,
  logEventIdempotent,
  updateContactStatusFromEvent,
  normEmail,
  normPhone,
  uuid,
  nowIso,
};
