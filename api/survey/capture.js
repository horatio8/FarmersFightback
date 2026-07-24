// POST /api/survey/capture  { slug, first_name, last_name, email, mobile, src, c }
//
// The fallback identity path for bare/shared links. Creates a provisional
// Survey Contact (token_source=fallback) or, on an exact email match, merges
// into the existing contact. Then opens the response and returns the same
// bootstrap shape as a resolve hit, so the client continues seamlessly.

const S = require("./_survey");

module.exports = async function handler(req, res) {
  if (!S.applyCors(req, res)) return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = S.readBody(req);
  const survey = S.getSurvey(body.slug);
  if (!survey) return res.status(404).json({ error: "unknown survey" });
  const client = S.getClient();

  const first = String(body.first_name || "").trim().slice(0, 80);
  const last = String(body.last_name || "").trim().slice(0, 80);
  const email = S.normEmail(body.email);
  const mobile = S.normPhone(body.mobile);
  if (!first) return res.status(400).json({ error: "Please tell us your first name." });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email so we can save your answers." });
  }

  const src = S.normSrc(body.src, false);
  const campaign = String(body.c || body.campaign || "").slice(0, 60) || null;
  const device = S.detectDevice(req.headers["user-agent"]);

  try {
    // Merge-by-email: reuse an existing Survey Contact on exact email match.
    let contact = await S.findSurveyContactByEmail(email);
    if (contact) {
      const cur = contact.fields || {};
      const patch = { last_seen_at: S.nowIso() };
      if (first && !cur.first_name) patch.first_name = first;
      if (last && !cur.last_name) patch.last_name = last;
      if (mobile && !cur.mobile) patch.mobile = mobile;
      try { await S.updateRow(S.SURVEY_CONTACTS, contact.id, patch); } catch (e) { console.error("capture merge patch:", e.message); }
      contact.fields = { ...cur, ...patch };
    } else {
      const fields = {
        uid: S.makeUid(),
        first_name: first || undefined,
        last_name: last || undefined,
        email: email || undefined,
        mobile: mobile || undefined,
        token_source: "fallback",
        created_at: S.nowIso(),
        last_seen_at: S.nowIso(),
      };
      Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
      contact = await S.createSurveyContact(fields);
    }

    const uid = contact.fields.uid;
    let response = await S.findResponse(uid, survey.slug);
    if (!response) {
      response = await S.createResponse({
        contactRecordId: contact.id,
        slug: survey.slug,
        version: survey.version,
        src,
        campaign,
        device,
      });
    }

    const payload = S.bootstrapPayload({ survey, client, contactRecord: contact, response });
    return res.status(200).json(payload);
  } catch (e) {
    console.error("survey/capture error:", e.message);
    return res.status(500).json({ error: "capture failed" });
  }
};
