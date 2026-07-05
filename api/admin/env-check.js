// GET /api/admin/env-check (basic auth) — deployment health for the
// donation-maximisation build. Reports which env vars this deployment can
// see (true/false only — never values) and, with ?live=1, makes one cheap
// read-only call per service to prove each key actually works.

const { requireBasicAuth } = require("../_util");

// Allow either admin basic-auth OR the cron bearer, so ops tooling can read
// diagnostics without the admin password.
function authed(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") === `Bearer ${secret}`) return true;
  return requireBasicAuth(req, res);
}

const VARS = [
  // core (pre-existing)
  "STRIPE_SECRET_KEY", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID",
  // rally
  "STRIPE_RALLY_SECRET_KEY", "STRIPE_RALLY_PUBLISHABLE_KEY", "STRIPE_RALLY_WEBHOOK_SECRET",
  "STRIPE_RALLY_ADULT_PRICE_ID", "STRIPE_RALLY_KID_PRICE_ID",
  // donation maximisation build
  "CELLCAST_API_KEY", "CELLCAST_FROM",
  "CN_API_KEY", "CN_API_BASE",
  "CN_AUTOMATION_PETITION_LAPSE_A", "CN_AUTOMATION_PETITION_LAPSE_B",
  "CN_AUTOMATION_DONATION_LAPSE_A", "CN_AUTOMATION_DONATION_LAPSE_B",
  "CN_AUTOMATION_PETITION_LAPSE", "CN_AUTOMATION_DONATION_LAPSE",
  "ADMIN_BASIC_AUTH", "CRON_SECRET",
  "SIGNATURE_BASE_OFFSET", "SIGNATURE_ROUND_DOWN_TO", "SIGNATURE_MILESTONES",
  "MILESTONE_WEBHOOK_URL", "AB_FORCE_VARIANT",
  "SMS_DELAY_MIN_S", "SMS_DELAY_MAX_S", "SMS_QUIET_START", "SMS_QUIET_END",
];

module.exports = async function handler(req, res) {
  if (!authed(req, res)) return;
  const present = {};
  for (const v of VARS) present[v] = !!process.env[v];

  const url = new URL(req.url, "https://x");
  const live = {};
  if (url.searchParams.get("live")) {
    // Airtable: read one Site Stats row.
    try {
      const r = await fetch(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent("Site Stats")}?maxRecords=1`,
        { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } }
      );
      live.airtable = r.ok ? "ok" : `http ${r.status}`;
    } catch (e) { live.airtable = `error: ${e.message.slice(0, 80)}`; }

    // Stripe (donations acct): read-only balance probe.
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const r = await fetch("https://api.stripe.com/v1/balance", {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        });
        live.stripe_donations = r.ok ? "ok" : `http ${r.status}`;
      } catch (e) { live.stripe_donations = `error: ${e.message.slice(0, 80)}`; }
    } else live.stripe_donations = "no key";

    // Cellcast: read the inbound get-responses endpoint (the one the STOP
    // poller uses). meta.status SUCCESS = APPKEY valid.
    if (process.env.CELLCAST_API_KEY) {
      try {
        const r = await fetch("https://cellcast.com.au/api/v3/get-responses?page=1", {
          headers: { APPKEY: process.env.CELLCAST_API_KEY, Accept: "application/json" },
        });
        const j = await r.json().catch(() => ({}));
        live.cellcast = {
          http: r.status,
          meta_status: j.meta?.status ?? null,
          message: j.message ?? null,
          data_total: j.data?.total ?? null,
          items_len: Array.isArray(j.data?.items) ? j.data.items.length : null,
          keys: Object.keys(j || {}).slice(0, 8),
        };
      } catch (e) { live.cellcast = `error: ${e.message.slice(0, 80)}`; }
    } else live.cellcast = "no key";

    // Campaign Nucleus: probe the exact base + auth header the _cn.js client
    // uses in production, so this diagnostic matches the real code path.
    // Try a couple of common auth shapes and report which (if any) is accepted.
    if (process.env.CN_API_KEY) {
      const base = (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/$/, "");
      const shapes = [
        { label: "bearer", headers: { Authorization: `Bearer ${process.env.CN_API_KEY}` } },
        { label: "x-api-key", headers: { "X-Api-Key": process.env.CN_API_KEY } },
        { label: "api-token", headers: { "Api-Token": process.env.CN_API_KEY } },
      ];
      const results = [];
      for (const s of shapes) {
        try {
          // /tenant is a fast, read-only "is this token accepted" check —
          // /profiles enumerates the whole book and 504s on big accounts.
          // eslint-disable-next-line no-await-in-loop
          const r = await fetch(`${base}/tenant`, {
            headers: { ...s.headers, Accept: "application/json" },
          });
          results.push(`${s.label}:${r.status}`);
        } catch (e) { results.push(`${s.label}:err`); }
      }
      live.campaign_nucleus = `base=${base} ${results.join(" ")}`;
    } else live.campaign_nucleus = "no key";
  }

  const missing_required = ["CELLCAST_API_KEY", "CN_API_KEY", "ADMIN_BASIC_AUTH", "CRON_SECRET"]
    .filter((v) => !present[v]);
  const lapse_ready =
    (present.CN_AUTOMATION_PETITION_LAPSE_A && present.CN_AUTOMATION_PETITION_LAPSE_B) || present.CN_AUTOMATION_PETITION_LAPSE;
  const donation_lapse_ready =
    (present.CN_AUTOMATION_DONATION_LAPSE_A && present.CN_AUTOMATION_DONATION_LAPSE_B) || present.CN_AUTOMATION_DONATION_LAPSE;

  return res.status(200).json({
    env: process.env.VERCEL_ENV || "unknown",
    present,
    live: url.searchParams.get("live") ? live : "add ?live=1 for connectivity tests",
    summary: {
      missing_required,
      petition_lapse_automations: lapse_ready ? "configured" : "missing",
      donation_lapse_automations: donation_lapse_ready ? "configured" : "missing",
    },
  });
};
