// The feature register: every switch, dial and timed gate that changes what
// the site does, in one place, each able to report its live state.
//
// Served by GET /api/admin/features. Kept honest by test/unit.js, which scans
// the code for every env var it reads and fails the build if one is neither
// declared here as a feature nor listed below as plain wiring -- so a new
// toggle cannot be added without being tracked.
//
// Entry shape:
//   key       stable id
//   area      grouping for the report
//   name      what a person would call it
//   what      one line on what it changes
//   source    env | code | content | airtable | timed | cron
//   control   exactly where to change it
//   env       env vars this entry accounts for (coverage bookkeeping)
//   code      { file, constant } for code-side gates (checked to still exist)
//   resolve   (ctx) -> { on, value, note }   on: true/false, or null for a dial
//
// Vercel bakes env vars at build time: any env change needs a redeploy.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Credentials, table names, service URLs and secrets. They make the site
// work; they do not choose what it does. Anything the code reads from env
// that is not here must be a registered feature.
const WIRING_ENV = new Set([
  "ADMIN_TOKEN", "ADMIN_BASIC_AUTH", "CRON_SECRET", "IP_HASH_SALT",
  "AIRTABLE_API_KEY", "AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_EVENTS_BASE_ID",
  "AIRTABLE_EVENTS_HISTORY_BASES", "AIRTABLE_EVENTS_TABLE", "AIRTABLE_EVENTS_TABLE_ID",
  "AIRTABLE_CONTACTS_TABLE", "AIRTABLE_LAPSE_TABLE", "AIRTABLE_DONATIONS_TABLE",
  "AIRTABLE_STATS_TABLE", "AIRTABLE_SMS_SENDS_TABLE", "AIRTABLE_SMS_REPLIES_TABLE",
  "AIRTABLE_RALLY_TICKETS_TABLE", "AIRTABLE_RALLY_COMP_TOKENS_TABLE",
  "AIRTABLE_PETITION_SIGNATURES_TABLE", "AIRTABLE_SIGNUPS_TABLE",
  "AIRTABLE_SOCIAL_DAILY_TABLE", "AIRTABLE_REFERRAL_ROLLUP_TABLE",
  "AIRTABLE_AI_USAGE_TABLE", "AIRTABLE_AB_DAILY_TABLE", "AIRTABLE_WEBINARS_TABLE",
  "AIRTABLE_REGISTRATIONS_TABLE", "AIRTABLE_QUESTIONS_TABLE",
  "AIRTABLE_RECEPTION_REGS_TABLE", "AIRTABLE_RECEPTION_INVITES_TABLE",
  "AIRTABLE_BROKEN_LINKS_TABLE", "SURVEY_RESPONSES_TABLE", "SURVEY_CONTACTS_TABLE",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "STRIPE_RALLY_SECRET_KEY", "STRIPE_RALLY_PUBLISHABLE_KEY", "STRIPE_RALLY_WEBHOOK_SECRET",
  "STRIPE_RALLY_ADULT_PRICE_ID", "STRIPE_RALLY_KID_PRICE_ID",
  "CN_API_KEY", "CN_API_BASE", "CN_FUN_FORM_ID",
  "CELLCAST_API_KEY", "CELLCAST_API_BASE", "CELLCAST_FROM", "CELLCAST_WEBHOOK_BASIC",
  "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "META_CAPI_TOKEN", "META_ADS_TOKEN", "META_PIXEL_ID", "META_PAGE_ACCESS_TOKEN",
  "META_APP_SECRET", "META_AD_ACCOUNT_ID", "META_WEBHOOK_VERIFY_TOKEN",
  "ZERNIO_API_KEY", "ZERNIO_WEBHOOK_SECRET", "WEBINAR_TOKEN_SECRET", "RECEPTION_PASSCODE",
  "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "PUBLIC_BASE_URL", "RALLY_SUCCESS_URL_BASE",
  "ADVERTISER_TZ",
]);

const isSet = (n) => process.env[n] !== undefined && process.env[n] !== "";
const num = (n, d) => (isSet(n) && Number.isFinite(Number(process.env[n])) ? Number(process.env[n]) : d);

// Count the promo panels on the homepage by reading the TwinPromos source.
// Reading the file is the honest way to report what is deployed; if the
// bundler did not carry app.jsx along, say so rather than guess.
function homepagePanelCount() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "app.jsx"), "utf8");
    const start = src.indexOf("const panels = [");
    const end = src.indexOf("];", start);
    if (start < 0 || end < 0) return null;
    return (src.slice(start, end).match(/\bkey:\s*"/g) || []).length;
  } catch { return null; }
}

const REGISTER = [
  // ------------------------------------------------------------ donations
  {
    key: "stripe_fundraising_cutover", area: "Donations",
    name: "Fundraising account cutover",
    what: "Which Stripe account NEW donation sessions are created on.",
    source: "timed",
    control: "api/_stripe-fundraising.js  CUTOVER_UTC",
    code: { file: "api/_stripe-fundraising.js", constant: "CUTOVER_UTC" },
    resolve(ctx) {
      const sf = require("../api/_stripe-fundraising");
      const active = sf.fundraisingCutoverActive(ctx.now);
      const key = sf.fundraisingKey(ctx.now);
      const which = !key ? "none configured"
        : key === process.env.STRIPE_FUNDRAISING_SECRET_KEY ? "fundraising override key"
        : key === process.env.STRIPE_RALLY_SECRET_KEY ? "Wallaloo & Gre Gre (rally key)"
        : "legacy shared account";
      return { on: active, value: `cutover ${sf.CUTOVER_UTC}; new sessions -> ${which}`,
        note: active ? "past the cutover" : "before the cutover" };
    },
  },
  {
    key: "stripe_fundraising_key_override", area: "Donations",
    name: "Fundraising key override",
    what: "Replaces the rally key with a dedicated key for post-cutover donations.",
    source: "env", control: "STRIPE_FUNDRAISING_SECRET_KEY (unset = use STRIPE_RALLY_SECRET_KEY)",
    env: ["STRIPE_FUNDRAISING_SECRET_KEY"],
    resolve: () => ({ on: isSet("STRIPE_FUNDRAISING_SECRET_KEY"), value: isSet("STRIPE_FUNDRAISING_SECRET_KEY") ? "set" : "unset (rally key in use)" }),
  },
  {
    key: "stripe_fundraising_webhook_override", area: "Donations",
    name: "Second webhook secret on /api/stripe-webhook",
    what: "Lets a W&G endpoint pointed at /api/stripe-webhook verify; normally W&G delivers to /api/rally-webhook instead.",
    source: "env", control: "STRIPE_FUNDRAISING_WEBHOOK_SECRET",
    env: ["STRIPE_FUNDRAISING_WEBHOOK_SECRET"],
    resolve: () => ({ on: isSet("STRIPE_FUNDRAISING_WEBHOOK_SECRET"), value: isSet("STRIPE_FUNDRAISING_WEBHOOK_SECRET") ? "set" : "unset" }),
  },

  // ------------------------------------------------------------- petition
  {
    key: "petition_share_split", area: "Petition",
    name: "Post-sign destination split",
    what: "Share of signers sent to /share instead of the /donate ask, after any form.",
    source: "env", control: "PETITION_SHARE_PERCENT = 0..100 (unset = 0, everyone to /donate)",
    env: ["PETITION_SHARE_PERCENT"],
    resolve() {
      const raw = Number(process.env.PETITION_SHARE_PERCENT);
      const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
      return { on: pct > 0, value: `${pct}% -> /share, ${100 - pct}% -> /donate` };
    },
  },
  {
    key: "petition_thanks_fallback", area: "Petition",
    name: "Client fallback destination",
    what: "Where the browser sends a signer if the API gives no verdict.",
    source: "code", control: "app.jsx  PETITION_THANKS_FALLBACK",
    code: { file: "app.jsx", constant: "PETITION_THANKS_FALLBACK" },
    resolve() {
      try {
        const m = fs.readFileSync(path.join(ROOT, "app.jsx"), "utf8").match(/const PETITION_THANKS_FALLBACK = "([^"]+)"/);
        return { on: null, value: m ? m[1] : "unreadable" };
      } catch { return { on: null, value: "unreadable" }; }
    },
  },
  {
    key: "signature_milestone_alerts", area: "Petition",
    name: "Signature milestone alerts",
    what: "Posts to a webhook when the live count crosses a milestone.",
    source: "env", control: "MILESTONE_WEBHOOK_URL (unset = off); SIGNATURE_MILESTONES = comma list",
    env: ["MILESTONE_WEBHOOK_URL", "SIGNATURE_MILESTONES"],
    resolve: () => ({ on: isSet("MILESTONE_WEBHOOK_URL"),
      value: `milestones ${process.env.SIGNATURE_MILESTONES || "90000,95000,100000 (default)"}` }),
  },

  // ---------------------------------------------------- signature counter
  {
    key: "signature_base_offset", area: "Signature counter",
    name: "Counter base offset",
    what: "Added to the Airtable contact count before it is shown publicly.",
    source: "env", control: "SIGNATURE_BASE_OFFSET (default 69500)",
    env: ["SIGNATURE_BASE_OFFSET"],
    resolve: () => ({ on: null, value: String(num("SIGNATURE_BASE_OFFSET", 69500)) }),
  },
  {
    key: "signature_round_down", area: "Signature counter",
    name: "Counter rounding",
    what: "Rounds the public count down to a multiple, so it moves in steps.",
    source: "env", control: "SIGNATURE_ROUND_DOWN_TO (unset/0 = exact count)",
    env: ["SIGNATURE_ROUND_DOWN_TO"],
    resolve() { const r = num("SIGNATURE_ROUND_DOWN_TO", 0); return { on: r > 0, value: r > 0 ? `nearest ${r}` : "exact" }; },
  },
  {
    key: "top_banner", area: "Signature counter",
    name: "Signature-count top banner",
    what: "The site-wide bar with the live signature count.",
    source: "content", control: "content/site.json  topBanner.enabled",
    resolve: (ctx) => ({ on: !!(ctx.site && ctx.site.topBanner && ctx.site.topBanner.enabled),
      value: ctx.site && ctx.site.topBanner ? `"${ctx.site.topBanner.boldText} ${ctx.site.topBanner.text}"` : "unreadable" }),
  },

  // ----------------------------------------------------------------- shop
  {
    key: "shop_page", area: "Shop",
    name: "Merch shop page (/shop)",
    what: "The catalogue page that reads the Shopify store's product feed and sends buyers to Shopify checkout. Also the Shop entry in the nav and footer.",
    source: "content", control: "content/site.json  shop.enabled (nav/footer links: nav.items / footer.columns)",
    resolve: (ctx) => {
      const s = (ctx.site && ctx.site.shop) || {};
      const inNav = !!(ctx.site && ctx.site.nav && ctx.site.nav.items.some((i) => i.href === "/shop"));
      return { on: !!s.enabled, value: s.storeUrl || "https://shop.farmersfightback.com",
        note: inNav ? "linked from the nav" : "not in the nav" };
    },
  },
  {
    key: "shop_homepage_band", area: "Shop",
    name: "Homepage merch strip",
    what: "Four featured products on the homepage, above the quote. Hides itself if the catalogue cannot be read.",
    source: "content", control: "content/site.json  shop.homepageBand / shop.featured",
    resolve: (ctx) => {
      const s = (ctx.site && ctx.site.shop) || {};
      return { on: !!(s.enabled && s.homepageBand), value: `featured: ${(s.featured || []).join(", ") || "first four"}` };
    },
  },

  // ------------------------------------------------------------------ sms
  {
    key: "signup_sms", area: "SMS",
    name: "Automated text after signing",
    what: "One A/B text to each new signer with a mobile, 15-55s after signing.",
    source: "env", control: "SIGNUP_SMS_ENABLED=0 to stop (default on since 1 Sep 2026)",
    env: ["SIGNUP_SMS_ENABLED"],
    resolve: () => ({ on: process.env.SIGNUP_SMS_ENABLED !== "0", value: process.env.SIGNUP_SMS_ENABLED === "0" ? "kill switch set" : "sending" }),
  },
  {
    key: "sms_ab_force", area: "SMS",
    name: "Force signup A/B variant",
    what: "Overrides the 50/50 split so every signup text is one variant.",
    source: "env", control: "AB_FORCE_VARIANT = A | B (unset/off = 50/50)",
    env: ["AB_FORCE_VARIANT"],
    resolve() { const f = String(process.env.AB_FORCE_VARIANT || "off").toUpperCase(); return { on: f === "A" || f === "B", value: f === "A" || f === "B" ? `all ${f}` : "50/50" }; },
  },
  {
    key: "sms_quiet_hours", area: "SMS",
    name: "Quiet hours",
    what: "Texts outside this Melbourne window are held until it reopens.",
    source: "env", control: "SMS_QUIET_START / SMS_QUIET_END as HH:MM (default 08:00-20:00)",
    env: ["SMS_QUIET_START", "SMS_QUIET_END"],
    resolve: () => ({ on: true, value: `${process.env.SMS_QUIET_START || "08:00"}-${process.env.SMS_QUIET_END || "20:00"} Melbourne` }),
  },
  {
    key: "sms_signup_delay", area: "SMS",
    name: "Signup text delay",
    what: "Random delay before the signup text, so it does not land mid-form.",
    source: "env", control: "SMS_DELAY_MIN_S / SMS_DELAY_MAX_S (default 15-55)",
    env: ["SMS_DELAY_MIN_S", "SMS_DELAY_MAX_S"],
    resolve: () => ({ on: null, value: `${num("SMS_DELAY_MIN_S", 15)}-${num("SMS_DELAY_MAX_S", 55)}s` }),
  },
  {
    key: "sms_contact_ref_link", area: "SMS",
    name: "Referral code in text links",
    what: "Appends the signer's own referral code to links in their text.",
    source: "env", control: "SMS_INCLUDE_CONTACT_REF=0 to drop it (default on)",
    env: ["SMS_INCLUDE_CONTACT_REF"],
    resolve: () => ({ on: process.env.SMS_INCLUDE_CONTACT_REF !== "0", value: process.env.SMS_INCLUDE_CONTACT_REF !== "0" ? "included" : "omitted" }),
  },
  {
    key: "sms_inbound_forward", area: "SMS",
    name: "Forward inbound replies",
    what: "Copies every inbound SMS reply to an external URL (STOP handling is unaffected).",
    source: "env", control: "CELLCAST_FORWARD_URL (unset = off)",
    env: ["CELLCAST_FORWARD_URL"],
    resolve: () => ({ on: isSet("CELLCAST_FORWARD_URL"), value: isSet("CELLCAST_FORWARD_URL") ? "forwarding" : "off" }),
  },

  // -------------------------------------------------------------- tickets
  {
    key: "ticket_sales", area: "Tickets",
    name: "Fundraiser ticket sales",
    what: "Whether /fundraiser still sells tickets: closes at a time or at the cap.",
    source: "timed", control: "api/_rally.js  SALES_CLOSE_UTC, TICKET_CAP",
    code: { file: "api/_rally.js", constant: "SALES_CLOSE_UTC" },
    resolve(ctx) {
      const r = require("../api/_rally");
      const open = ctx.now.getTime() < Date.parse(r.SALES_CLOSE_UTC);
      return { on: open, value: `closes ${r.SALES_CLOSE_UTC}; cap ${r.TICKET_CAP}`, note: open ? "time window open (cap checked live)" : "closed by time" };
    },
  },
  {
    key: "rally_comp_token_fallback", area: "Tickets",
    name: "Comp-ticket fallback tokens",
    what: "Env-listed comp tokens honoured when the Airtable token table is unreachable.",
    source: "env", control: "RALLY_COMP_TOKEN_FALLBACK = comma list (unset = Airtable only)",
    env: ["RALLY_COMP_TOKEN_FALLBACK"],
    resolve: () => ({ on: isSet("RALLY_COMP_TOKEN_FALLBACK"), value: isSet("RALLY_COMP_TOKEN_FALLBACK") ? `${process.env.RALLY_COMP_TOKEN_FALLBACK.split(",").filter(Boolean).length} token(s)` : "none" }),
  },

  // ------------------------------------------------------------- homepage
  {
    key: "homepage_promo_panels", area: "Homepage & content",
    name: "Promo panels under the hero",
    what: "The campaign cards on the homepage (one card centres itself; two make a grid).",
    source: "code", control: "app.jsx  TwinPromos()  panels[]",
    code: { file: "app.jsx", constant: "TwinPromos" },
    resolve() { const n = homepagePanelCount(); return { on: n === null ? null : n > 0, value: n === null ? "unreadable" : `${n} panel(s)` }; },
  },
  {
    key: "nav_items", area: "Homepage & content",
    name: "Navigation menu",
    what: "Which pages appear in the menu; disabled children stay hidden.",
    source: "content", control: "content/site.json  nav.items[] (active / children[].disabled)",
    resolve(ctx) {
      const items = (ctx.site && ctx.site.nav && ctx.site.nav.items) || [];
      const shown = [];
      const hidden = [];
      for (const it of items) {
        shown.push(it.label);
        for (const c of it.children || []) (c.disabled ? hidden : shown).push(c.label);
      }
      return { on: null, value: `shown: ${shown.join(", ")}${hidden.length ? `; hidden: ${hidden.join(", ")}` : ""}` };
    },
  },
  {
    key: "social_proof_popups", area: "Homepage & content",
    name: "Social-proof popups",
    what: "The bottom-right 'X just signed' toasts. No switch: mounted directly.",
    source: "code", control: "app.jsx  <SocialProofPopup /> (remove the mount to turn off)",
    code: { file: "app.jsx", constant: "SP_INTERVAL" },
    resolve() {
      try {
        const n = (fs.readFileSync(path.join(ROOT, "app.jsx"), "utf8").match(/<SocialProofPopup \/>/g) || []).length;
        return { on: n > 0, value: `mounted on ${n} page(s)` };
      } catch { return { on: null, value: "unreadable" }; }
    },
  },

  // ----------------------------------------------------------- ads & econ
  {
    key: "cpa_alerts", area: "Ads & economics",
    name: "Cost-per-acquisition alerts",
    what: "Pop-up (and optional SMS) when an ad's CPA runs hot.",
    source: "airtable", control: "Site Stats row key=econ_settings (JSON, no redeploy); env CPA_ALERT_THRESHOLD / ALERT_MIN_SPEND / ALERT_WINDOW_HOURS / ALERT_MOBILE are the defaults",
    env: ["CPA_ALERT_THRESHOLD", "ALERT_MIN_SPEND", "ALERT_WINDOW_HOURS", "ALERT_MOBILE"],
    resolve(ctx) {
      const s = ctx.airtable && ctx.airtable.econ_settings;
      if (!s) return { on: true, value: `defaults: cpa>${num("CPA_ALERT_THRESHOLD", 2.5)}, spend>=${num("ALERT_MIN_SPEND", 15)}, ${num("ALERT_WINDOW_HOURS", 3)}h; sms ${isSet("ALERT_MOBILE") ? "on" : "off"}`, note: "Airtable row not read" };
      return { on: true, value: `cpa>${s.cpa_threshold}, spend>=${s.min_spend}, ${s.window_hours}h; sms ${s.sms_mobile ? "on" : "off"}`, note: "live from Airtable" };
    },
  },
  {
    key: "journey_signup_window", area: "Ads & economics",
    name: "'Donated at signup' window",
    what: "How soon after signing a gift counts as donated-at-signup in donor-journey classification.",
    source: "env", control: "JOURNEY_SIGNUP_WINDOW_HOURS (default 24)",
    env: ["JOURNEY_SIGNUP_WINDOW_HOURS"],
    resolve: () => ({ on: null, value: `${num("JOURNEY_SIGNUP_WINDOW_HOURS", 24)}h` }),
  },
  {
    key: "ai_rewrite_cap", area: "Ads & economics",
    name: "AI email-rewrite daily cap",
    what: "Max AI rewrites per day on the send-your-email page before it stops spending.",
    source: "env", control: "AI_REWRITE_DAILY_CAP (default 500)",
    env: ["AI_REWRITE_DAILY_CAP"],
    resolve: () => ({ on: true, value: `${num("AI_REWRITE_DAILY_CAP", 500)}/day` }),
  },

  // ----------------------------------------------------- referrals & CN
  {
    key: "cn_uid_backfill", area: "Referrals & Nucleus",
    name: "Referral-code backfill into Nucleus",
    what: "Cron-driven walk writing each contact's code to the FarmersFightback_UID merge field.",
    source: "airtable", control: "Sync State row key=cn_uid_backfill; driven by the survey-uids cron; &reset=1 restarts",
    resolve(ctx) {
      const s = ctx.airtable && ctx.airtable.cn_uid_backfill;
      if (!s) return { on: null, value: "state not read" };
      return { on: !s.done, value: s.done ? `done: ${s.total_pushed} pushed, ${s.total_failed} failed` : `running: ${s.total_pushed || 0} pushed, ${s.total_failed || 0} failed, ${s.runs || 0} runs` };
    },
  },
  {
    key: "cn_receiver_routing", area: "Referrals & Nucleus",
    name: "Per-petition Nucleus receivers",
    what: "Routes event-log pushes to a different CN receiver per petition slug.",
    source: "env", control: "CN_RECEIVER_URLS = JSON {slug: url} (unset = single default receiver)",
    env: ["CN_RECEIVER_URLS"],
    resolve() {
      try { const m = JSON.parse(process.env.CN_RECEIVER_URLS || "{}"); const k = Object.keys(m); return { on: k.length > 0, value: k.length ? `routes: ${k.join(", ")}` : "default receiver" }; }
      catch { return { on: false, value: "invalid JSON" }; }
    },
  },
];

// Every scheduled job is a feature that is on by virtue of being listed.
function cronEntries(vercel) {
  return ((vercel && vercel.crons) || []).map((c) => ({
    key: `cron:${c.path.split("?")[0].replace(/^\/api\//, "")}`,
    area: "Scheduled jobs",
    name: c.path.split("?")[0].replace(/^\/api\/(cron|admin)\//, ""),
    what: `Runs ${c.path} on schedule "${c.schedule}".`,
    source: "cron",
    control: "vercel.json  crons[] (remove the entry to stop it)",
    on: true,
    value: c.schedule,
  }));
}

function evaluate(ctx) {
  const now = ctx.now || new Date();
  const out = [];
  for (const f of REGISTER) {
    let state;
    try { state = f.resolve({ ...ctx, now }); }
    catch (e) { state = { on: null, value: "error", note: String(e.message).slice(0, 120) }; }
    out.push({ key: f.key, area: f.area, name: f.name, what: f.what, source: f.source, control: f.control, ...state });
  }
  return out.concat(cronEntries(ctx.vercel));
}

// A fixed-width rendering for a terminal or a quick read.
function renderText(rows, header = {}) {
  const st = (r) => (r.on === true ? "ON " : r.on === false ? "OFF" : " - ");
  const lines = [];
  if (header.env) lines.push(`Feature register  ·  ${header.env}  ·  ${header.generated_at}`, "");
  let area = null;
  for (const r of rows) {
    if (r.area !== area) { area = r.area; lines.push(`## ${area}`); }
    lines.push(`  [${st(r)}] ${r.name}`);
    lines.push(`        ${r.value}${r.note ? `  (${r.note})` : ""}`);
    lines.push(`        change: ${r.control}`);
  }
  return lines.join("\n") + "\n";
}

module.exports = { REGISTER, WIRING_ENV, evaluate, renderText, cronEntries };
