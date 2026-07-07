// Full signature recount: counts the Contacts table and stores the result in
// Site Stats (key=signature_count) so /api/signature-count is a single cheap
// read. No longer on a 5-minute cron — the count is bumped event-driven at
// contact creation (_airtable.bumpSignatureCount); this full recount runs
// nightly from /api/cron/nightly-rollup to reconcile any drift (Airtable has
// no atomic increment), and stays callable here with the CRON_SECRET bearer
// for a manual resync. Milestone hooks fire on crossings in both paths.
//
// Paginating ~8-10k contacts is ~80-100 Airtable requests; run under the
// 120s maxDuration configured in vercel.json.

const { listRows, findOne, createRow, updateRow, checkMilestones, nowIso } = require("../_airtable");
const { requireCron } = require("../_util");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const STATS_TABLE = process.env.AIRTABLE_STATS_TABLE || "Site Stats";

async function recomputeSignatureCount() {
  const rows = await listRows(CONTACTS, { fields: ["contact_id"] });
  const raw = rows.length;
  const offset = Number(process.env.SIGNATURE_BASE_OFFSET ?? 69500);
  const total = raw + offset;

  const existing = await findOne(STATS_TABLE, `{key}='signature_count'`);
  const prevRaw = Number(existing?.fields?.num_value) || 0;
  const prevTotal = prevRaw + offset;

  if (existing) {
    await updateRow(STATS_TABLE, existing.id, { num_value: raw, updated_at: nowIso() });
  } else {
    await createRow(STATS_TABLE, { key: "signature_count", num_value: raw, updated_at: nowIso() });
  }

  const fired = await checkMilestones(prevTotal, total, { raw, offset });
  return { raw, total, drift: raw - prevRaw, fired };
}

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  try {
    const out = await recomputeSignatureCount();
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error("refresh-signature-count:", e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.recomputeSignatureCount = recomputeSignatureCount;
