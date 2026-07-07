// API-triggered SMS dispatch (no scheduled cron). Signup texts are handed to
// Cellcast's own scheduler (scheduleAt) at signup time; this endpoint drains
// whatever still flows through the queue — the +24h donation nudges and any
// row whose schedule call failed (status "queued").
//
// Triggers:
//   - this endpoint, with the CRON_SECRET bearer (manual / external pinger)
//   - the tail of /api/cron/lapse-sweep (runs every 5 min anyway)
//   - a throttled background kick on /api/signature-count (every page load)

const { requireCron } = require("../_util");
const { dispatchDueSMS } = require("../_cellcast");

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  try {
    const results = await dispatchDueSMS({ maxRows: 50, deadlineMs: 100000 });
    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    console.error("sms-queue:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
