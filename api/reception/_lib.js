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
// Named and framed as a private reception for an invitation-only group of
// key supporters -- never as the warm-up before the main event.
const EVENT = {
  name: "Private Reception",
  kicker: "By invitation only",
  date: "Saturday 29 August",
  time: "5:00pm – 6:00pm",
  venue: "Marnoo Cricket Ground",
  place: "Marnoo Recreation Reserve, Park St, Marnoo VIC 3387",
  after: "The FUNdraiser follows from 6:00pm",
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

// Shared passcode — the second way in, for people we want in the room but
// don't hold an email address for: handed out by phone, at the gate, or in a
// group chat. It is a shared secret, so it buys far less than a personal
// invitation: no prefill, and every field typed by hand.
//
// Matched case- and space-insensitively. It gets read off a text message and
// retyped on a phone keyboard, and "farmersforever" being refused because of
// an autocapitalised F is a support call, not security.
function receptionPasscode() {
  return String(process.env.RECEPTION_PASSCODE || "FarmersForever");
}

// "FarmersForever" was the shared passcode until 18 Aug 2026, when the event
// was tightened to an invitation-only group of key supporters and the owner
// asked for it to stop working in any capitalisation. It is refused here,
// ahead of the env comparison, so it stays dead even while the deployed
// RECEPTION_PASSCODE env var still holds it. Setting the env var to a NEW
// value re-enables the passcode door with that value only.
const RETIRED_PASSCODES = new Set(["farmersforever"]);

function passcodeOk(input) {
  const given = String(input || "").trim().toLowerCase().replace(/\s+/g, "");
  if (RETIRED_PASSCODES.has(given)) return false;
  const want = receptionPasscode().trim().toLowerCase().replace(/\s+/g, "");
  if (RETIRED_PASSCODES.has(want)) return false;
  if (!given || !want || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
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

// Referral-code entry. The emailed link carries the recipient's referral code
// (CN merge tag %recipient.FarmersFightback_UID%), which resolves to their CRM
// record so the form arrives filled in.
//
// Worth being clear about what this is: a referral code is NOT a secret. Every
// share link on the site is /page?ref=CODE, posted publicly. Combined with a
// passcode that also travels in the same email, this invitation is designed to
// be easy to open rather than hard to forge. What protects the guest list is
// the single-use rule below, not the code itself.
async function findContactByCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c || c.length > 12 || !/^[A-Z0-9]+$/.test(c)) return null;
  const { findContactByReferralCode } = require("../_airtable");
  return findContactByReferralCode(c);
}

// One code, one registration. Returns the registration that already consumed
// this person's invitation, or null if their code is still unused.
async function registrationFor(email) {
  const invite = await findInviteByEmail(email);
  if (!invite) return null;
  return findRegistrationForInvite(invite);
}

// Used by the passcode path so a second visit from the same person updates
// their row instead of adding another name to the door list.
async function findInviteByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const rows = await select(INVITES, `LOWER({email}) = '${fesc(e)}'`, null, 1);
  return rows[0] || null;
}

// Look up an existing RSVP for an invitation.
//
// Takes the invite RECORD, not its id: ARRAYJOIN over a linked-record field
// renders each link's PRIMARY field, which here is invite_token — record ids
// never appear, so filtering on one silently matches nothing. (Live traffic
// found this; a mock that returns ids for ARRAYJOIN happily passes it.)
async function findRegistrationForInvite(invite) {
  const token = invite && invite.fields && invite.fields.invite_token;
  if (!token) return null;
  const rows = await select(REGISTRATIONS, `ARRAYJOIN({invite}) = '${fesc(token)}'`, null, 1);
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
  receptionPasscode,
  passcodeOk,
  findInviteByEmail,
  findInviteByToken,
  findContactByCode,
  registrationFor,
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
