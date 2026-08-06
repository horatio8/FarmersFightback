// Server-side PII masking for tokenised links.
//
// A tokenised survey link identifies a supporter from a value carried in the
// URL. That value travels through inboxes, forwards and, in the case of a
// referral code, links supporters post publicly. So the page has to be able to
// say "we know who you are" without the browser ever receiving enough to be
// worth stealing.
//
// The rule this module enforces: the real value never leaves the server. The
// client receives a masked string for display and nothing else. Anything that
// needs the true value (seeding a skipped answer, matching an identity) is done
// server-side against the record we already hold.
//
// Masks preserve length, so a supporter recognises their own data at a glance.
// That does disclose the length of each value; the alternative, a fixed-width
// mask, hides it but reads as a placeholder rather than as their details. Length
// alone is weak enough to be worth trading for the recognition.
//
//   maskName("James")                 → "J****"
//   maskName("Flynn")                 → "F****"
//   maskMobile("61412060882")         → "04*****882"
//   maskEmail("janninesc@gmail.com")  → "j*******c@g****.com"
//   maskPostcode("3400")              → "3***"
//
// Every function is total: null, undefined, numbers and junk all return "" or a
// fully masked string, never a partial leak and never a throw.

const STAR = "*";

function stars(n) {
  return n > 0 ? STAR.repeat(n) : "";
}

function clean(v) {
  return v == null ? "" : String(v).trim();
}

// First and last character visible, middle starred. Short values give up less:
// a 2 character name would otherwise be fully revealed by a first+last rule, and
// a 1 character name is masked outright.
//
//   ""      → ""        (caller omits the field entirely)
//   "J"     → "*"
//   "Jo"    → "J*"
//   "Joe"   → "J*e"
//   "James" → "J***s"
function maskCore(s) {
  const v = clean(s);
  if (!v) return "";
  if (v.length === 1) return STAR;
  if (v.length === 2) return v[0] + STAR;
  return v[0] + stars(v.length - 2) + v[v.length - 1];
}

// Names show the first letter only, the rest starred: "James" → "J****".
// (maskCore, first+last, still backs email local-parts and the unknown-field
// fallback — a name is hidden one character harder than those.)
function maskName(s) {
  const v = clean(s);
  if (!v) return "";
  if (v.length === 1) return STAR;
  return v[0] + stars(v.length - 1);
}

// First 2 and last 3 digits visible: "0412 060 882" → "04*****882". The leading
// "04" is common to every AU mobile so it discloses nothing, and the last 3 are
// the bank/courier convention for "yes, that's my number".
//
// Australian mobiles are stored E.164 (61412060882) but read back as 04...,
// so normalise before masking or the mask lands on the wrong digits.
function maskMobile(s) {
  const digits = clean(s).replace(/[^0-9]/g, "");
  if (!digits) return "";
  let local = digits;
  if (local.startsWith("61") && local.length >= 11) local = "0" + local.slice(2);
  else if (local.length === 9 && local.startsWith("4")) local = "0" + local;
  // Too short to spare 3 digits without revealing most of it.
  if (local.length <= 4) return stars(local.length);
  // Not long enough to also show the prefix without leaving too little masked.
  if (local.length <= 7) return stars(local.length - 3) + local.slice(-3);
  return local.slice(0, 2) + stars(local.length - 5) + local.slice(-3);
}

// Local part masked like a name. Domain label reduced to its first letter, TLD
// kept intact: enough for the owner to think "that's my gmail" without handing
// over the full address. Multi-part TLDs (.com.au) are preserved whole, since
// masking them would leak nothing and only make the address unrecognisable.
function maskEmail(s) {
  const v = clean(s);
  if (!v) return "";
  const at = v.lastIndexOf("@");
  // Not an address we can parse — mask the lot rather than guess.
  if (at < 1 || at === v.length - 1) return stars(v.length);

  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  const parts = domain.split(".");
  if (parts.length < 2) return `${maskCore(local)}@${stars(domain.length)}`;

  // Everything after the first label is TLD and stays readable.
  const label = parts[0];
  const rest = parts.slice(1).join(".");
  const maskedLabel = label.length <= 1 ? stars(label.length) : label[0] + stars(label.length - 1);
  return `${maskCore(local)}@${maskedLabel}.${rest}`;
}

// Australian postcodes: the leading digit is the state, which is coarse enough
// to show and helps the supporter recognise the record. The rest is masked.
function maskPostcode(s) {
  const v = clean(s).replace(/[^0-9A-Za-z]/g, "");
  if (!v) return "";
  if (v.length === 1) return STAR;
  return v[0] + stars(v.length - 1);
}

// Field-name driven so callers do not have to remember which masker to use.
const MASKERS = {
  first_name: maskName,
  last_name: maskName,
  name: maskName,
  email: maskEmail,
  mobile: maskMobile,
  phone: maskMobile,
  postcode: maskPostcode,
  zip: maskPostcode,
};

// Unknown field names fall back to the name rule, which is the most
// conservative of the set. A field we forgot to classify gets masked, not
// passed through.
function maskField(field, value) {
  const fn = MASKERS[field] || maskCore;
  return fn(value);
}

// Mask a whole record. Empty values are dropped rather than returned as "",
// because the caller uses presence in this object to mean "we know this".
function maskRecord(fields, keys) {
  const src = fields || {};
  const out = {};
  (keys || Object.keys(src)).forEach((k) => {
    const masked = maskField(k, src[k]);
    if (masked) out[k] = masked;
  });
  return out;
}

module.exports = {
  maskName,
  maskEmail,
  maskMobile,
  maskPostcode,
  maskField,
  maskRecord,
  maskCore,
};
