// Admin: populate the CN custom field that backs the survey link token.
//
// The tokenised survey link is built in a CN email as
//   https://www.farmersfightback.com/s/supporters?uid=%recipient.FarmersFightback_UID%&src=email
// and that merge tag reads the CRM custom field of the same alias. This
// endpoint is how the field gets filled with each contact's referral_code, so
// one value serves as both survey identity and referral attribution.
//
// Two modes, matching the two paths CN supports:
//
//   GET /api/admin/survey-uids?mode=csv&limit=50000
//     → text/csv attachment: email,first_name,FarmersFightback_UID,url
//       Feed to CN > Contacts > Import and map the UID column. This is the
//       right tool for the one-off backfill of the existing ~36k codes:
//       one upload, no per-contact API calls, no timeout risk.
//
//   GET /api/admin/survey-uids?mode=push&limit=200&cursor=<c>
//     → JSON { pushed, skipped, failed, nextCursor }
//       Writes straight to CN via /profiles/match. Batched and cursored
//       because a serverless invocation cannot walk 36k contacts inside its
//       execution limit — keep calling with the returned nextCursor until it
//       comes back null. Use this to top up new contacts after the backfill.
//
//   GET /api/admin/survey-uids?mode=bulk&cursor=<c>
//     → JSON { seen, pushed, skipped, failed, chunks, nextCursor }
//       The backfill workhorse: same walk as push but batched through CN's
//       /profiles/match/bulk (~250 profiles a call, split-retry on failure),
//       so tens of thousands of contacts land in a handful of invocations.
//       Time-boxed; keep calling with nextCursor until it comes back null.
//
//   &email=x@y.com  → single contact, csv/push modes, for spot checks.
//
// Contacts without a referral_code are skipped rather than issued one: minting
// here would write codes for people who may never be emailed. They pick one up
// through the normal paths (petition-signup, event-log, share-context).
//
// Guarded by ADMIN_BASIC_AUTH (same as /api/ab-report), or ?token=ADMIN_TOKEN
// so the bulk backfill can be driven without the basic-auth password.

const { listRows, listPage, normEmail } = require("../_airtable");
const { requireBasicAuth, hostBase } = require("../_util");
const { cnSetUid, cnSetUidBulkSafe, CN_UID_FIELD } = require("../_cn");

const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const PUBLIC_BASE = "https://www.farmersfightback.com";
const SURVEY_SLUG = "supporters";
const FIELDS = ["contact_id", "email", "mobile", "first_name", "last_name", "referral_code"];

// Keep a push batch well inside the function execution limit. Each row is one
// CN round trip, so this is the knob to turn if pushes start timing out.
const PUSH_BATCH = 200;
const CSV_LIMIT = 50000;
// Bulk mode: profiles per CN bulk call, and a time box under the 300s limit.
const BULK_CHUNK = 250;
const BULK_BUDGET_MS = 265 * 1000;

function csvCell(s) {
  const v = String(s == null ? "" : s);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function surveyUrl(uid) {
  return `${PUBLIC_BASE}/s/${SURVEY_SLUG}?uid=${encodeURIComponent(uid)}&src=email`;
}

function escFormula(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, hostBase(req));
  const token = url.searchParams.get("token") || req.headers["x-admin-token"];
  const tokenOk = Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
  if (!tokenOk && !requireBasicAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const mode = (url.searchParams.get("mode") || "csv").toLowerCase();
  const email = normEmail(url.searchParams.get("email"));
  const cursor = url.searchParams.get("cursor") || undefined;
  const limit = Math.min(
    mode === "push" ? PUSH_BATCH : CSV_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || (mode === "push" ? PUSH_BATCH : CSV_LIMIT))
  );

  if (mode !== "csv" && mode !== "push" && mode !== "bulk") {
    return res.status(400).json({ error: "mode must be csv, push or bulk" });
  }

  try {
    // Only contacts that already have a code and something CN can match on.
    const formula = email
      ? `AND(LOWER({email})='${escFormula(email)}',{referral_code}!='')`
      : `AND({referral_code}!='',OR({email}!='',{mobile}!=''))`;

    // Bulk: walk pages, buffer, flush to CN in chunk-sized bulk calls until
    // the walk drains or the time box runs out. Resumable via nextCursor.
    if (mode === "bulk") {
      const chunk = Math.min(500, Math.max(10, Number(url.searchParams.get("chunk")) || BULK_CHUNK));
      const started = Date.now();
      let pageCursor = cursor;
      let seen = 0, pushed = 0, skipped = 0, failed = 0, chunks = 0;
      let buf = [];
      let firstErr = null;
      const flush = async () => {
        if (!buf.length) return;
        const out = await cnSetUidBulkSafe(buf);
        chunks += 1;
        pushed += out.pushed; skipped += out.skipped; failed += out.failed;
        if (out.err && !firstErr) firstErr = out.err;
        buf = [];
      };
      do {
        // eslint-disable-next-line no-await-in-loop
        const page = await listPage(CONTACTS_TABLE, {
          formula,
          fields: FIELDS,
          pageSize: 100,
          offset: pageCursor,
        });
        for (const r of page.records) {
          const f = r.fields || {};
          seen += 1;
          if (!f.referral_code || (!f.email && !f.mobile)) { skipped += 1; continue; }
          buf.push({
            first_name: f.first_name,
            last_name: f.last_name,
            email: f.email,
            mobile: f.mobile,
            uid: f.referral_code,
          });
          // eslint-disable-next-line no-await-in-loop
          if (buf.length >= chunk) await flush();
        }
        pageCursor = page.offset || null;
      } while (pageCursor && Date.now() - started < BULK_BUDGET_MS);
      await flush();
      return res.status(200).json({
        ok: true,
        mode,
        seen,
        pushed,
        skipped,
        failed,
        chunks,
        ...(firstErr ? { first_error: firstErr } : {}),
        nextCursor: pageCursor,
      });
    }

    // CSV wants the lot in one go; push walks it a page at a time so a batch
    // fits inside the function's execution limit and can resume.
    let list, nextCursor = null;
    if (mode === "csv") {
      const rows = await listRows(CONTACTS_TABLE, { formula, fields: FIELDS, maxRecords: limit });
      list = rows.map((r) => r.fields || {});
    } else {
      const page = await listPage(CONTACTS_TABLE, {
        formula,
        fields: FIELDS,
        pageSize: Math.min(100, limit),
        offset: cursor,
      });
      list = page.records.map((r) => r.fields || {});
      nextCursor = page.offset || null;
    }

    if (mode === "csv") {
      const head = `email,first_name,${CN_UID_FIELD},url`;
      const body = list
        .filter((f) => f.email && f.referral_code)
        .map((f) => [
          csvCell(f.email),
          csvCell(f.first_name || ""),
          csvCell(String(f.referral_code).toUpperCase()),
          csvCell(surveyUrl(String(f.referral_code).toUpperCase())),
        ].join(","));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="ff-survey-uids-${list.length}.csv"`);
      return res.status(200).send([head, ...body].join("\r\n") + "\r\n");
    }

    // push
    let pushed = 0, skipped = 0, failed = 0;
    const errors = [];
    for (const f of list) {
      if (!f.referral_code || (!f.email && !f.mobile)) { skipped += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const out = await cnSetUid({
        first_name: f.first_name,
        last_name: f.last_name,
        email: f.email,
        mobile: f.mobile,
        uid: f.referral_code,
      });
      if (out && out.ok) pushed += 1;
      else if (out && out.skipped) skipped += 1;
      else {
        failed += 1;
        if (errors.length < 5) errors.push({ email: f.email, status: out && out.status, body: out && out.body });
      }
    }

    return res.status(200).json({
      ok: true,
      mode,
      seen: list.length,
      pushed,
      skipped,
      failed,
      ...(errors.length ? { errors } : {}),
      // Airtable's own cursor. Keep calling with it until it comes back null.
      nextCursor,
    });
  } catch (e) {
    console.error("survey-uids error:", e.message);
    return res.status(500).json({ error: "failed", detail: e.message });
  }
};
