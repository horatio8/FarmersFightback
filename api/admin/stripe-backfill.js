// One-off Stripe description backfill (WS2.6), basic-auth protected.
//
// Charges on the donations account since 1 Feb 2026 with an empty
// description are FF gifts (per James) → stamp description
// "Farmers Fightback Donation (backfilled)" + metadata.org=ff.
// Excludes non-AUD. Invoice-backed charges (subscriptions) are listed
// but SKIPPED on write — flagged for manual review so another client's
// subscription charges can't be mislabelled.
//
// GET  /api/admin/stripe-backfill            → dry run (default), lists candidates
// POST /api/admin/stripe-backfill?confirm=yes → writes. Run the dry run past
//                                              James first (acceptance item).
// ?starting_after=ch_... continues pagination on big result sets.

const { requireBasicAuth, stripeClient } = require("../_util");

const SINCE = Math.floor(Date.UTC(2026, 1, 1) / 1000); // 1 Feb 2026 UTC

module.exports = async function handler(req, res) {
  if (!requireBasicAuth(req, res)) return;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set" });
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
  const url = new URL(req.url, "https://x");
  const write = req.method === "POST" && url.searchParams.get("confirm") === "yes";

  try {
    const candidates = [];
    const skipped = [];
    let startingAfter = url.searchParams.get("starting_after") || "";
    let pages = 0;
    let hasMore = true;
    while (hasMore && pages < 10) {
      pages++;
      const qs = new URLSearchParams({ limit: "100", "created[gte]": String(SINCE) });
      if (startingAfter) qs.set("starting_after", startingAfter);
      // eslint-disable-next-line no-await-in-loop
      const page = await stripe(`charges?${qs}`);
      for (const ch of page.data || []) {
        startingAfter = ch.id;
        if (ch.description || !ch.paid || ch.refunded) continue;
        if (ch.currency !== "aud") { skipped.push({ id: ch.id, why: `currency ${ch.currency}` }); continue; }
        const entry = {
          id: ch.id,
          payment_intent: ch.payment_intent || null,
          amount: ch.amount / 100,
          created: new Date(ch.created * 1000).toISOString(),
          email: ch.billing_details?.email || ch.receipt_email || "",
          has_invoice: !!ch.invoice,
        };
        if (ch.invoice) { skipped.push({ ...entry, why: "invoice/subscription charge — review manually" }); continue; }
        candidates.push(entry);
      }
      hasMore = page.has_more;
    }

    if (!write) {
      return res.status(200).json({
        mode: "dry-run",
        since: new Date(SINCE * 1000).toISOString(),
        candidates_count: candidates.length,
        candidates,
        skipped_count: skipped.length,
        skipped,
        next_starting_after: hasMore ? startingAfter : null,
        to_write: 'POST with ?confirm=yes after James reviews this list',
      });
    }

    const written = [];
    const failed = [];
    for (const c of candidates) {
      try {
        if (c.payment_intent) {
          // eslint-disable-next-line no-await-in-loop
          await stripe(`payment_intents/${c.payment_intent}`, {
            method: "POST",
            body: new URLSearchParams({
              description: "Farmers Fightback Donation (backfilled)",
              "metadata[org]": "ff",
            }).toString(),
          });
        }
        // eslint-disable-next-line no-await-in-loop
        await stripe(`charges/${c.id}`, {
          method: "POST",
          body: new URLSearchParams({
            description: "Farmers Fightback Donation (backfilled)",
            "metadata[org]": "ff",
          }).toString(),
        });
        written.push(c.id);
      } catch (e) {
        failed.push({ id: c.id, error: e.message.slice(0, 200) });
      }
    }
    return res.status(200).json({
      mode: "write",
      written_count: written.length,
      failed_count: failed.length,
      failed,
      skipped_count: skipped.length,
      next_starting_after: hasMore ? startingAfter : null,
    });
  } catch (e) {
    console.error("stripe-backfill:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
