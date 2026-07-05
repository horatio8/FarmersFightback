// Partial capture (Workstream 4.1): the frontend beacons here on field
// blur once an email or mobile has been typed, before the form is ever
// submitted. Pushes the partial into Campaign Nucleus (tagged) and logs a
// Lapse Queue row that /api/cron/lapse-sweep turns into a lapse email at
// +30 min if no completion appears.
//
// POST /api/partial
//   { form: "petition"|"donation", email?, mobile?, first_name?,
//     last_name?, postcode?, completed?: true }
//
// completed:true is the completion beacon (fired after successful submit):
// swaps the CN tag to *_completed and closes any pending Lapse Queue rows.
// Per the brief, partials live in CN + the lapse queue only — they are NOT
// written into Contacts.

const { createRow, listRows, updateRow, findOne, normEmail, normPhone, uuid, nowIso } = require("./_airtable");
const { cnProfileMatch } = require("./_cn");

const LAPSE_TABLE = process.env.AIRTABLE_LAPSE_TABLE || "Lapse Queue";

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

function esc(s) { return String(s).replace(/'/g, "\\'"); }

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // sendBeacon delivers a Blob body; Vercel may hand it to us unparsed.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const form = body.form === "donation" ? "donation" : "petition";
    const email = normEmail(body.email);
    const mobile = normPhone(body.mobile);
    if (!email && !mobile) return res.status(400).json({ error: "email or mobile required" });
    const first_name = String(body.first_name || "").trim().slice(0, 80) || undefined;
    const last_name = String(body.last_name || "").trim().slice(0, 80) || undefined;
    const postcode = String(body.postcode || "").trim().slice(0, 10) || undefined;

    if (body.completed) {
      // Completion always wins: swap CN tag, close pending lapse rows.
      // Kick the CN write off first so it runs concurrently with the
      // Airtable work, but AWAIT it before responding — on Vercel the
      // lambda can freeze the instant we return, killing an un-awaited
      // fetch mid-flight.
      const cnp = cnProfileMatch({
        email: email || undefined, mobile: mobile || undefined,
        first_name, last_name, zip: postcode,
        tags: [`${form}_completed`],
      }).catch(() => {});
      const idField = email ? `{email}='${esc(email)}'` : `{mobile}='${esc(mobile)}'`;
      const open = await listRows(LAPSE_TABLE, {
        formula: `AND({form}='${form}', {status}='pending', ${idField})`,
        maxRecords: 10,
      }).catch(() => []);
      for (const row of open) {
        // eslint-disable-next-line no-await-in-loop
        await updateRow(LAPSE_TABLE, row.id, { status: "completed", note: "completion beacon" }).catch(() => {});
      }
      await cnp;
      return res.status(200).json({ ok: true, closed: open.length });
    }

    // CN gets the partial immediately (tagged); custom1 carries the ts.
    // Concurrent with the Airtable write below, awaited before we respond.
    const cnp = cnProfileMatch({
      email: email || undefined, mobile: mobile || undefined,
      first_name, last_name, zip: postcode,
      tags: [`${form}_partial`],
      custom1: `partial_ts:${nowIso()}`,
    }).catch(() => {});

    // One pending lapse row per identity+form (client also gates per
    // session, this is the server-side backstop).
    const idField = email ? `{email}='${esc(email)}'` : `{mobile}='${esc(mobile)}'`;
    const existing = await findOne(LAPSE_TABLE, `AND({form}='${form}', {status}='pending', ${idField})`);
    if (!existing) {
      await createRow(LAPSE_TABLE, {
        lapse_id: uuid(),
        form,
        email: email || undefined,
        mobile: mobile || undefined,
        first_name, last_name,
        status: "pending",
        created_at: nowIso(),
      });
    }
    await cnp;
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("partial:", e.message);
    return res.status(200).json({ ok: false }); // never surface errors to the form UX
  }
};
