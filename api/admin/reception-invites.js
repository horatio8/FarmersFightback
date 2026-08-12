// Admin: issue and track invitations to the private reception.
//
//   POST /api/admin/reception-invites?token=ADMIN_TOKEN
//     Body: { emails: ["a@b.com", ...] }  or
//           { people: [{ email, first_name, last_name, mobile, guests_allowed }] }
//     → mints one invitation per person. Idempotent on email: re-running keeps
//       the existing token, so a re-send never invalidates a link already in
//       someone's inbox. Names and mobile are filled from Contacts when the
//       email matches a known supporter, and the contact is linked.
//
//   GET /api/admin/reception-invites?token=ADMIN_TOKEN&mode=list
//     → every invitation with status and RSVP counts.
//
//   GET ...&mode=csv
//     → email,first_name,FF_ReceptionURL — upload to CN > Contacts > Import,
//       map the URL column to a CRM custom field, and the invite email can
//       carry it as a merge tag. The URL is the secret, so this CSV is
//       sensitive: it is the guest list and the keys to it in one file.
//
//   POST ...&mode=cancel  Body: { emails: [...] }  → revokes those links.
//
// Guarded by ADMIN_TOKEN or ADMIN_BASIC_AUTH.

const R = require("../reception/_lib");
const { requireBasicAuth, hostBase } = require("../_util");
const { findContactByEmail, normEmail } = require("../_airtable");

const PUBLIC_BASE = "https://www.farmersfightback.com";

function csvCell(s) {
  const v = String(s == null ? "" : s);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function inviteUrl(token) {
  return `${PUBLIC_BASE}/reception?t=${encodeURIComponent(token)}`;
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

// Walk every invite row (the list is small — hundreds at most).
async function allInvites() {
  const out = [];
  let offset;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await R.listPage(R.INVITES, { pageSize: 100, offset });
    out.push(...page.records);
    offset = page.offset;
  } while (offset);
  return out;
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, hostBase(req));
  const token = url.searchParams.get("token") || req.headers["x-admin-token"];
  const tokenOk = Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
  if (!tokenOk && !requireBasicAuth(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const mode = (url.searchParams.get("mode") || (req.method === "POST" ? "mint" : "list")).toLowerCase();

  try {
    if (req.method === "GET") {
      const rows = await allInvites();
      if (mode === "csv") {
        const head = "email,first_name,FF_ReceptionURL";
        const body = rows
          .map((r) => r.fields || {})
          .filter((f) => f.email && f.invite_token && f.status !== "Cancelled")
          .map((f) => [csvCell(f.email), csvCell(f.first_name || ""), csvCell(inviteUrl(f.invite_token))].join(","));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="ff-reception-invites-${body.length}.csv"`);
        return res.status(200).send([head, ...body].join("\r\n") + "\r\n");
      }
      const counts = { invited: 0, registered: 0, declined: 0, cancelled: 0 };
      const list = rows.map((r) => {
        const f = r.fields || {};
        const s = String(f.status || "Invited").toLowerCase();
        if (counts[s] !== undefined) counts[s] += 1;
        return {
          email: f.email || "",
          name: `${f.first_name || ""} ${f.last_name || ""}`.trim(),
          status: f.status || "Invited",
          guests_allowed: f.guests_allowed ?? 1,
          url: inviteUrl(f.invite_token),
        };
      });
      return res.status(200).json({ ok: true, event: R.EVENT, total: list.length, counts, invites: list });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

    const body = readBody(req);
    const rows = await allInvites();
    const byEmail = new Map();
    for (const r of rows) {
      const e = normEmail((r.fields || {}).email || "");
      if (e) byEmail.set(e, r);
    }

    if (mode === "cancel") {
      const emails = (body.emails || []).map(normEmail).filter(Boolean);
      const updates = [];
      for (const e of emails) {
        const rec = byEmail.get(e);
        if (rec) updates.push({ id: rec.id, fields: { status: "Cancelled" } });
      }
      if (updates.length) await R.update(R.INVITES, updates);
      return res.status(200).json({ ok: true, cancelled: updates.length, not_found: emails.length - updates.length });
    }

    // mint
    const people = Array.isArray(body.people) && body.people.length
      ? body.people
      : (body.emails || []).map((e) => ({ email: e }));
    if (!people.length) return res.status(400).json({ error: "pass emails[] or people[]" });
    if (people.length > 500) return res.status(400).json({ error: "500 at a time" });

    const defaultGuests = Number.isFinite(Number(body.guests_allowed)) ? Number(body.guests_allowed) : 1;
    const created = [];
    const reused = [];
    const toCreate = [];

    for (const p of people) {
      const email = normEmail(p.email);
      if (!email || !R.validEmail(email)) continue;
      const existing = byEmail.get(email);
      if (existing) {
        reused.push({ email, url: inviteUrl((existing.fields || {}).invite_token) });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const contact = await findContactByEmail(email).catch(() => null);
      const cf = (contact && contact.fields) || {};
      const tok = R.mintToken();
      toCreate.push({
        invite_token: tok,
        first_name: R.cleanStr(p.first_name || cf.first_name, 60),
        last_name: R.cleanStr(p.last_name || cf.last_name, 60),
        email,
        mobile: R.cleanStr(p.mobile || cf.mobile, 20),
        status: "Invited",
        guests_allowed: Number.isFinite(Number(p.guests_allowed)) ? Number(p.guests_allowed) : defaultGuests,
        ...(contact ? { contact: [contact.id] } : {}),
        issued_at: new Date().toISOString(),
      });
      created.push({ email, url: inviteUrl(tok) });
    }

    if (toCreate.length) await R.create(R.INVITES, toCreate);
    return res.status(200).json({
      ok: true,
      minted: created.length,
      already_had_one: reused.length,
      invites: created,
      reused,
    });
  } catch (e) {
    console.error("reception-invites:", e.message);
    return res.status(500).json({ error: "failed", detail: e.message });
  }
};
