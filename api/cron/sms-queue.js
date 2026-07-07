// Cron (every minute): dispatch due SMS from the "SMS Sends" queue.
//
// Picks queued rows due within the next 65s, sorts by not_before, and
// sleeps until each row's exact moment before sending — so the 15-55s
// post-signup delay is honoured to the second even though the cron only
// fires once a minute. maxDuration 120 (vercel.json) gives headroom.
//
// Re-checks opt-out at send time; respects AB_FORCE_VARIANT for any
// still-queued signup rows (re-renders the message if flipped).

const { listRows, updateRow, findContactByMobile, nowIso } = require("../_airtable");
const { requireCron } = require("../_util");
const { SMS_SENDS_TABLE, sendViaCellcast, renderSMS } = require("../_cellcast");

const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  if (!requireCron(req, res)) return;
  const started = Date.now();
  const results = { sent: 0, failed: 0, suppressed: 0, skipped: 0 };
  try {
    const due = await listRows(SMS_SENDS_TABLE, {
      formula: `AND({status}='queued', IS_BEFORE({not_before}, DATEADD(NOW(), 65, 'seconds')))`,
      sort: [{ field: "not_before", direction: "asc" }],
      maxRecords: 50,
    });

    for (const row of due) {
      if (Date.now() - started > 100000) break; // stay under maxDuration
      const f = row.fields || {};

      // Honour the exact not_before moment.
      const dueAt = new Date(f.not_before || 0).getTime();
      const wait = dueAt - Date.now();
      // eslint-disable-next-line no-await-in-loop
      if (wait > 0 && wait < 70000) await sleep(wait);

      // Send-time suppression re-check.
      // eslint-disable-next-line no-await-in-loop
      const contact = await findContactByMobile(f.phone).catch(() => null);
      if (contact?.fields?.sms_opt_out) {
        // eslint-disable-next-line no-await-in-loop
        await updateRow(SMS_SENDS_TABLE, row.id, { status: "suppressed", error: "opted out before send" });
        results.suppressed++;
        continue;
      }

      // AB_FORCE_VARIANT flip for not-yet-sent signup rows.
      let message = f.message;
      let variant = f.variant?.name || f.variant;
      const forced = String(process.env.AB_FORCE_VARIANT || "off").toUpperCase();
      if ((forced === "A" || forced === "B") && f.template === "signup_ab" && variant !== forced) {
        variant = forced;
        message = renderSMS("signup_ab", forced, {
          first_name: contact?.fields?.first_name || "",
          cref: contact?.fields?.referral_code || "",
        });
      }

      // eslint-disable-next-line no-await-in-loop
      const out = await sendViaCellcast({ phone: f.phone, message });
      if (out.skipped) {
        console.warn("sms-queue: Cellcast not configured, leaving row queued");
        results.skipped++;
        break; // no key — nothing else will send either
      }
      if (out.suppressed) {
        // Cellcast refused the number off its own unsubscribe list (they
        // STOP'd a past campaign we never saw). Mirror the opt-out locally
        // so future templates stop re-attempting this contact.
        // eslint-disable-next-line no-await-in-loop
        await updateRow(SMS_SENDS_TABLE, row.id, { status: "suppressed", error: out.reason });
        if (contact && !contact.fields?.sms_opt_out) {
          // eslint-disable-next-line no-await-in-loop
          await updateRow(CONTACTS_TABLE, contact.id, { sms_opt_out: true }).catch((e) =>
            console.error("sms-queue: opt-out sync failed:", e.message)
          );
        }
        results.suppressed++;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await updateRow(SMS_SENDS_TABLE, row.id, out.ok
        ? { status: "sent", sent_at: nowIso(), cellcast_id: out.cellcast_id || "", variant, message }
        : { status: "failed", error: String(out.error || out.status).slice(0, 250) });
      results[out.ok ? "sent" : "failed"]++;
    }
    return res.status(200).json({ ok: true, due: due.length, ...results });
  } catch (e) {
    console.error("sms-queue:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
