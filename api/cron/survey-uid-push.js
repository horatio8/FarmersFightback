// Nightly top-up of the CN survey-link field.
//
// The one-off backfill (survey-uids?mode=bulk) loaded every existing contact's
// referral_code into the Campaign Nucleus custom field behind the
// %recipient.FarmersFightback_UID% merge tag. This cron keeps it current:
// each night it pushes contacts CREATED since the last run, so anyone who
// signs the petition today can be emailed a tokenised survey link tomorrow.
//
// Watermark: cn_uid_push_watermark in Sync State, advanced only when the walk
// fully drains (a partial walk keeps the old watermark so nothing is skipped).
// Pushes are match-or-update in CN, so the re-check overlap is harmless.
//
// Auth: Vercel cron bearer (CRON_SECRET) or ?token=ADMIN_TOKEN for manual runs.

const { listPage } = require("../_airtable");
const { cnSetUidBulkSafe } = require("../_cn");
const { select, create, update, fesc } = require("../../lib/social/airtable");
const { TABLES } = require("../../lib/econ/config");

const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const FIELDS = ["email", "mobile", "first_name", "last_name", "referral_code"];
const WM_KEY = "cn_uid_push_watermark";
const OVERLAP_MS = 6 * 3600 * 1000; // re-check 6h behind the watermark
const BUDGET_MS = 100 * 1000; // vercel.json allows 120s
const CHUNK = 250;

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || "";
  const url = new URL(req.url, "https://x");
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const tokenOk = process.env.ADMIN_TOKEN && url.searchParams.get("token") === process.env.ADMIN_TOKEN;
  if (!cronOk && !tokenOk) return res.status(401).json({ error: "unauthorized" });

  const started = Date.now();
  const runStartIso = new Date().toISOString();

  try {
    const wmRows = await select(TABLES.SYNC_STATE, `{key} = '${fesc(WM_KEY)}'`, null, 1);
    const wmValue = wmRows.length && wmRows[0].fields && wmRows[0].fields.value;
    // First run before the watermark exists only sweeps the last two days —
    // history is the backfill's job, not this cron's.
    const wm = wmValue ? new Date(wmValue) : new Date(Date.now() - 2 * 864e5);
    const sinceIso = new Date(wm.getTime() - OVERLAP_MS).toISOString();

    const formula =
      `AND({referral_code}!='',OR({email}!='',{mobile}!=''),` +
      `IS_AFTER(CREATED_TIME(),'${sinceIso}'))`;

    let cursor;
    let seen = 0, pushed = 0, skipped = 0, failed = 0;
    let firstErr = null;
    let buf = [];
    const flush = async () => {
      if (!buf.length) return;
      const out = await cnSetUidBulkSafe(buf);
      pushed += out.pushed; skipped += out.skipped; failed += out.failed;
      if (out.err && !firstErr) firstErr = out.err;
      buf = [];
    };

    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await listPage(CONTACTS_TABLE, {
        formula,
        fields: FIELDS,
        pageSize: 100,
        offset: cursor,
      });
      for (const r of page.records) {
        const f = r.fields || {};
        seen += 1;
        buf.push({
          first_name: f.first_name,
          last_name: f.last_name,
          email: f.email,
          mobile: f.mobile,
          uid: f.referral_code,
        });
        // eslint-disable-next-line no-await-in-loop
        if (buf.length >= CHUNK) await flush();
      }
      cursor = page.offset || null;
    } while (cursor && Date.now() - started < BUDGET_MS);
    await flush();

    // Advance the watermark only on a drained walk; a partial one leaves it
    // where it was so tonight's stragglers are re-swept tomorrow.
    const drained = !cursor;
    if (drained) {
      const fields = { key: WM_KEY, value: runStartIso, updated_at: new Date().toISOString() };
      if (wmRows.length) await update(TABLES.SYNC_STATE, [{ id: wmRows[0].id, fields }]);
      else await create(TABLES.SYNC_STATE, [fields]);
    }

    return res.status(200).json({
      ok: true,
      since: sinceIso,
      seen,
      pushed,
      skipped,
      failed,
      drained,
      watermark_advanced: drained,
      ...(firstErr ? { first_error: firstErr } : {}),
    });
  } catch (e) {
    console.error("survey-uid-push:", e.message);
    return res.status(500).json({ error: "failed", detail: e.message });
  }
};
