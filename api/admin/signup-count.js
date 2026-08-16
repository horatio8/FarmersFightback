// Count what the Signups ledger actually holds for an email-action campaign.
//
// GET /api/admin/signup-count?token=ADMIN_TOKEN&campaign=demand-carroll
//
// Airtable has no count API and its search caps out well below the size of
// this table, so the only honest way to a total is to page the whole filtered
// set and tally. Read-only: it creates, updates and deletes nothing.
//
// Why this matters: send_clicked is the site's own record of someone pressing
// Send, and unlike the BCC mailbox it does not depend on the supporter's mail
// client honouring a bcc: header. It undercounts in a different way — the
// capture beacon dropped roughly one session in ten before the seq fix — so
// the two sources bracket the true number rather than either being the answer.

const { listPage } = require("../_airtable");
const { requireBasicAuth } = require("../_util");

const SIGNUPS = process.env.AIRTABLE_SIGNUPS_TABLE || "Signups";
const PAGE_BUDGET_MS = 240000;

function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

function authed(req, res) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || "";
  const tokenOk = Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
  const cronOk = Boolean(process.env.CRON_SECRET)
    && (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET}`;
  if (tokenOk || cronOk) return true;
  return requireBasicAuth(req, res);
}

module.exports = async function handler(req, res) {
  if (!authed(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const url = new URL(req.url, "https://x");
  const campaign = (url.searchParams.get("campaign") || "").trim();

  const formula = campaign ? `{utm_campaign}='${esc(campaign)}'` : "";
  const started = Date.now();

  const stats = {
    campaign: campaign || "(all)",
    rows: 0,
    complete: 0,
    partial: 0,
    send_clicked: 0,
    with_email: 0,
    unique_emails: 0,
    unique_emails_sent: 0,
  };
  const seen = new Set();
  const seenSent = new Set();
  const sentByDay = {};
  const rowsByDay = {};

  let offset;
  let pages = 0;
  try {
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await listPage(SIGNUPS, {
        formula: formula || undefined,
        fields: ["email", "status", "send_clicked", "created_at", "utm_campaign"],
        pageSize: 100,
        offset,
      });
      pages += 1;
      for (const rec of page.records) {
        const f = rec.fields || {};
        stats.rows += 1;
        const status = f.status && f.status.name ? f.status.name : f.status;
        if (status === "complete") stats.complete += 1; else stats.partial += 1;

        const email = String(f.email || "").trim().toLowerCase();
        if (email) { stats.with_email += 1; seen.add(email); }

        const day = String(f.created_at || "").slice(0, 10);
        if (day) rowsByDay[day] = (rowsByDay[day] || 0) + 1;

        if (f.send_clicked === true) {
          stats.send_clicked += 1;
          if (email) seenSent.add(email);
          if (day) sentByDay[day] = (sentByDay[day] || 0) + 1;
        }
      }
      offset = page.offset;
      if (Date.now() - started > PAGE_BUDGET_MS) {
        stats.truncated = true;
        stats.note = "stopped on time budget; counts are partial";
        break;
      }
    } while (offset);
  } catch (e) {
    console.error("signup-count:", e.message);
    return res.status(500).json({ error: "count failed", detail: e.message.slice(0, 200) });
  }

  stats.unique_emails = seen.size;
  stats.unique_emails_sent = seenSent.size;
  stats.pages = pages;
  stats.took_ms = Date.now() - started;

  return res.status(200).json({
    ok: true,
    stats,
    sent_by_day: Object.fromEntries(Object.entries(sentByDay).sort()),
    rows_by_day: Object.fromEntries(Object.entries(rowsByDay).sort()),
  });
};
