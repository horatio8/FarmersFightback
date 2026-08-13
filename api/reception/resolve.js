// GET /api/reception/resolve?t=<invite_token>
//
// The page's front door. A valid token returns the invitee's own details so
// the form arrives pre-filled; anything else returns a flat refusal. There is
// no public path into this page — no token, no page.
//
// Deliberately uniform on failure: an unknown token, a malformed one and a
// cancelled invitation all answer { valid: false } with the same wording, so
// the endpoint can't be used to test whether a given token exists.

const R = require("./_lib");
const rateLimit = require("../survey/_ratelimit");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Token guessing is the attack that matters here, so cap attempts per IP.
  const rl = rateLimit.check(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ valid: false, error: "Too many attempts. Try again shortly." });
  }

  const url = new URL(req.url, "https://x");
  const token = String(url.searchParams.get("t") || "").trim();
  const code = String(url.searchParams.get("code") || "").trim();
  const uid = String(url.searchParams.get("uid") || "").trim();
  const deny = { valid: false, error: "This invitation link isn't valid." };
  // One code, one spot. Said plainly, with a way out that reaches a human.
  const spent = {
    valid: false,
    used: true,
    error: "This invitation has already been used.",
    contact_email: "support@farmersfightback.com",
  };

  try {
    // Referral-code link from the invitation email.
    if (!token && uid) {
      const contact = await R.findContactByCode(uid);
      if (!contact) return res.status(200).json(deny);
      const cf = contact.fields || {};
      const already = await R.registrationFor(cf.email);
      if (already) return res.status(200).json(spent);
      return res.status(200).json({
        valid: true,
        mode: "code",
        event: R.EVENT,
        invitee: {
          first_name: cf.first_name || "",
          last_name: cf.last_name || "",
          email: cf.email || "",
          mobile: cf.mobile || "",
        },
        guests_allowed: 1,
        registration: null,
      });
    }

    // Passcode: opens the same form with nothing pre-filled. There is no
    // profile behind a shared secret, so every field is typed by hand and
    // one guest is allowed, same as a standard invitation.
    if (!token && code) {
      if (!R.passcodeOk(code)) {
        return res.status(200).json({ valid: false, error: "That passcode isn't right." });
      }
      return res.status(200).json({
        valid: true,
        mode: "passcode",
        event: R.EVENT,
        invitee: { first_name: "", last_name: "", email: "", mobile: "" },
        guests_allowed: 1,
        registration: null,
      });
    }

    const invite = await R.findInviteByToken(token);
    if (!invite) return res.status(200).json(deny);
    const f = invite.fields || {};
    if (f.status === "Cancelled") return res.status(200).json(deny);

    const existing = await R.findRegistrationForInvite(invite);
    const ef = (existing && existing.fields) || null;

    return res.status(200).json({
      valid: true,
      mode: "invite",
      event: R.EVENT,
      invitee: {
        first_name: f.first_name || "",
        last_name: f.last_name || "",
        email: f.email || "",
        mobile: f.mobile || "",
      },
      guests_allowed: Number.isFinite(Number(f.guests_allowed)) ? Number(f.guests_allowed) : 1,
      // A returning invitee sees what they told us and can change it.
      registration: ef
        ? {
            reg_ref: ef.reg_ref || "",
            attending: ef.attending || "",
            bringing_guest: ef.bringing_guest || "No",
            guest_first_name: ef.guest_first_name || "",
            guest_last_name: ef.guest_last_name || "",
            guest_email: ef.guest_email || "",
            guest_mobile: ef.guest_mobile || "",
            guest_relationship: ef.guest_relationship || "",
            dietary: ef.dietary || "",
          }
        : null,
    });
  } catch (e) {
    console.error("reception/resolve:", e.message);
    return res.status(500).json({ valid: false, error: "Couldn't check that invitation. Try again in a moment." });
  }
};
