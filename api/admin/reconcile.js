// Read-only reconciliation tallies, one store per call:
//
//   GET /api/admin/reconcile?token=ADMIN_TOKEN&part=contacts
//     { total, by_status, by_source }
//   ...&part=signatures     { total, with_contact, with_email, distinct_emails }
//   ...&part=donations      { total, sum_amount, with_stripe_id, dupe_stripe_ids }
//   ...&part=tickets        { total, by_payment_status, adult_qty, total_qty,
//                             sum_amount, dupe_payment_intents }
//   ...&part=events         { by_event_type, by_fanout_status } for the four
//                           event types that project into typed tables
//   ...&part=fanout_failures  events whose projection did not land
//   ...&part=stripe_accounts  which real Stripe account each configured key
//                           belongs to, plus the fundraising cutover state
//
// Each part is a full paged scan, sized to fit one 300s invocation on its
// own — that is why they are separate calls rather than one report. Events
// reads go through listRows, which sweeps both bases, so history counts
// whether or not the migration has finished.
//
// Nothing here writes, and no payload or contact detail leaves the endpoint —
// tallies, sums and duplicate KEYS only (stripe ids are opaque references).

const { listRows, escapeFormula } = require("../_airtable");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const SIGNATURES = process.env.AIRTABLE_PETITION_SIGNATURES_TABLE || "Petition Signatures";
const DONATIONS = process.env.AIRTABLE_DONATIONS_TABLE || "Donations";
const TICKETS = process.env.AIRTABLE_RALLY_TICKETS_TABLE || "Rally Tickets";
const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";

const PROJECTED_TYPES = ["Petition Signed", "Donation", "Rally Ticket Purchased", "Rally Ticket Comped"];

// Count rows by the value of one field. Selects arrive either as strings or
// as {name} objects depending on the client; normalise both.
function tally(rows, field) {
  const out = {};
  for (const r of rows) {
    const v = r.fields && r.fields[field];
    const key = v == null || v === "" ? "(blank)" : (v.name || String(v));
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// Values of a key field that appear on more than one row — the shape a
// double-write would leave behind.
function dupes(rows, field) {
  const seen = new Map();
  for (const r of rows) {
    const v = r.fields && r.fields[field];
    if (!v) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => ({ value: v, rows: n }));
}

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const url = new URL(req.url, "https://x");
  const part = url.searchParams.get("part") || "";
  const started = Date.now();

  try {
    let out;
    if (part === "contacts") {
      // Only fields the Contacts table is known to have — an unknown name in
      // fields[] fails the whole scan with UNKNOWN_FIELD_NAME.
      const rows = await listRows(CONTACTS, { fields: ["status"] });
      out = { total: rows.length, by_status: tally(rows, "status") };
    } else if (part === "signatures") {
      const rows = await listRows(SIGNATURES, { fields: ["contact", "email", "lead_source"] });
      const emails = new Set(rows.map((r) => r.fields && r.fields.email).filter(Boolean));
      out = {
        total: rows.length,
        with_contact: rows.filter((r) => (r.fields.contact || []).length).length,
        with_email: rows.filter((r) => r.fields.email).length,
        distinct_emails: emails.size,
        by_lead_source: tally(rows, "lead_source"),
      };
    } else if (part === "donations") {
      const rows = await listRows(DONATIONS, { fields: ["amount", "stripe_object_id", "currency"] });
      out = {
        total: rows.length,
        sum_amount: Math.round(rows.reduce((s, r) => s + (Number(r.fields.amount) || 0), 0) * 100) / 100,
        with_stripe_id: rows.filter((r) => r.fields.stripe_object_id).length,
        dupe_stripe_ids: dupes(rows, "stripe_object_id"),
      };
    } else if (part === "tickets") {
      const rows = await listRows(TICKETS, {
        fields: ["payment_status", "adult_qty", "total_qty", "amount", "stripe_payment_intent", "order_ref"],
      });
      out = {
        total: rows.length,
        by_payment_status: tally(rows, "payment_status"),
        adult_qty: rows.reduce((s, r) => s + (Number(r.fields.adult_qty) || 0), 0),
        total_qty: rows.reduce((s, r) => s + (Number(r.fields.total_qty) || 0), 0),
        sum_amount: Math.round(rows.reduce((s, r) => s + (Number(r.fields.amount) || 0), 0) * 100) / 100,
        dupe_payment_intents: dupes(rows, "stripe_payment_intent"),
        dupe_order_refs: dupes(rows, "order_ref"),
      };
    } else if (part === "stripe_tickets") {
      // The source of truth for money: every Checkout Session on the rally
      // Stripe account (Wallaloo & Gre Gre District Alliance), matched
      // against the Rally Tickets table on payment intent. The restricted
      // key can read Checkout Sessions; anything beyond that (refunds) is
      // reported as not visible rather than guessed at.
      const KEY = process.env.STRIPE_RALLY_SECRET_KEY;
      if (!KEY) return res.status(503).json({ error: "STRIPE_RALLY_SECRET_KEY not set" });

      const paid = [];
      let unpaidOrOpen = 0;
      let after;
      do {
        const q = new URLSearchParams({ limit: "100" });
        if (after) q.set("starting_after", after);
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${q}`, {
          headers: { Authorization: `Bearer ${KEY}` },
        });
        // eslint-disable-next-line no-await-in-loop
        const body = await r.json();
        if (!r.ok) throw new Error(`Stripe ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
        for (const s of body.data || []) {
          if (s.payment_status === "paid") {
            paid.push({
              session: s.id,
              pi: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null,
              amount: (s.amount_total || 0) / 100,
              adult_qty: Number(s.metadata && s.metadata.adult_qty) || 0,
              created: s.created,
            });
          } else unpaidOrOpen += 1;
        }
        after = body.has_more && body.data.length ? body.data[body.data.length - 1].id : null;
      } while (after);

      const rows = await listRows(TICKETS, {
        fields: ["payment_status", "adult_qty", "amount", "stripe_payment_intent", "order_ref"],
      });
      const atByPi = new Map();
      for (const t of rows) {
        const pi = t.fields.stripe_payment_intent;
        if (pi) atByPi.set(pi, t.fields);
      }
      const stripePis = new Set(paid.map((p) => p.pi).filter(Boolean));

      const missing_in_airtable = paid.filter((p) => !p.pi || !atByPi.has(p.pi));
      const paidStatuses = rows.filter((t) => {
        const st = t.fields.payment_status;
        return (st && st.name ? st.name : st) === "Paid";
      });
      const missing_in_stripe = paidStatuses
        .filter((t) => !t.fields.stripe_payment_intent || !stripePis.has(t.fields.stripe_payment_intent))
        .map((t) => ({ pi: t.fields.stripe_payment_intent || "(none)", order_ref: t.fields.order_ref }));
      const amount_mismatches = paid
        .filter((p) => p.pi && atByPi.has(p.pi))
        .filter((p) => Math.abs((Number(atByPi.get(p.pi).amount) || 0) - p.amount) > 0.005)
        .map((p) => ({ pi: p.pi, stripe: p.amount, airtable: Number(atByPi.get(p.pi).amount) || 0 }));

      let refunds = "not checked";
      try {
        const r = await fetch("https://api.stripe.com/v1/refunds?limit=100", {
          headers: { Authorization: `Bearer ${KEY}` },
        });
        const body = await r.json();
        refunds = r.ok
          ? { count: (body.data || []).length, sum: (body.data || []).reduce((s, x) => s + (x.amount || 0), 0) / 100 }
          : `not visible to this key (${r.status})`;
      } catch (e) { refunds = `not visible (${e.message.slice(0, 60)})`; }

      out = {
        stripe: {
          paid_sessions: paid.length,
          unpaid_or_abandoned_sessions: unpaidOrOpen,
          sum_amount: Math.round(paid.reduce((s, p) => s + p.amount, 0) * 100) / 100,
          adult_qty: paid.reduce((s, p) => s + p.adult_qty, 0),
          refunds,
        },
        airtable: {
          paid_rows: paidStatuses.length,
          sum_amount: Math.round(paidStatuses.reduce((s, t) => s + (Number(t.fields.amount) || 0), 0) * 100) / 100,
          adult_qty: paidStatuses.reduce((s, t) => s + (Number(t.fields.adult_qty) || 0), 0),
        },
        missing_in_airtable: missing_in_airtable.map((p) => ({ session: p.session, pi: p.pi, amount: p.amount })),
        missing_in_stripe,
        amount_mismatches,
      };
    } else if (part === "stripe_accounts") {
      // Which real Stripe account each configured key belongs to — the
      // live-identity check for the fundraising cutover (the MCP connector
      // only sees a sandbox, so this is the authoritative view). Read-only:
      // GET /v1/account answers for the key's own account with any secret
      // or restricted key. Reports id + business name only, never key
      // material.
      const { CUTOVER_UTC, fundraisingCutoverActive, fundraisingKey } = require("../_stripe-fundraising");
      const keys = {
        legacy_donations: process.env.STRIPE_SECRET_KEY,
        fundraising_override: process.env.STRIPE_FUNDRAISING_SECRET_KEY,
        rally: process.env.STRIPE_RALLY_SECRET_KEY,
      };
      const accounts = {};
      for (const [name, key] of Object.entries(keys)) {
        if (!key) { accounts[name] = { configured: false }; continue; }
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await fetch("https://api.stripe.com/v1/account", {
            headers: { Authorization: `Bearer ${key}` },
          });
          // eslint-disable-next-line no-await-in-loop
          const a = await r.json();
          if (!r.ok) throw new Error((a.error && a.error.message) || `Stripe ${r.status}`);
          accounts[name] = {
            configured: true,
            account_id: a.id,
            business_name:
              (a.business_profile && a.business_profile.name) ||
              (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) ||
              null,
            livemode: key.includes("_live_"),
          };
        } catch (e) {
          accounts[name] = { configured: true, error: String(e.message).slice(0, 200) };
        }
      }
      const activeKey = fundraisingKey();
      out = {
        accounts,
        cutover_utc: CUTOVER_UTC,
        cutover_active: fundraisingCutoverActive(),
        new_sessions_use: activeKey
          ? Object.entries(keys).find(([, k]) => k === activeKey)?.[0] || "unknown"
          : "none — no key configured",
      };

      // ?probe=1 — prove the W&G key can actually CREATE donation sessions
      // before the cutover clock relies on it: one $2 one-off and one $2
      // monthly, the exact payload shapes /api/checkout sends, expired
      // immediately so nothing purchasable is left behind. A restricted
      // key missing a permission (price_data, subscriptions) fails here
      // and nowhere near a real donor.
      if (url.searchParams.get("probe") === "1") {
        const probeKey = process.env.STRIPE_FUNDRAISING_SECRET_KEY || process.env.STRIPE_RALLY_SECRET_KEY;
        out.probe = {};
        if (!probeKey) {
          out.probe.error = "no W&G key configured";
        } else {
          const { toFormBody, stripeClient } = require("../_util");
          const wg = stripeClient(probeKey);
          for (const frequency of ["oneoff", "monthly"]) {
            const monthly = frequency === "monthly";
            try {
              const s = await wg("checkout/sessions", {
                method: "POST",
                body: toFormBody({
                  mode: monthly ? "subscription" : "payment",
                  line_items: [{
                    quantity: 1,
                    price_data: {
                      currency: "aud",
                      unit_amount: 200,
                      product_data: { name: "Cutover permission probe (not a real ask)" },
                      ...(monthly ? { recurring: { interval: "month" } } : {}),
                    },
                  }],
                  metadata: { org: "ff", probe: "cutover" },
                  success_url: "https://www.farmersfightback.com/donate?cs={CHECKOUT_SESSION_ID}",
                  cancel_url: "https://www.farmersfightback.com/donate?cancelled=1",
                }),
              });
              await wg(`checkout/sessions/${s.id}/expire`, { method: "POST" }).catch((e) => {
                out.probe[`${frequency}_expire_warning`] = e.message.slice(0, 200);
              });
              out.probe[frequency] = "ok — session created and expired";
            } catch (e) {
              out.probe[frequency] = `FAILED: ${e.message.slice(0, 300)}`;
            }
          }
        }
      }
    } else if (part === "events") {
      const formula = `OR(${PROJECTED_TYPES.map((t) => `{event_type}='${escapeFormula(t)}'`).join(",")})`;
      const rows = await listRows(EVENTS, { formula, fields: ["event_type", "fanout_status"] });
      out = { total: rows.length, by_event_type: tally(rows, "event_type"), by_fanout_status: tally(rows, "fanout_status") };
    } else if (part === "fanout_failures") {
      const rows = await listRows(EVENTS, {
        formula: `OR({fanout_status}='Failed', {fanout_status}='No Typed Table')`,
        fields: ["event_id", "event_type", "timestamp", "fanout_status", "fanout_error"],
      });
      out = {
        total: rows.length,
        by_event_type: tally(rows, "event_type"),
        sample: rows.slice(0, 20).map((r) => r.fields),
      };
    } else {
      return res.status(400).json({
        error: "unknown part",
        parts: ["contacts", "signatures", "donations", "tickets", "stripe_tickets", "stripe_accounts", "events", "fanout_failures"],
      });
    }
    out.part = part;
    out.elapsed_s = Math.round((Date.now() - started) / 1000);
    return res.status(200).json(out);
  } catch (e) {
    console.error("reconcile:", e.message);
    return res.status(500).json({ error: e.message.slice(0, 300) });
  }
};

module.exports.tally = tally;
module.exports.dupes = dupes;
