// POST /api/survey/resolve  { slug, uid, src, c }
//
// Bootstraps the survey. Resolves the tokenised uid to a Survey Contact:
//   Hit          → greet by name, return known fields (for skip_if_known),
//                  create/resume the in_progress response, return answered map.
//   Miss/absent  → { needs_capture: true } with the capture screen config;
//                  no contact/response created until they submit /capture.
//
// Unknown vs malformed uid return the SAME neutral needs_capture response
// (no enumeration signal). Always 200 unless the slug is unknown or Airtable
// is misconfigured.

const S = require("./_survey");

module.exports = async function handler(req, res) {
  if (!S.applyCors(req, res)) return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = S.readBody(req);
  const survey = S.getSurvey(body.slug);
  if (!survey) return res.status(404).json({ error: "unknown survey" });
  const client = S.getClient();

  const uid = String(body.uid || "").trim();
  const hadUid = uid.length > 0;
  const src = S.normSrc(body.src, hadUid);
  const campaign = String(body.c || body.campaign || "").slice(0, 60) || null;
  const device = S.detectDevice(req.headers["user-agent"]);

  try {
    let contact = null;
    // Guard against absurd inputs before hitting Airtable; treat as a miss.
    if (hadUid && uid.length <= 64 && /^[A-Za-z0-9_-]+$/.test(uid)) {
      contact = await S.findContactByUid(uid);
    }

    if (!contact) {
      // Neutral fallback: no contact yet, ask the client to capture identity.
      return res.status(200).json({
        ok: true,
        needs_capture: true,
        slug: survey.slug,
        version: survey.version,
        survey: { slug: survey.slug, version: survey.version, title: survey.title, intro: survey.intro, screens: survey.screens },
        brand: client.brand,
        copy: client.copy,
        cap: client.donation,
        capture: {
          intro: client.copy.capture_intro,
          privacy_line: client.copy.privacy_line,
          privacy_url: client.copy.privacy_url,
        },
        src,
        campaign_code: campaign,
      });
    }

    // Hit — resume or start the response.
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
    await S.touchContact(contact.id);

    const payload = S.bootstrapPayload({ survey, client, contactRecord: contact, response });
    payload.src = response.fields.src || src;
    payload.campaign_code = response.fields.campaign_code || campaign;
    return res.status(200).json(payload);
  } catch (e) {
    console.error("survey/resolve error:", e.message);
    return res.status(500).json({ error: "resolve failed" });
  }
};
