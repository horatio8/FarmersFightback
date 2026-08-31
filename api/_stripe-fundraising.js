// The fundraising Stripe account switch. From CUTOVER_UTC (midnight
// Melbourne, 1 Sep 2026) every NEW donation checkout session is created on
// the Wallaloo and Gre Gre District Alliance account — the same account
// that already takes rally ticket money — instead of the legacy shared
// donations account. Deployed ahead of time; the flip happens on the clock,
// same pattern as SALES_CLOSE_UTC in _rally.js.
//
// No new credentials are needed: the W&G account is already wired in as
// STRIPE_RALLY_SECRET_KEY (and its webhook endpoint, verified by
// STRIPE_RALLY_WEBHOOK_SECRET, already points at /api/rally-webhook, which
// routes donation events across to the donation logic). The
// STRIPE_FUNDRAISING_* variables exist only as optional overrides — set
// them if the restricted rally key ever needs replacing with a
// broader-scoped one.
//
// Env:
//   STRIPE_SECRET_KEY                  legacy shared donations account
//   STRIPE_WEBHOOK_SECRET              its webhook signing secret
//   STRIPE_RALLY_SECRET_KEY            Wallaloo & Gre Gre account (already set)
//   STRIPE_FUNDRAISING_SECRET_KEY      optional override of the rally key
//   STRIPE_FUNDRAISING_WEBHOOK_SECRET  optional: signing secret of a W&G
//                                      endpoint pointed at /api/stripe-webhook
//
// Both accounts stay live indefinitely after the cutover:
//   - existing monthly donors keep billing on the legacy account, so its
//     invoice.paid webhooks must verify and resolve forever;
//   - a checkout session can only be read back by the account that created
//     it, so lookups try both keys, newest-likely first.

const CUTOVER_UTC = "2026-08-31T14:00:00.000Z"; // Mon 1 Sep 2026 00:00 AEST

function fundraisingCutoverActive(now = new Date()) {
  return now.getTime() >= Date.parse(CUTOVER_UTC);
}

// The Wallaloo & Gre Gre key: the override if set, else the rally key.
function wgKey() {
  return process.env.STRIPE_FUNDRAISING_SECRET_KEY || process.env.STRIPE_RALLY_SECRET_KEY;
}

// The key new checkout sessions are created with. Fail-open: if no W&G key
// is configured after the cutover, keep taking money on the legacy account
// and shout in the logs — a misconfigured switch must never stop donations.
function fundraisingKey(now = new Date()) {
  if (fundraisingCutoverActive(now)) {
    const k = wgKey();
    if (k) return k;
    console.error(
      "no Wallaloo & Gre Gre key set (STRIPE_FUNDRAISING_SECRET_KEY / STRIPE_RALLY_SECRET_KEY) after cutover — creating sessions on the legacy donations account instead"
    );
  }
  return process.env.STRIPE_SECRET_KEY;
}

// Keys to try when READING a session by id (thank-you readback, lapse
// sweep). Ordered by which account most likely created it right now.
function fundraisingReadKeys(now = new Date()) {
  const keys = [process.env.STRIPE_SECRET_KEY, wgKey()].filter(Boolean);
  return fundraisingCutoverActive(now) ? keys.reverse() : keys;
}

// Webhook signing secrets paired with the API key of the account that
// signs with them, so a verified event is always followed up (customer /
// subscription lookups) on the account it came from. Used by
// /api/stripe-webhook; the W&G account's own endpoint delivers to
// /api/rally-webhook under STRIPE_RALLY_WEBHOOK_SECRET.
function fundraisingWebhookPairs() {
  return [
    {
      account: "legacy",
      secret: process.env.STRIPE_WEBHOOK_SECRET,
      key: process.env.STRIPE_SECRET_KEY,
    },
    {
      account: "fundraising",
      secret: process.env.STRIPE_FUNDRAISING_WEBHOOK_SECRET,
      key: wgKey(),
    },
  ].filter((p) => p.secret);
}

// Ticket money and donation money now share the W&G account, so both
// webhook handlers must route by what a session IS, not which account it
// arrived from. rally-checkout stamps ff_content_type=rally_ticket on
// every ticket session; donation sessions carry org=ff and no
// ff_content_type.
function isRallyTicketSession(obj) {
  const meta = (obj && obj.metadata) || {};
  return meta.ff_content_type === "rally_ticket";
}

module.exports = {
  CUTOVER_UTC,
  fundraisingCutoverActive,
  fundraisingKey,
  fundraisingReadKeys,
  fundraisingWebhookPairs,
  isRallyTicketSession,
};
