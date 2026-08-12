// Shared helpers for the private reception RSVP (Sat 29 Aug, 5–6pm, Marnoo).
//
// The gate is a per-invitee secret token, NOT the contact's referral_code:
// referral codes travel in public share links, so anyone who has ever seen a
// supporter's share URL could walk into an invite-only event. These tokens are
// 24 URL-safe characters from crypto randomness, issued one per invitee and
// never published anywhere but that person's email.

const crypto = require("crypto");
const { listPage, select, create, update, fesc } = require("../../lib/social/airtable");

const INVITES = process.env.AIRTABLE_RECEPTION_INVITES_TABLE || "tbl4e1dznrukbzWaD";
const REGISTRATIONS = process.env.AIRTABLE_RECEPTION_REGS_TABLE || "tbleoZzh6jc5Q3Xt8";

// Event facts, single source of truth for the API and the page copy.
const EVENT = {
  name: "The Landholders' Table",
  kicker: "By invitation only",
  date: "Saturday 29 August",
  time: "5:00pm – 6:00pm",
  venue: "Marnoo Cricket Ground",
  place: "Marnoo Recreation Reserve, Park St, Marnoo VIC 3387",
  after: "Doors to the main FUNdraiser open at 6:00pm",
};

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LEN = 24;

// Ambiguous glyphs (0/O, 1/l/I) are out of the alphabet so a token read off a
// printed page or dictated over the phone can still be typed correctly.
function mintToken() {
  const bytes = crypto.randomBytes(TOKEN_LEN * 2);
  let out = "";
  for (let i = 0; out.length < TOKEN_LEN && i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 256 - (256 % TOKEN_ALPHABET.length)) continue; // reject bias
    out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  }
  return out;
}

function validTokenShape(t) {
  return typeof t === "string" && t.length >= 16 && t.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t);
}

// Constant-time compare so a timing side channel can't be used to grind out a
// token character by character.
function tokenEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function findInviteByToken(token) {
  if (!validTokenShape(token)) return null;
  // Fetch by formula, then re-verify in constant time: Airtable's own match is
  // exact, but the explicit compare keeps the guarantee local and obvious.
  const rows = await select(INVITES, `{invite_token} = '${fesc(token)}'`, null, 1);
  const rec = rows[0];
  if (!rec || !rec.fields || !tokenEquals(rec.fields.invite_token || "", token)) return null;
  return rec;
}

async function findRegistrationForInvite(inviteRecordId) {
  const rows = await select(
    REGISTRATIONS,
    `FIND('${fesc(inviteRecordId)}', ARRAYJOIN({invite})) > 0`,
    null,
    1
  );
  return rows[0] || null;
}

// --- validation -------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

function cleanStr(v, max = 120) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function validEmail(v) {
  return EMAIL_RE.test(String(v || "").trim());
}

// Australian mobile or landline, tolerant of spaces and +61.
function normMobile(v) {
  const digits = String(v || "").replace(/[^\d+]/g, "").replace(/^\+?61/, "0");
  const d = digits.replace(/\D/g, "");
  if (d.length < 8 || d.length > 12) return null;
  return d.startsWith("0") ? d : `0${d}`;
}

function esc(s) {
  return String(s == null ? "" : s);
}

module.exports = {
  INVITES,
  REGISTRATIONS,
  EVENT,
  mintToken,
  validTokenShape,
  tokenEquals,
  findInviteByToken,
  findRegistrationForInvite,
  cleanStr,
  validEmail,
  normMobile,
  esc,
  listPage,
  select,
  create,
  update,
  fesc,
};
