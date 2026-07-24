// POST /api/survey/complete  { response_id, slug, answers }
//
// Marks the response complete, evaluates the ask router server-side, records
// the variant shown, and returns the fully-resolved end screen for the client
// to render. Idempotent: revisiting a complete response recomputes the same
// ask (amounts/URLs carry variant + uid + UTM).

const S = require("./_survey");
const { evaluateAsk } = require("./_ask");

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

    const rf = response.fields || {};
    // Prefer answers stored on the row (source of truth) but fold in anything
    // the client sends on this call.
    let stored = {};
    if (rf.raw_json) { try { stored = JSON.parse(rf.raw_json) || {}; } catch { stored = {}; } }
    const merged = { ...stored, ...answers };

    // uid lives on the contact, not the response; pull it for UTM/variant tagging.
    let contactUid = "";
    const contactId = Array.isArray(rf.contact) ? rf.contact[0] : null;
    if (contactId) {
      try {
        const c = await S.findOne(S.SURVEY_CONTACTS, `RECORD_ID()='${S.esc(contactId)}'`);
        contactUid = (c && c.fields && c.fields.uid) || "";
      } catch (e) { console.error("complete uid lookup:", e.message); }
    }

    const ctx = { uid: contactUid, src: rf.src || "web", campaign: rf.campaign_code || "survey" };
    const outcome = evaluateAsk(survey, merged, ctx);

    const columns = S.answersToColumns(survey, merged);
    const patch = {
      ...columns,
      raw_json: JSON.stringify(merged).slice(0, 95000),
      ask_variant_shown: outcome.id,
    };
    // Only flip to complete the first time.
    if (rf.status !== "complete") {
      patch.status = "complete";
      patch.completed_at = S.nowIso();
    }
    await S.updateRow(S.SURVEY_RESPONSES, response.id, patch);
    if (contactId) await S.touchContact(contactId);

    return res.status(200).json({ ok: true, ask: outcome });
  } catch (e) {
    console.error("survey/complete error:", e.message);
    return res.status(500).json({ error: "complete failed" });
  }
};
