// POST /api/survey/answer  { response_id, answers }
//
// Save-per-answer. `answers` is the cumulative field→value map; every call
// rewrites the typed columns and raw_json in a single idempotent PATCH, so a
// drop-off at any question still leaves every prior answer in Airtable within
// a second. Also syncs postcode / mobile onto the Survey Contact so
// skip_if_known holds on resume and the CRM gets the enrichment.

const S = require("./_survey");

// phone_optin value is "yes:<e164>" | "yes" | "no". Pull the number if present.
function mobileFromOptin(v) {
  const s = String(v || "");
  const i = s.indexOf(":");
  if (i < 0) return "";
  return S.normPhone(s.slice(i + 1));
}

module.exports = async function handler(req, res) {
  if (!S.applyCors(req, res)) return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = S.readBody(req);
  const responseId = String(body.response_id || "").trim();
  const slug = String(body.slug || "").trim();
  const answers = (body.answers && typeof body.answers === "object") ? body.answers : {};
  if (!responseId) return res.status(400).json({ error: "response_id required" });

  const survey = S.getSurvey(slug) || S.getSurvey("supporters");
  if (!survey) return res.status(404).json({ error: "unknown survey" });

  try {
    const response = await S.findOne(S.SURVEY_RESPONSES, `{response_id}='${S.esc(responseId)}'`);
    if (!response) return res.status(404).json({ error: "response not found" });

    const columns = S.answersToColumns(survey, answers);
    // raw_json is the safety net + source of truth for resume.
    await S.updateRow(S.SURVEY_RESPONSES, response.id, {
      ...columns,
      raw_json: JSON.stringify(answers).slice(0, 95000),
    });

    // Sync known fields onto the contact (best-effort, never fails the save).
    const contactId = Array.isArray(response.fields.contact) ? response.fields.contact[0] : null;
    if (contactId) {
      const patch = {};
      if (answers.postcode) patch.postcode = String(answers.postcode).trim().slice(0, 12);
      if (answers.mobile_optin) {
        const m = mobileFromOptin(answers.mobile_optin);
        if (m) patch.mobile = m;
      }
      if (Object.keys(patch).length) {
        patch.last_seen_at = S.nowIso();
        try { await S.updateRow(S.SURVEY_CONTACTS, contactId, patch); } catch (e) { console.error("answer contact sync:", e.message); }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("survey/answer error:", e.message);
    return res.status(500).json({ error: "save failed" });
  }
};
