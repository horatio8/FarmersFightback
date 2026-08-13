// POST /api/reception/register
//   { t, attending, first_name, last_name, email, mobile,
//     bringing_guest, guest_first_name, guest_last_name, guest_email,
//     guest_mobile, guest_relationship, dietary }
//
// Writes the RSVP against the invitation. Re-submitting updates the existing
// row rather than creating a second one, so an invitee can change their mind
// or fix a typo without producing a duplicate on the door list.
//
// The guest rule is enforced HERE, not just in the form: if they are bringing
// someone, every guest field must be present and well-formed. A name with no
// way to contact the person is exactly what the door list can't use, and a
// browser-side check alone is no rule at all.

const R = require("./_lib");
const rateLimit = require("../survey/_ratelimit");
const { logEvent, findContactByEmail } = require("../_airtable");

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

function refFor() {
  return `RCP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rl = rateLimit.check(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false, error: "Too many attempts. Try again shortly." });
  }

  const body = readBody(req);
  const token = String(body.t || "").trim();
  const code = String(body.code || "").trim();
  const uid = String(body.uid || "").trim();

  try {
    // Three ways in. A personal invitation resolves to an existing row. The
    // shared passcode and the referral code have no row yet — one is created
    // below, but only AFTER their details validate, so a half-filled attempt
    // never lands on the door list.
    const viaPasscode = !token && !uid && R.passcodeOk(code);
    let codeContact = null;
    if (!token && uid) {
      codeContact = await R.findContactByCode(uid);
      if (!codeContact) {
        return res.status(403).json({ ok: false, error: "This invitation link isn't valid." });
      }
      // One code, one spot. Checked here as well as on the way in, so a stale
      // tab or a second submit can't quietly take a second place.
      const already = await R.registrationFor((codeContact.fields || {}).email);
      if (already) {
        return res.status(409).json({
          ok: false,
          used: true,
          error: "This invitation has already been used.",
          contact_email: "support@farmersfightback.com",
        });
      }
    }
    const viaCode = Boolean(codeContact);
    let invite = token ? await R.findInviteByToken(token) : null;
    if (!viaPasscode && !viaCode && (!invite || (invite.fields || {}).status === "Cancelled")) {
      return res.status(403).json({ ok: false, error: "This invitation link isn't valid." });
    }
    const inv = (invite && invite.fields) || {};
    const guestsAllowed = (viaPasscode || viaCode)
      ? 1
      : (Number.isFinite(Number(inv.guests_allowed)) ? Number(inv.guests_allowed) : 1);

    // Someone who typed a passcode is here to come. There is no "sorry, can't
    // make it" to record against an invitation that was never issued.
    const attending = !viaPasscode && !viaCode && body.attending === "No" ? "No" : "Yes";
    const errors = {};

    // The invitee's own details: always required, pre-filled but editable
    // (the invite list's email may be an old one they no longer read).
    const first = R.cleanStr(body.first_name, 60);
    const last = R.cleanStr(body.last_name, 60);
    const email = R.cleanStr(body.email, 120).toLowerCase();
    const mobile = R.normMobile(body.mobile);
    if (attending === "Yes") {
      if (!first) errors.first_name = "Required";
      if (!last) errors.last_name = "Required";
      if (!R.validEmail(email)) errors.email = "Enter a valid email";
      if (!mobile) errors.mobile = "Enter a valid mobile";
    }

    const bringing = attending === "Yes" && body.bringing_guest === "Yes" ? "Yes" : "No";
    if (bringing === "Yes" && guestsAllowed < 1) {
      return res.status(400).json({ ok: false, error: "This invitation doesn't include a guest." });
    }

    // Every guest field compulsory — the whole point of the rule.
    const gFirst = R.cleanStr(body.guest_first_name, 60);
    const gLast = R.cleanStr(body.guest_last_name, 60);
    const gEmail = R.cleanStr(body.guest_email, 120).toLowerCase();
    const gMobile = R.normMobile(body.guest_mobile);
    const gRel = R.cleanStr(body.guest_relationship, 80);
    if (bringing === "Yes") {
      if (!gFirst) errors.guest_first_name = "Required";
      if (!gLast) errors.guest_last_name = "Required";
      if (!R.validEmail(gEmail)) errors.guest_email = "Enter a valid email";
      if (!gMobile) errors.guest_mobile = "Enter a valid mobile";
      if (!gRel) errors.guest_relationship = "Required";
      // A guest sharing the invitee's own contact details defeats the rule.
      if (gEmail && email && gEmail === email) errors.guest_email = "Your guest needs their own email";
      if (gMobile && mobile && gMobile === mobile) errors.guest_mobile = "Your guest needs their own mobile";
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ ok: false, errors, error: "Please check the highlighted fields." });
    }

    const nowIso = new Date().toISOString();

    // Passcode path: details are good, so now give this person a row. Reuse
    // one already carrying their email — someone who registers twice should
    // appear on the door list once, whichever way they came in.
    if (viaPasscode || viaCode) {
      invite = await R.findInviteByEmail(email);
      if (!invite) {
        const made = await R.create(R.INVITES, [{
          invite_token: R.mintToken(),
          first_name: first,
          last_name: last,
          email,
          mobile: mobile || "",
          status: "Invited",
          guests_allowed: 1,
          issued_at: nowIso,
          notes: viaCode
            ? `Registered from the emailed link (referral code ${uid.toUpperCase()})`
            : "Self-registered with the shared passcode",
          ...(codeContact ? { contact: [codeContact.id] } : {}),
        }]);
        invite = made[0];
      }
      if (!invite) return res.status(500).json({ ok: false, error: "Couldn't save your RSVP. Try again in a moment." });
    }

    const existing = await R.findRegistrationForInvite(invite);
    const fields = {
      reg_ref: (existing && existing.fields && existing.fields.reg_ref) || refFor(),
      invite: [invite.id],
      attending,
      first_name: first || inv.first_name || "",
      last_name: last || inv.last_name || "",
      email: email || inv.email || "",
      mobile: mobile || inv.mobile || "",
      bringing_guest: bringing,
      guest_first_name: bringing === "Yes" ? gFirst : "",
      guest_last_name: bringing === "Yes" ? gLast : "",
      guest_email: bringing === "Yes" ? gEmail : "",
      guest_mobile: bringing === "Yes" ? gMobile : "",
      guest_relationship: bringing === "Yes" ? gRel : "",
      dietary: R.cleanStr(body.dietary, 400),
      party_size: attending === "No" ? 0 : bringing === "Yes" ? 2 : 1,
      registered_at: nowIso,
      user_agent: R.cleanStr(req.headers["user-agent"], 250),
    };

    // Link the registration to the CRM contact when we can find one, so the
    // reception shows up on their timeline like every other interaction.
    if (Array.isArray(inv.contact) && inv.contact.length) {
      fields.contact = inv.contact;
    } else if (fields.email) {
      const c = await findContactByEmail(fields.email).catch(() => null);
      if (c) fields.contact = [c.id];
    }

    let regId;
    if (existing) {
      await R.update(R.REGISTRATIONS, [{ id: existing.id, fields }]);
      regId = existing.id;
    } else {
      const made = await R.create(R.REGISTRATIONS, [fields]);
      regId = made[0] && made[0].id;
    }

    await R.update(R.INVITES, [{
      id: invite.id,
      fields: { status: attending === "Yes" ? "Registered" : "Declined", responded_at: nowIso },
    }]).catch((e) => console.error("reception invite status:", e.message));

    // Timeline event. fanout:false — this is an RSVP, not a signature or a
    // donation, and must not touch the public counter or the donation rollups.
    const contactRecordId = Array.isArray(fields.contact) && fields.contact[0];
    if (contactRecordId) {
      await logEvent({
        contactRecordId,
        event_type: "Event Registration",
        timestamp: nowIso,
        source_channel: "Email",
        fanout: false,
        payload: {
          event: R.EVENT.name,
          when: `${R.EVENT.date} ${R.EVENT.time}`,
          attending,
          party_size: fields.party_size,
          bringing_guest: bringing,
          reg_ref: fields.reg_ref,
        },
      }).catch((e) => console.error("reception logEvent:", e.message));
    }

    return res.status(200).json({
      ok: true,
      reg_ref: fields.reg_ref,
      attending,
      party_size: fields.party_size,
      updated: Boolean(existing),
      id: regId,
    });
  } catch (e) {
    console.error("reception/register:", e.message);
    return res.status(500).json({ ok: false, error: "Couldn't save your RSVP. Try again in a moment." });
  }
};
