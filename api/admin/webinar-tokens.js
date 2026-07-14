// Admin: mint donor webinar magic-link tokens (spec §4.3 / §9).
//
// GET /api/admin/webinar-tokens?session=tuesday&days=30
//   → text/csv attachment: email,first_name,token,url — one row per contact
//     whose status is "Donor Only" or "Signatory + Donor" and who has an
//     email address.
// GET /api/admin/webinar-tokens?session=tuesday&days=30&email=x@y.com
//   → JSON { email, token, url } for that single contact.
//
// Guarded by ADMIN_BASIC_AUTH (same guard as /api/ab-report). Requires
// WEBINAR_TOKEN_SECRET — 503 otherwise. Tokens are signed + stateless, so
// this endpoint can be re-run any time (new expiry, same contact identity).

const { listRows, normEmail } = require("../_airtable");
const { requireBasicAuth, hostBase } = require("../_util");
const {
  CONTACTS_TABLE,
  isConfigured,
  mintToken,
  escFormula,
  normSession,
} = require("../_webinar");

const PUBLIC_BASE = "https://www.farmersfightback.com";

function csvCell(s) {
  const v = String(s == null ? "" : s);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

module.exports = async function handler(req, res) {
  if (!requireBasicAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!isConfigured()) return res.status(503).json({ error: "not configured" });

  const url = new URL(req.url, hostBase(req));
  const session = normSession(url.searchParams.get("session") || "tuesday");
  if (!session) return res.status(400).json({ error: "invalid session slug" });
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const email = normEmail(url.searchParams.get("email"));

  const makeUrl = (token) => `${PUBLIC_BASE}/${session}?t=${token}`;

  try {
    if (email) {
      const rows = await listRows(CONTACTS_TABLE, {
        formula: `LOWER({email})='${escFormula(email)}'`,
        fields: ["contact_id", "email", "first_name"],
        maxRecords: 1,
      });
      const contact = rows[0];
      const contactId = contact && (contact.fields || {}).contact_id;
      if (!contactId) return res.status(404).json({ error: "no contact with that email" });
      const token = mintToken({ contact_id: contactId, session, expDays: days });
      return res.status(200).json({ email, token, url: makeUrl(token) });
    }

    // Full donor list: status "Donor Only" or "Signatory + Donor" with an email.
    const contacts = await listRows(CONTACTS_TABLE, {
      formula: `AND(OR({status}='Donor Only',{status}='Signatory + Donor'),{email}!='',{contact_id}!='')`,
      fields: ["contact_id", "email", "first_name"],
    });

    const lines = ["email,first_name,token,url"];
    for (const c of contacts) {
      const f = c.fields || {};
      if (!f.contact_id || !f.email) continue;
      const token = mintToken({ contact_id: f.contact_id, session, expDays: days });
      lines.push([csvCell(f.email), csvCell(f.first_name || ""), csvCell(token), csvCell(makeUrl(token))].join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="webinar-tokens-${session}.csv"`);
    return res.status(200).send(lines.join("\r\n") + "\r\n");
  } catch (e) {
    console.error("webinar-tokens error:", e.message);
    return res.status(500).json({ error: "token mint failed" });
  }
};
