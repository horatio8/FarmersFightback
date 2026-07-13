// Shared helpers for the donor webinar registration system (spec §9).
// Underscore-prefixed => not deployed as a function.
//
// Signed stateless magic-link token:
//   token = base64url(JSON{c:contact_id, s:session_slug, x:expEpochSec})
//           + "." + base64url(HMAC-SHA256(payload_b64url, WEBINAR_TOKEN_SECRET))
// verifyToken returns { contact_id, session } or null (bad signature,
// expired, malformed). If WEBINAR_TOKEN_SECRET is unset verification fails
// closed — callers should 503 via isConfigured().
//
// Env:
//   WEBINAR_TOKEN_SECRET        HMAC signing secret (required)
//   AIRTABLE_WEBINARS_TABLE     default "Webinars"
//   AIRTABLE_REGISTRATIONS_TABLE default "Registrations"
//   AIRTABLE_QUESTIONS_TABLE    default "Questions"

const crypto = require("crypto");
const { findOne } = require("./_airtable");

const WEBINARS_TABLE = process.env.AIRTABLE_WEBINARS_TABLE || "Webinars";
const REGISTRATIONS_TABLE = process.env.AIRTABLE_REGISTRATIONS_TABLE || "Registrations";
const QUESTIONS_TABLE = process.env.AIRTABLE_QUESTIONS_TABLE || "Questions";
const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";

const INTENTS = ["Attending", "Can't attend", "Maybe"];

function isConfigured() {
  return Boolean(process.env.WEBINAR_TOKEN_SECRET);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function mintToken({ contact_id, session, expDays = 30 }) {
  const secret = process.env.WEBINAR_TOKEN_SECRET;
  if (!secret) throw new Error("WEBINAR_TOKEN_SECRET not set");
  if (!contact_id || !session) throw new Error("contact_id and session required");
  const payload = {
    c: String(contact_id),
    s: String(session),
    x: Math.floor(Date.now() / 1000) + Math.max(1, Number(expDays) || 30) * 86400,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

// → { contact_id, session } or null. Fails closed when the secret is unset.
function verifyToken(t) {
  const secret = process.env.WEBINAR_TOKEN_SECRET;
  if (!secret) return null;
  if (!t || typeof t !== "string" || t.length > 2048) return null;
  const parts = t.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  let got;
  try {
    got = fromB64url(sig);
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.c !== "string" || typeof payload.s !== "string") return null;
  if (typeof payload.x !== "number" || !Number.isFinite(payload.x)) return null;
  if (payload.x < Date.now() / 1000) return null;
  return { contact_id: payload.c, session: payload.s };
}

function escFormula(s) {
  return String(s).replace(/'/g, "\\'");
}

function normSession(s) {
  const slug = String(s || "").trim().toLowerCase();
  return /^[a-z0-9-]{1,40}$/.test(slug) ? slug : "";
}

async function findWebinarBySession(session) {
  const slug = normSession(session);
  if (!slug) return null;
  return findOne(WEBINARS_TABLE, `LOWER({session_slug})='${escFormula(slug)}'`);
}

async function findContactByContactId(contactId) {
  if (!contactId) return null;
  return findOne(CONTACTS_TABLE, `{contact_id}='${escFormula(contactId)}'`);
}

module.exports = {
  WEBINARS_TABLE,
  REGISTRATIONS_TABLE,
  QUESTIONS_TABLE,
  CONTACTS_TABLE,
  INTENTS,
  isConfigured,
  mintToken,
  verifyToken,
  escFormula,
  normSession,
  findWebinarBySession,
  findContactByContactId,
};
