// Cellcast SMS client + message templates + the signup-SMS enqueue rule
// (Workstream 1). Sends are queued into the Airtable "SMS Sends" table and
// dispatched by /api/cron/sms-queue; nothing here blocks a signup.
//
// Env:
//   CELLCAST_API_KEY   Cellcast v1 API key (sent as Authorization: Bearer).
//                      Absent => enqueue still works, dispatch no-ops with a
//                      logged warning (ship dark).
//   CELLCAST_API_BASE  optional override, default https://api.cellcast.com/api/v1
//   CELLCAST_FROM      optional sender id (alpha <=11 chars, or numeric).
//                      NOTE: an alpha sender is one-way — replies (incl. STOP)
//                      don't come back, so leave unset to use the shared number
//                      if you rely on the get-responses STOP poll.
//   AB_FORCE_VARIANT   off | A | B — force new sends to the winning variant
//   SMS_INCLUDE_CONTACT_REF  "0" to never append ?c=<code> to links

const {
  normPhone,
  findContactByMobile,
  findOne,
  createRow,
  listRows,
  updateRow,
  nowIso,
  uuid,
} = require("./_airtable");
const { phoneHash, scheduleSignupSMS, clampToQuietHours } = require("./_util");

const SMS_SENDS_TABLE = process.env.AIRTABLE_SMS_SENDS_TABLE || "SMS Sends";
const GSM_LIMIT = 160;
// Cellcast v1 REST API. Bearer-authenticated; base overridable for staging.
const CELLCAST_BASE = (process.env.CELLCAST_API_BASE || "https://api.cellcast.com/api/v1").replace(/\/$/, "");

// Final copy from the brief (v2). {first} merged at enqueue time; {link}
// gets ?c=<referral_code> appended only when the merged message still fits
// in one 160-char segment.
const TEMPLATES = {
  signup_ab: {
    A: { link: "farmersfightback.com/fund",
      text: "{first}, Ben from Farmers Fightback. Thanks for signing. Chip in to keep the fight alive: {link}" },
    B: { link: "farmersfightback.com/fight",
      text: "{first}, VNI West is carving up Australia's food bowl. Help Farmers Fightback make the Govt listen: {link}" },
  },
  donation_lapse_24h: {
    A: { link: "farmersfightback.com/fund",
      text: "{first}, you were one click from backing Aussie farmers yesterday. Finish what you started: {link}" },
    B: { link: "farmersfightback.com/fund",
      text: "{first}, you were one click from backing Aussie farmers yesterday. Finish what you started: {link}" },
  },
};

function renderSMS(template, variant, { first_name, cref } = {}) {
  const t = (TEMPLATES[template] || {})[variant];
  if (!t) return null;
  const first = String(first_name || "").trim().split(/\s+/)[0] || "Friend";
  const base = t.text.replace("{first}", first).replace("{link}", t.link);
  if (cref && process.env.SMS_INCLUDE_CONTACT_REF !== "0") {
    const withRef = t.text.replace("{first}", first).replace("{link}", `${t.link}?c=${cref}`);
    if (withRef.length <= GSM_LIMIT) return withRef;
  }
  if (base.length > GSM_LIMIT) {
    console.warn(`SMS ${template}/${variant} is ${base.length} chars (>160) after merge`);
  }
  return base;
}

// Deterministic 50/50: last hex nibble parity of the phone hash.
function assignVariant(hash) {
  const forced = String(process.env.AB_FORCE_VARIANT || "off").toUpperCase();
  if (forced === "A" || forced === "B") return forced;
  return parseInt(hash.slice(-1), 16) % 2 === 0 ? "A" : "B";
}

async function sendViaCellcast({ phone, message, scheduleAt }) {
  const key = process.env.CELLCAST_API_KEY;
  if (!key) return { skipped: true, reason: "CELLCAST_API_KEY not set" };
  // replyStopToOptOut: Cellcast manages the STOP opt-out facility natively —
  // required for Spam Act compliance now the templates carry no opt-out copy.
  const body = { message, contacts: [phone], replyStopToOptOut: true };
  if (process.env.CELLCAST_FROM) body.sender = process.env.CELLCAST_FROM;
  // Hand the delivery timer to Cellcast: scheduleAt (Date or ISO string) is
  // sent as their documented "Y-m-d H:i:s" UTC format. Only forward-dated
  // times — a past/invalid value falls through to an immediate send.
  if (scheduleAt) {
    const t = new Date(scheduleAt);
    if (Number.isFinite(t.getTime()) && t.getTime() > Date.now() + 5000) {
      body.scheduleAt = t.toISOString().slice(0, 19).replace("T", " ");
    }
  }
  const r = await fetch(`${CELLCAST_BASE}/gateway`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  // v1 gateway: { status:true, data:{ queueResponse:[{MessageId,...}],
  // invalidContacts, unsubscribeContacts } }. Low balance => 422 status:false;
  // bad token => 401 {code:401,message:"Token expired"}. A queued send always
  // returns a MessageId — its absence (invalid/unsubscribed/low balance) is a
  // non-send, so surface it as an error rather than record a phantom send.
  if (!r.ok || json.status !== true) {
    // Live-observed rejection shape for a recipient on Cellcast's opt-out
    // list: status:false + message "Contact is Unsubscribed and can not
    // receive [messages]" (differs from the documented unsubscribeContacts
    // array, which is also handled below). A deliberate opt-out, not a
    // delivery failure.
    if (/unsubscribed/i.test(json.message || json.msg || "")) {
      return { suppressed: true, reason: "on Cellcast unsubscribe list" };
    }
    return { ok: false, status: r.status, error: JSON.stringify(json).slice(0, 300) };
  }
  const q = json.data?.queueResponse?.[0] || {};
  if (!q.MessageId) {
    // status:true but no MessageId. If the number sits on Cellcast's own
    // unsubscribe list it lands in unsubscribeContacts — that's a deliberate
    // opt-out, not a delivery failure, so let the caller suppress + sync it.
    if ((json.data?.unsubscribeContacts || []).length > 0) {
      return { suppressed: true, reason: "on Cellcast unsubscribe list" };
    }
    return { ok: false, status: r.status, error: JSON.stringify(json.data || json).slice(0, 300) };
  }
  return { ok: true, cellcast_id: q.MessageId };
}

// One automation text per signer, ever: dedupe on phone hash + template
// regardless of status (a failed row still counts as "we tried").
async function alreadyQueued(hash, template) {
  const existing = await findOne(
    SMS_SENDS_TABLE,
    `AND({phone_hash}='${hash}', {template}='${template}')`
  );
  return !!existing;
}

// Called from petition-signup after a successful signup. Never throws.
// Skips: no mobile, existing donors (they get WS5 treatment), opted-out
// contacts, and anyone who has ever been queued a signup text.
async function enqueueSignupSMS({ contactFields, mobile, first_name }) {
  try {
    const phone = normPhone(mobile);
    if (!phone || !phone.startsWith("+")) return { skipped: "no valid mobile" };
    const status = contactFields?.status?.name || contactFields?.status || "";
    if (status === "Donor Only" || status === "Signatory + Donor") return { skipped: "existing donor" };
    if (contactFields?.sms_opt_out) return { skipped: "opted out" };
    const hash = phoneHash(phone);
    if (await alreadyQueued(hash, "signup_ab")) return { skipped: "already queued" };

    const variant = assignVariant(hash);
    const message = renderSMS("signup_ab", variant, {
      first_name,
      cref: contactFields?.referral_code || "",
    });
    const notBefore = scheduleSignupSMS();

    // Hand the 15-55s timer to Cellcast (scheduleAt) ONLY for sub-minute
    // delays inside the send window — live-observed 2026-07-07: Cellcast
    // misread a UTC scheduleAt as account-local time and fired quiet-hours
    // texts at 11:41pm. For any longer delay (quiet-hours clamp), queue the
    // row and let OUR dispatcher (lapse-sweep tail / traffic kick, our
    // clock) send it in the morning. Worst case for a sub-minute schedule
    // misread is an immediate send, which is still inside the window.
    const delayMs = notBefore.getTime() - Date.now();
    const out = delayMs <= 90000
      ? await sendViaCellcast({ phone, message, scheduleAt: notBefore })
      : null;
    if (out === null) {
      await createRow(SMS_SENDS_TABLE, {
        send_id: uuid(),
        phone,
        phone_hash: hash,
        template: "signup_ab",
        variant,
        message,
        status: "queued",
        not_before: notBefore.toISOString(),
        queued_at: nowIso(),
      });
      return { queued: true, status: "queued", variant, not_before: notBefore.toISOString() };
    }
    const rowStatus = out.ok ? "scheduled" : out.suppressed ? "suppressed" : "queued";
    await createRow(SMS_SENDS_TABLE, {
      send_id: uuid(),
      phone,
      phone_hash: hash,
      template: "signup_ab",
      variant,
      message,
      status: rowStatus,
      not_before: notBefore.toISOString(),
      queued_at: nowIso(),
      ...(out.ok ? { cellcast_id: out.cellcast_id, sent_at: nowIso() } : {}),
      ...(out.suppressed ? { error: out.reason } : {}),
    });
    return { queued: true, status: rowStatus, variant, not_before: notBefore.toISOString() };
  } catch (e) {
    console.error("enqueueSignupSMS failed:", e.message);
    return { error: e.message };
  }
}

// Queue the +24h donation-lapse nudge (WS4.4). Dedupe per phone+template.
async function enqueueDonationLapseSMS({ mobile, first_name, referral_code, baseTime }) {
  try {
    const phone = normPhone(mobile);
    if (!phone || !phone.startsWith("+")) return { skipped: "no valid mobile" };
    const contact = await findContactByMobile(phone).catch(() => null);
    if (contact?.fields?.sms_opt_out) return { skipped: "opted out" };
    const hash = phoneHash(phone);
    if (await alreadyQueued(hash, "donation_lapse_24h")) return { skipped: "already queued" };
    const at = clampToQuietHours(new Date((baseTime ? new Date(baseTime) : new Date()).getTime() + 24 * 3600 * 1000));
    await createRow(SMS_SENDS_TABLE, {
      send_id: uuid(),
      phone,
      phone_hash: hash,
      template: "donation_lapse_24h",
      variant: "A",
      message: renderSMS("donation_lapse_24h", "A", { first_name, cref: referral_code || "" }),
      status: "queued",
      not_before: at.toISOString(),
      queued_at: nowIso(),
    });
    return { queued: true };
  } catch (e) {
    console.error("enqueueDonationLapseSMS failed:", e.message);
    return { error: e.message };
  }
}

// Dispatch every queued row whose not_before has passed. No cron required:
// callable from any trigger — the /api/cron/sms-queue endpoint (manual/API),
// the tail of lapse-sweep, and the throttled kick on high-traffic routes.
// Signup texts are normally pre-scheduled with Cellcast (status "scheduled")
// and never appear here; this drains the +24h nudges and any rows whose
// schedule call failed. No per-row sleeps — rows are sent when due.
const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";

async function dispatchDueSMS({ maxRows = 25, deadlineMs = 60000 } = {}) {
  const started = Date.now();
  const results = { due: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 };
  if (!process.env.CELLCAST_API_KEY) { results.skipped = -1; return results; }
  // 65s lookahead compensates Airtable's NOW() lag (it can trail real time
  // by a minute+); worst case a row goes ~1 min early, which is fine for
  // nudges and already-late schedule fallbacks.
  const due = await listRows(SMS_SENDS_TABLE, {
    formula: `AND({status}='queued', IS_BEFORE({not_before}, DATEADD(NOW(), 65, 'seconds')))`,
    sort: [{ field: "not_before", direction: "asc" }],
    maxRecords: maxRows,
  });
  results.due = due.length;

  for (const row of due) {
    if (Date.now() - started > deadlineMs) break;
    const f = row.fields || {};

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
    if (out.skipped) { results.skipped++; break; }
    if (out.suppressed) {
      // eslint-disable-next-line no-await-in-loop
      await updateRow(SMS_SENDS_TABLE, row.id, { status: "suppressed", error: out.reason });
      if (contact && !contact.fields?.sms_opt_out) {
        // eslint-disable-next-line no-await-in-loop
        await updateRow(CONTACTS_TABLE, contact.id, { sms_opt_out: true }).catch((e) =>
          console.error("dispatchDueSMS opt-out sync:", e.message)
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
  return results;
}

module.exports = {
  SMS_SENDS_TABLE,
  renderSMS,
  assignVariant,
  sendViaCellcast,
  dispatchDueSMS,
  enqueueSignupSMS,
  enqueueDonationLapseSMS,
};
