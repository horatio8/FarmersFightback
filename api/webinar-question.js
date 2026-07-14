// Donor webinar Q&A capture + inline AI triage (spec §6).
//
// POST /api/webinar-question  { t, session, body }
//   → 200 { ok: true }        (AI verdict is best-effort; failure leaves
//                              ai_include/ai_rationale blank)
//   → 400 { error }           empty/oversized body
//   → 403 { private: true }   invalid/expired token or session mismatch
//   → 429 { error }           more than 10 questions for this token
//   → 503 { error: "not configured" } when WEBINAR_TOKEN_SECRET is unset
//
// Triage matches the /api/rewrite Anthropic pattern: server-side fetch,
// ANTHROPIC_MODEL default claude-haiku-4-5-20251001, strict-JSON verdict
// {"include":"Yes"|"No"|"Maybe","rationale":"one line"} written back to the
// Questions row.

const { findOne, listRows, createRow, updateRow, uuid, nowIso, normEmail, findContactByEmail } = require("./_airtable");
const {
  REGISTRATIONS_TABLE,
  QUESTIONS_TABLE,
  isConfigured,
  verifyToken,
  escFormula,
  normSession,
  findWebinarBySession,
  findContactByContactId,
} = require("./_webinar");

const MAX_BODY = 2000;
const MAX_QUESTIONS_PER_TOKEN = 10;

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
  "https://farmersfightback-tellerconsulting.vercel.app",
]);

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

// Per-instance fast-path counter (mirrors the rewrite.js in-memory pattern);
// the durable count comes from the Questions rows linked to the token's
// registration.
const tokenHits = new Map();

const TRIAGE_SYSTEM = [
  "You assess whether an audience-submitted question or comment should be included in the Q&A segment of a private donor webinar for Farmers Fightback, an Australian campaign fighting the VNI West transmission project on behalf of farmers.",
  "Judge on: is it a genuine question or comment relevant to the campaign (VNI West, farming, donations, campaign strategy)? Is it respectful? It must not be spam, abuse, or heavy with personal identifying information.",
  'Return strictly JSON: {"include":"Yes"|"No"|"Maybe","rationale":"one line"} with no extra commentary and no markdown fences.',
].join("\n");

function parseModelJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Best-effort triage — any failure returns null and the row stays blank.
async function triageQuestion(bodyText) {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey || !/^[\x21-\x7E]+$/.test(apiKey)) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: TRIAGE_SYSTEM,
        messages: [{ role: "user", content: `Audience submission:\n${bodyText}` }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("webinar triage anthropic error:", r.status, JSON.stringify(data).slice(0, 300));
      return null;
    }
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";
    const parsed = parseModelJson(text);
    if (!parsed || !["Yes", "No", "Maybe"].includes(parsed.include)) return null;
    return { include: parsed.include, rationale: String(parsed.rationale || "").slice(0, 500) };
  } catch (e) {
    console.error("webinar triage failed:", e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const token = String(body.t || "");
  const session = normSession(body.session);
  const email = normEmail(body.email); // open mode: page POSTs the form email

  // Only require token config when a token was supplied. Open mode needs none.
  if (token && !isConfigured()) return res.status(503).json({ error: "not configured" });

  const v = token ? verifyToken(token) : null;
  const hasValidToken = Boolean(v && session && v.session === session);

  const text = String(body.body || "").trim();
  if (!text) return res.status(400).json({ error: "Please write a question or comment first." });
  if (text.length > MAX_BODY) {
    return res.status(400).json({ error: `Please keep it under ${MAX_BODY} characters.` });
  }

  // Rate limit: 10 questions per registrant. Fast path in-memory keyed on the
  // token (auth mode) or email+session (open mode, where there is no token);
  // durable path counts the Questions rows hanging off the registration.
  const rateKey = hasValidToken ? token : `${email}|${session}`;
  const memCount = tokenHits.get(rateKey) || 0;
  if (memCount >= MAX_QUESTIONS_PER_TOKEN) {
    return res.status(429).json({ error: "You've reached the question limit for this briefing." });
  }

  try {
    const webinar = await findWebinarBySession(session);
    // Auth gate: valid token always passes; otherwise (open mode) the webinar
    // row must be flagged open_registration.
    if (!hasValidToken) {
      if (!webinar || !(webinar.fields || {}).open_registration) {
        return res.status(403).json({ private: true });
      }
    } else if (!webinar) {
      return res.status(404).json({ error: "session not found" });
    }

    // Resolve the registration to link the question to. Token mode keys on
    // the token; open mode keys on (email + this webinar).
    let registration = null;
    if (hasValidToken) {
      registration = await findOne(REGISTRATIONS_TABLE, `{token}='${escFormula(token)}'`);
    } else if (email) {
      const candidates = await listRows(REGISTRATIONS_TABLE, {
        formula: `LOWER({email})='${escFormula(email)}'`,
        maxRecords: 50,
      });
      registration = candidates.find(
        (r) => Array.isArray((r.fields || {}).webinar) && r.fields.webinar.includes(webinar.id)
      ) || null;
    }

    if (registration) {
      const regId = (registration.fields || {}).registration_id;
      if (regId) {
        const existing = await listRows(QUESTIONS_TABLE, {
          formula: `ARRAYJOIN({registration})='${escFormula(regId)}'`,
          fields: ["question_id"],
          maxRecords: MAX_QUESTIONS_PER_TOKEN + 1,
        });
        if (existing.length >= MAX_QUESTIONS_PER_TOKEN) {
          return res.status(429).json({ error: "You've reached the question limit for this briefing." });
        }
      }
    }

    // Link the contact: token's contact_id, or (open mode) by email. If
    // neither resolves, the row is still created with the link omitted.
    let contact = null;
    try {
      contact = hasValidToken
        ? await findContactByContactId(v.contact_id)
        : (email ? await findContactByEmail(email) : null);
    } catch (e) {
      console.error("webinar-question contact lookup failed:", e.message);
      contact = null;
    }

    const fields = {
      question_id: uuid(),
      registration: registration ? [registration.id] : undefined,
      contact: contact ? [contact.id] : undefined,
      webinar: [webinar.id],
      body: text,
      submitted_at: nowIso(),
    };
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
    const row = await createRow(QUESTIONS_TABLE, fields);
    tokenHits.set(rateKey, memCount + 1);

    // Inline AI triage — best-effort write-back, never blocks the response.
    const verdict = await triageQuestion(text);
    if (verdict) {
      try {
        await updateRow(QUESTIONS_TABLE, row.id, {
          ai_include: verdict.include,
          ai_rationale: verdict.rationale,
        });
      } catch (e) {
        console.error("webinar triage write-back failed:", e.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webinar-question error:", e.message);
    return res.status(500).json({ error: "Couldn't send that. Please try again." });
  }
};
