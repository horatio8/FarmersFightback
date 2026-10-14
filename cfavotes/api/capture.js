// POST /api/capture
// Body: { first_name, last_name, email, mobile, postcode, seat_state,
//         seat_region, seat_federal, jurisdiction, consent_email,
//         consent_sms, source, ref, utm }
//
// The gate in front of every result. Writes a Contacts row (or updates the
// one that matches on email, then mobile) and logs an Event, and hands back
// the contact's referral code so the result page can offer a share link.
//
// Matching is done here, in this base. Pushing to Farmers Fightback is a
// separate job (see SPEC §4) that never goes through FF's public
// matchOrCreateContact, which counts petition signatures.

const crypto = require("crypto");
const A = require("../lib/airtable");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L, same as FF
const code = (n = 6) => Array.from(crypto.randomBytes(n)).map((b) => ALPHABET[b % ALPHABET.length]).join("");
const normEmail = (e) => String(e || "").trim().toLowerCase();
function normMobile(m) {
  const d = String(m || "").replace(/[^\d+]/g, "");
  if (!d) return "";
  if (/^04\d{8}$/.test(d)) return "+61" + d.slice(1);
  if (/^614\d{8}$/.test(d)) return "+" + d;
  if (/^\+614\d{8}$/.test(d)) return d;
  return d;
}
const esc = (s) => String(s).replace(/'/g, "\\'");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const b = req.body || {};
  const email = normEmail(b.email), mobile = normMobile(b.mobile);
  if (!email && !mobile) return res.status(400).json({ error: "An email or a mobile is needed" });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "That email does not look right" });
  if (b.mobile && !/^\+614\d{8}$/.test(mobile)) return res.status(400).json({ error: "Enter an Australian mobile, e.g. 0412 345 678" });

  const fields = {
    first_name: String(b.first_name || "").trim().slice(0, 80),
    last_name: String(b.last_name || "").trim().slice(0, 80),
    email: email || undefined, mobile: mobile || undefined,
    postcode: String(b.postcode || "").trim().slice(0, 4) || undefined,
    seat_state: b.seat_state || undefined, seat_region: b.seat_region || undefined, seat_federal: b.seat_federal || undefined,
    jurisdiction: b.jurisdiction || undefined,
    consent_email: !!b.consent_email, consent_sms: !!b.consent_sms,
    source: b.source || "Lookup",
    referred_by_code: b.ref ? String(b.ref).toUpperCase().slice(0, 8) : undefined,
    utm: b.utm ? JSON.stringify(b.utm).slice(0, 2000) : undefined,
  };

  if (!A.configured()) {
    // Keys not in yet: let the page proceed, say so plainly, keep nothing.
    return res.status(202).json({ ok: true, stored: false, referral_code: null, note: "Airtable not configured" });
  }

  try {
    const clauses = [];
    if (email) clauses.push(`LOWER({email})='${esc(email)}'`);
    if (mobile) clauses.push(`{mobile}='${esc(mobile)}'`);
    const existing = await A.findOne("Contacts", clauses.length > 1 ? `OR(${clauses.join(",")})` : clauses[0]);
    let contact;
    if (existing) {
      const patch = {};
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "" && (existing[k] === undefined || existing[k] === "" || k.startsWith("consent") || k.startsWith("seat"))) patch[k] = v;
      contact = { ...existing, ...patch };
      if (Object.keys(patch).length) await A.update("Contacts", existing.id, patch);
    } else {
      const created = await A.create("Contacts", { ...fields, contact_id: crypto.randomUUID(), referral_code: code(), created_at: new Date().toISOString() });
      contact = { id: created.id, ...created.fields };
    }
    await A.create("Events", {
      event_id: crypto.randomUUID(), event_type: existing ? "Capture (returning)" : "Capture (new)", contact_id: contact.contact_id,
      payload: JSON.stringify({ source: fields.source, seat_state: fields.seat_state, seat_region: fields.seat_region, ref: fields.referred_by_code || null, ua: req.headers["user-agent"] || null }).slice(0, 5000),
      created_at: new Date().toISOString(),
    }).catch(() => {});
    return res.status(200).json({ ok: true, stored: true, referral_code: contact.referral_code || null, returning: !!existing });
  } catch (err) {
    console.error("capture error:", err.message);
    // Never block the voter on our plumbing: let them through, flag it.
    return res.status(202).json({ ok: true, stored: false, referral_code: null, note: "stored later" });
  }
};
