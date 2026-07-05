// Cron (every 5 min): the 30-minute lapse-cart clock (Workstream 4.2).
//
// Finds Lapse Queue rows still pending after 30 min, checks whether the
// person actually completed (signed / paid) in the meantime, and if not
// drops their profile into the matching CN automation (A/B split via
// paired automations). Donation lapsers with a mobile also get the +24h
// SMS nudge queued.
//
// Env (automation IDs come from the CN UI — automations can't be created
// via API): CN_AUTOMATION_PETITION_LAPSE_A / _B,
//           CN_AUTOMATION_DONATION_LAPSE_A / _B
//           (single CN_AUTOMATION_PETITION_LAPSE / _DONATION_LAPSE also
//           accepted if CN handles the split internally).
// Rows stay pending (with a note) until the env vars exist — nothing lost.

const { listRows, updateRow, findOne, nowIso } = require("../_airtable");
const { requireCron, stripeClient, phoneHash } = require("../_util");
const { cnAutomationAdd } = require("../_cn");
const { enqueueDonationLapseSMS } = require("../_cellcast");

const LAPSE_TABLE = process.env.AIRTABLE_LAPSE_TABLE || "Lapse Queue";
const SIGNATURES_TABLE = process.env.AIRTABLE_PETITION_SIGNATURES_TABLE || "Petition Signatures";

function esc(s) { return String(s).replace(/'/g, "\\'"); }

function automationFor(form, variant) {
  const key = form === "donation" ? "CN_AUTOMATION_DONATION_LAPSE" : "CN_AUTOMATION_PETITION_LAPSE";
  return process.env[`${key}_${variant}`] || process.env[key] || "";
}

// Deterministic A/B on the identity string so retries stay stable.
function lapseVariant(identity) {
  return parseInt(phoneHash(identity).slice(-1), 16) % 2 === 0 ? "A" : "B";
}

async function petitionCompleted(f) {
  const clauses = [];
  if (f.email) clauses.push(`{email}='${esc(String(f.email).toLowerCase())}'`);
  if (f.mobile) clauses.push(`{mobile}='${esc(f.mobile)}'`);
  if (!clauses.length) return false;
  const hit = await findOne(
    SIGNATURES_TABLE,
    `AND(OR(${clauses.join(",")}), IS_AFTER({timestamp}, '${f.created_at}'))`
  ).catch(() => null);
  return !!hit;
}

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  const results = { completed: 0, triggered: 0, waiting_env: 0, errors: 0 };
  try {
    const rows = await listRows(LAPSE_TABLE, {
      formula: `AND({status}='pending', IS_BEFORE({created_at}, DATEADD(NOW(), -30, 'minutes')))`,
      sort: [{ field: "created_at", direction: "asc" }],
      maxRecords: 50,
    });

    const stripe = process.env.STRIPE_SECRET_KEY ? stripeClient(process.env.STRIPE_SECRET_KEY) : null;

    for (const row of rows) {
      const f = row.fields || {};
      try {
        // --- completion check ---
        let done = false;
        if (f.form === "donation" && f.session_id && stripe) {
          // eslint-disable-next-line no-await-in-loop
          const s = await stripe(`checkout/sessions/${f.session_id}`).catch(() => null);
          done = s?.payment_status === "paid";
        } else if (f.form === "petition") {
          // eslint-disable-next-line no-await-in-loop
          done = await petitionCompleted(f);
        }
        if (done) {
          // eslint-disable-next-line no-await-in-loop
          await updateRow(LAPSE_TABLE, row.id, { status: "completed" });
          results.completed++;
          continue;
        }

        // --- trigger the CN lapse automation ---
        const identity = f.email || f.mobile || f.session_id || row.id;
        const variant = f.variant?.name || f.variant || lapseVariant(identity);
        const automationId = automationFor(f.form, variant);
        if (!automationId) {
          results.waiting_env++;
          if (!f.note) {
            // eslint-disable-next-line no-await-in-loop
            await updateRow(LAPSE_TABLE, row.id, { variant, note: "awaiting CN automation env vars" });
          }
          continue; // stays pending; flushes once James adds the IDs
        }
        // eslint-disable-next-line no-await-in-loop
        const out = await cnAutomationAdd(automationId, {
          email: f.email || undefined,
          mobile: f.mobile || undefined,
          first_name: f.first_name || undefined,
          last_name: f.last_name || undefined,
          tags: [`${f.form}_lapse_${variant.toLowerCase()}`],
        });
        if (out.skipped) { results.waiting_env++; continue; }
        // eslint-disable-next-line no-await-in-loop
        await updateRow(LAPSE_TABLE, row.id, {
          status: out.ok ? "triggered" : "error",
          variant,
          triggered_at: nowIso(),
          note: out.ok ? "" : String(out.body || out.error || "").slice(0, 200),
        });
        if (out.ok) results.triggered++; else results.errors++;

        // +24h SMS nudge for donation lapsers with a mobile (WS4.4).
        if (out.ok && f.form === "donation" && f.mobile) {
          // eslint-disable-next-line no-await-in-loop
          await enqueueDonationLapseSMS({
            mobile: f.mobile,
            first_name: f.first_name,
            baseTime: f.created_at,
          });
        }
      } catch (e) {
        results.errors++;
        console.error(`lapse-sweep row ${row.id}:`, e.message);
      }
    }
    return res.status(200).json({ ok: true, scanned: rows.length, ...results });
  } catch (e) {
    console.error("lapse-sweep:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
