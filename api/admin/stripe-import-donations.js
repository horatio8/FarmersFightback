// Import historical Stripe donations into the Airtable pipeline.
//
// The Donations table begins 21 Jun 2026 — the day the stripe-webhook went
// live. Everything the campaign raised from February to then exists only in
// Stripe. This walks charges on the donations account since 1 Feb 2026 and
// writes the FF ones through the same logEvent pipeline the webhook uses, so
// the fan-out creates the Donations row, the contact gets matched or created,
// and the nightly economics run classifies the donor's channel and journey.
//
// GET  /api/admin/stripe-import-donations?token=ADMIN_TOKEN        dry run
// POST /api/admin/stripe-import-donations?token=...&confirm=yes    write
//   Resumable: pass ?starting_after=ch_... (returned as next_starting_after)
//   to continue. Time-boxed under the 300s function limit.
//
// FF filter (the Stripe account is shared with other clients):
//   metadata.org == 'ff' OR description matches /farmers fightback/i
//   — the description backfill stamped historical FF one-off charges, so
//   both eras are covered. Non-AUD, unpaid and refunded charges skipped.
// Dedupe: charge id / payment_intent against existing Donations rows, plus
//   logEventIdempotent on meta_event_id = import_<charge id>.
// Contacts: matched by email; created WITHOUT matchOrCreateContact, which
//   would bump the public signature counter — donors are not signatures.

const {
  findContactByEmail,
  logEventIdempotent,
  updateContactStatusFromEvent,
  createRow,
  listRows,
  uuid,
  normEmail,
} = require("../_airtable");
const { stripeClient } = require("../_util");

const SINCE = Math.floor(Date.UTC(2026, 1, 1) / 1000); // 1 Feb 2026 UTC
const BUDGET_MS = 280 * 1000;
const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";

function isFF(ch) {
  if (ch.metadata && ch.metadata.org === "ff") return true;
  return /farmers\s*fightback/i.test(ch.description || "");
}

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: undefined, last: undefined };
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

module.exports = async function handler(req, res) {
  const token = (req.query && req.query.token) || req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "bad token" });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set" });
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
  const started = Date.now();
  const url = new URL(req.url, "https://x");
  const write = req.method === "POST" && url.searchParams.get("confirm") === "yes";

  try {
    // Existing donations, so reruns and the webhook era are never duplicated.
    const existing = new Set();
    const rows = await listRows(process.env.AIRTABLE_DONATIONS_TABLE || "Donations", {
      fields: ["stripe_object_id", "stripe_payment_intent"],
    });
    for (const r of rows) {
      const f = r.fields || {};
      if (f.stripe_object_id) existing.add(f.stripe_object_id);
      if (f.stripe_payment_intent) existing.add(f.stripe_payment_intent);
    }

    const stats = { pages: 0, seen: 0, ff: 0, already: 0, imported: 0, no_email: 0, failed: 0, total_usd_seen: 0 };
    const preview = [];
    let startingAfter = url.searchParams.get("starting_after") || "";
    let hasMore = true;

    while (hasMore && Date.now() - started < BUDGET_MS) {
      stats.pages += 1;
      const qs = new URLSearchParams({ limit: "100", "created[gte]": String(SINCE) });
      if (startingAfter) qs.set("starting_after", startingAfter);
      const page = await stripe(`charges?${qs}`);
      for (const ch of page.data || []) {
        startingAfter = ch.id;
        stats.seen += 1;
        if (!ch.paid || ch.refunded || ch.currency !== "aud" || !isFF(ch)) continue;
        stats.ff += 1;
        stats.total_usd_seen += ch.amount / 100;
        // Three identities a recorded gift may carry: the webhook stores
        // checkout sessions under stripe_object_id=cs_..., subscription
        // rebills under the INVOICE id (in_...), and both keep the payment
        // intent. A rebill charge only links to its row via ch.invoice —
        // without that check the dry run offered every rebill as "new",
        // which would have double-counted the whole subscription program.
        if (
          existing.has(ch.id)
          || (ch.payment_intent && existing.has(ch.payment_intent))
          || (ch.invoice && existing.has(ch.invoice))
        ) {
          stats.already += 1;
          continue;
        }

        const email = normEmail(ch.billing_details?.email || ch.receipt_email || "");
        const name = ch.billing_details?.name || "";
        const when = new Date(ch.created * 1000).toISOString();
        if (!write) {
          if (preview.length < 25) preview.push({ id: ch.id, amount: ch.amount / 100, created: when, email, name });
          stats.imported += 1; // "would import"
          continue;
        }

        try {
          // Contact: match by email, else create WITHOUT the signature-counter
          // bump. No email → import the gift unlinked-by-contact is not
          // possible in this pipeline; log and skip (rare on card payments).
          let contact = email ? await findContactByEmail(email) : null;
          if (!contact && email) {
            const { first, last } = splitName(name);
            contact = await createRow(CONTACTS, {
              contact_id: uuid(),
              first_name: first,
              last_name: last,
              email,
              date_first_seen: when,
              last_updated: new Date().toISOString(),
            });
          }
          if (!contact) { stats.no_email += 1; continue; }

          await logEventIdempotent({
            contactRecordId: contact.id,
            event_type: "Donation",
            meta_event_id: `import_${ch.id}`,
            timestamp: when,
            source_channel: "Direct",
            payload: {
              stripe_object_type: "charge",
              stripe_object_id: ch.id,
              amount: ch.amount,
              currency: String(ch.currency || "aud").toUpperCase(),
              content_name: ch.invoice ? "Monthly Donation" : "One-off Donation",
              source: "stripe_import",
              customer: { email, name, phone: ch.billing_details?.phone || null },
              raw: {
                id: ch.id,
                payment_intent: ch.payment_intent || null,
                invoice: ch.invoice || null,
                description: ch.description || null,
                metadata: ch.metadata || {},
                created: ch.created,
              },
            },
          });
          await updateContactStatusFromEvent(contact.id, "Donation", contact.fields && contact.fields.status)
            .catch(() => {});
          existing.add(ch.id);
          if (ch.payment_intent) existing.add(ch.payment_intent);
          stats.imported += 1;
        } catch (e) {
          stats.failed += 1;
          console.error("stripe-import charge failed:", ch.id, e.message);
        }
      }
      hasMore = page.has_more;
    }

    stats.total_usd_seen = Math.round(stats.total_usd_seen * 100) / 100;
    return res.status(200).json({
      mode: write ? "write" : "dry-run",
      ...stats,
      ...(write ? {} : { would_import: stats.imported, preview }),
      done: !hasMore,
      next_starting_after: hasMore ? startingAfter : null,
    });
  } catch (e) {
    console.error("stripe-import-donations:", e);
    return res.status(500).json({ error: String(e && e.message) });
  }
};
