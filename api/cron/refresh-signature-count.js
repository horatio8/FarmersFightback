// Cron (every 5 min): count the Contacts table and store the result in
// Site Stats (key=signature_count) so /api/signature-count is a single
// cheap read. Also fires milestone hooks when (count + offset) crosses a
// configured threshold — logs a "Milestone Crossed" event and optionally
// POSTs MILESTONE_WEBHOOK_URL (for the "100k unleash" moment).
//
// Paginating ~8-10k contacts is ~80-100 Airtable requests; run under the
// 120s maxDuration configured in vercel.json, comfortably inside the
// 5 req/s base rate limit.

const { listRows, findOne, createRow, updateRow, logEvent, nowIso } = require("../_airtable");
const { requireCron } = require("../_util");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const STATS_TABLE = process.env.AIRTABLE_STATS_TABLE || "Site Stats";

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  try {
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

    // Milestone hooks (thresholds include the offset, i.e. the public number).
    const fired = [];
    const milestones = String(process.env.SIGNATURE_MILESTONES || "90000,95000,100000")
      .split(",").map((s) => Number(s.trim())).filter(Boolean);
    for (const m of milestones) {
      if (prevTotal < m && total >= m) {
        fired.push(m);
        await logEvent({
          event_type: "Milestone Crossed",
          payload: { milestone: m, total, raw, offset },
          source_channel: "Direct",
          fanout: false,
        }).catch((e) => console.error("milestone log:", e.message));
        if (process.env.MILESTONE_WEBHOOK_URL) {
          fetch(process.env.MILESTONE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `🎉 Signature count crossed ${m.toLocaleString()} — now ${total.toLocaleString()}` }),
          }).catch((e) => console.error("milestone webhook:", e.message));
        }
      }
    }

    return res.status(200).json({ ok: true, raw, total, fired });
  } catch (e) {
    console.error("refresh-signature-count:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
