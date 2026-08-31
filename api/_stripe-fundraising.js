// The fundraising Stripe account switch. From CUTOVER_UTC (midnight
// Melbourne, 1 Sep 2026) every NEW donation checkout session is created on
// the Wallaloo and Gre Gre District Alliance account — the same account
// that already takes rally ticket money — instead of the legacy shared
// donations account. Deployed ahead of time; the flip happens on the clock,
// same pattern as SALES_CLOSE_UTC in _rally.js.
//
// Env:
//   STRIPE_SECRET_KEY                  legacy shared donations account
//   STRIPE_WEBHOOK_SECRET              its webhook signing secret
//   STRIPE_FUNDRAISING_SECRET_KEY      Wallaloo & Gre Gre account (needs
//                                      Checkout Sessions write, Customers,
//                                      Subscriptions, PaymentIntents)
//   STRIPE_FUNDRAISING_WEBHOOK_SECRET  signing secret of the W&G webhook
//                                      endpoint pointing at /api/stripe-webhook
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

// The key new checkout sessions are created with. Fail-open: if the new key
// is missing after the cutover, keep taking money on the legacy account and
// shout in the logs — a misconfigured switch must never stop donations.
function fundraisingKey(now = new Date()) {
  if (fundraisingCutoverActive(now)) {
    const k = process.env.STRIPE_FUNDRAISING_SECRET_KEY;
    if (k) return k;
    console.error(
      "STRIPE_FUNDRAISING_SECRET_KEY not set after cutover — creating sessions on the legacy donations account instead"
    );
  }
  return process.env.STRIPE_SECRET_KEY;
}

// Keys to try when READING a session by id (thank-you readback, lapse
// sweep). Ordered by which account most likely created it right now.
function fundraisingReadKeys(now = new Date()) {
  const keys = [
    process.env.STRIPE_SECRET_KEY,
    process.env.STRIPE_FUNDRAISING_SECRET_KEY,
  ].filter(Boolean);
  return fundraisingCutoverActive(now) ? keys.reverse() : keys;
}

// Webhook signing secrets paired with the API key of the account that
// signs with them, so a verified event is always followed up (customer /
// subscription lookups) on the account it came from.
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
      key: process.env.STRIPE_FUNDRAISING_SECRET_KEY,
    },
  ].filter((p) => p.secret);
}

module.exports = {
  CUTOVER_UTC,
  fundraisingCutoverActive,
  fundraisingKey,
  fundraisingReadKeys,
  fundraisingWebhookPairs,
};
