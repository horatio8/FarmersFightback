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
//   GET /api/admin/survey-uids?mode=bulk[&state=1][&cursor=<c>]
//     → JSON { seen, pushed, skipped, failed, chunks, waves, nextCursor, ... }
//       The backfill workhorse: pages of contacts pushed through CN's
//       /profiles/match/bulk. CN matches each profile synchronously at
//       roughly a second a profile (measured), so batches are small, waves
//       of a few run in parallel, and everything is time-boxed with the
//       cursor bookkeeping guaranteeing no queued row is skipped on resume.
//       With &state=1 the cursor lives in Sync State (key cn_uid_backfill)
//       behind a soft lock, so a cron and a manual driver can share the walk
//       safely; without it, pass &cursor= from the previous response.
//       Tuning: &chunk= rows per CN call, &p= parallel calls per wave,
//       &budget= ms, &slim=1 drops names from the payload (probe knob).
//
//   &email=x@y.com  → single contact, csv/push modes, for spot checks.
//
// Contacts without a referral_code are skipped rather than issued one: minting
// here would write codes for people who may never be emailed. They pick one up
// through the normal paths (petition-signup, event-log, share-context).
//
// Guarded by ADMIN_BASIC_AUTH (same as /api/ab-report), ?token=ADMIN_TOKEN, or
// the Vercel cron bearer (CRON_SECRET) so a cron entry can self-drive mode=bulk.

const { listRows, listPage, normEmail } = require("../_airtable");
const { requireBasicAuth, hostBase } = require("../_util");
const { cnSetUid, cnSetUidBulkSafe, CN_UID_FIELD } = require("../_cn");
const { select, create, update, fesc } = require("../../lib/social/airtable");
const { TABLES } = require("../../lib/econ/config");

const CONTACTS_TABLE = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
const PUBLIC_BASE = "https://www.farmersfightback.com";
const SURVEY_SLUG = "supporters";
const FIELDS = ["contact_id", "email", "mobile", "first_name", "last_name", "referral_code"];

// Keep a push batch well inside the function execution limit. Each row is one
// CN round trip, so this is the knob to turn if pushes start timing out.
const PUSH_BATCH = 200;
const CSV_LIMIT = 50000;
// Bulk mode. CN's bulk matcher runs ~1s per profile and a call in flight
// cannot be interrupted, so chunks stay small and every wave is guarded
// against the remaining budget before it starts.
const BULK_CHUNK = 50;
const BULK_P = 2; // parallel CN calls per wave (measured: 2 ≈ 1.3x serial)
const BULK_WAVES_MAX = 8;
const BULK_BUDGET_MS = 265 * 1000;
const STATE_KEY = "cn_uid_backfill";
const START_SENTINEL = "@start";

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
  const cronOk = Boolean(process.env.CRON_SECRET)
    && (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET}`;
  if (!tokenOk && !cronOk && !requireBasicAuth(req, res)) return;
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
      const chunk = Math.min(200, Math.max(10, Number(url.searchParams.get("chunk")) || BULK_CHUNK));
      const P = Math.min(4, Math.max(1, Number(url.searchParams.get("p")) || BULK_P));
      const slim = url.searchParams.get("slim") === "1";
      const useState = url.searchParams.get("state") === "1";
      const budget = Math.min(
        BULK_BUDGET_MS,
        Math.max(20000, Number(url.searchParams.get("budget")) || BULK_BUDGET_MS)
      );
      const started = Date.now();

      // Shared-cursor mode: the walk position lives in Sync State behind a
      // soft lock, so the backfill cron and a manual driver can interleave
      // without stepping on each other (a stale lock expires on its own).
      let stateRec = null;
      let stateVal = null;
      let cursorVal = cursor;
      if (useState) {
        const rows0 = await select(TABLES.SYNC_STATE, `{key} = '${fesc(STATE_KEY)}'`, null, 1);
        stateRec = rows0.length ? rows0[0] : null;
        try { stateVal = stateRec && stateRec.fields.value ? JSON.parse(stateRec.fields.value) : null; } catch { stateVal = null; }
        if (stateVal && stateVal.done) {
          return res.status(200).json({ ok: true, mode, done: true, state: stateVal });
        }
        if (stateVal && stateVal.lock_until && stateVal.lock_until > Date.now()) {
          return res.status(200).json({ ok: true, mode, locked: true, lock_until: stateVal.lock_until });
        }
        cursorVal = stateVal && stateVal.cursor ? stateVal.cursor : undefined;
        const lockVal = { ...(stateVal || {}), lock_until: Date.now() + budget + 30000 };
        const lockFields = { key: STATE_KEY, value: JSON.stringify(lockVal), updated_at: new Date().toISOString() };
        if (stateRec) await update(TABLES.SYNC_STATE, [{ id: stateRec.id, fields: lockFields }]);
        else {
          const made = await create(TABLES.SYNC_STATE, [lockFields]);
          stateRec = made[0];
        }
        stateVal = lockVal;
      }
      if (cursorVal === START_SENTINEL) cursorVal = undefined;

      // Gather: walk pages recording each page's start cursor, so the resume
      // point can be computed exactly from whatever ends up unflushed.
      const pages = [];
      let seen = 0, skipped = 0;
      let pageCursor = cursorVal;
      let drained = false;
      let queued = 0;
      const rowsTarget = chunk * P * BULK_WAVES_MAX;
      const gatherUntil = started + budget * 0.25;
      while (!drained && queued < rowsTarget && Date.now() < gatherUntil) {
        const startCursor = pageCursor || START_SENTINEL;
        // eslint-disable-next-line no-await-in-loop
        const page = await listPage(CONTACTS_TABLE, {
          formula,
          fields: FIELDS,
          pageSize: 100,
          offset: pageCursor,
        });
        const rows = [];
        for (const r of page.records) {
          const f = r.fields || {};
          seen += 1;
          if (!f.referral_code || (!f.email && !f.mobile)) { skipped += 1; continue; }
          rows.push({
            first_name: f.first_name,
            last_name: f.last_name,
            email: f.email,
            mobile: f.mobile,
            uid: f.referral_code,
          });
        }
        pages.push({ startCursor, rows, unflushed: rows.length });
        queued += rows.length;
        pageCursor = page.offset || null;
        if (!pageCursor) drained = true;
      }

      // Flush: waves of P parallel chunk-sized CN calls. A call in flight
      // cannot be interrupted, so each wave starts only if the measured (or
      // conservatively estimated) wave time still fits the budget.
      const queue = [];
      pages.forEach((p, pi) => p.rows.forEach((row) => queue.push({ pi, row })));
      let qi = 0;
      let pushed = 0, failed = 0, chunks = 0, waves = 0;
      let firstErr = null;
      let lastWaveMs = null;
      while (qi < queue.length) {
        const remaining = budget - (Date.now() - started);
        // Estimate: measured last wave, else ~1.7s a row a call under load.
        const estWave = lastWaveMs ? lastWaveMs * 1.3 : chunk * 1700;
        if (remaining < estWave + 8000) break;
        const waveItems = queue.slice(qi, qi + chunk * P);
        const parts = [];
        for (let i = 0; i < waveItems.length; i += chunk) parts.push(waveItems.slice(i, i + chunk));
        const t0 = Date.now();
        // Each wave's retry cascade dies before the invocation budget does.
        const waveDeadline = Math.max(30000, budget - (Date.now() - started) - 15000);
        // eslint-disable-next-line no-await-in-loop
        const outs = await Promise.all(parts.map((part) => cnSetUidBulkSafe(part.map((w) => w.row), { slim, deadlineMs: waveDeadline })));
        lastWaveMs = Date.now() - t0;
        waves += 1;
        for (const out of outs) {
          chunks += 1;
          pushed += out.pushed; skipped += out.skipped; failed += out.failed;
          if (out.err && !firstErr) firstErr = out.err;
        }
        for (const w of waveItems) pages[w.pi].unflushed -= 1;
        qi += waveItems.length;
      }

      // A mostly-failed run means CN itself is down, not that those contacts
      // are bad — void the run so the cursor stays put and they retry whole.
      const attempted = pushed + failed;
      const voidRun = failed >= 20 && failed >= attempted * 0.5;

      // Resume point: the first page still holding an unflushed row; if all
      // flushed, the cursor after the last gathered page (null when drained).
      const firstUnflushed = pages.find((p) => p.unflushed > 0);
      const nextCursor = voidRun
        ? (cursorVal || START_SENTINEL)
        : (firstUnflushed ? firstUnflushed.startCursor : (drained ? null : pageCursor));
      const complete = nextCursor === null;

      if (useState && stateRec) {
        const nowIso = new Date().toISOString();
        const newVal = {
          cursor: complete ? null : nextCursor,
          done: complete,
          lock_until: 0,
          total_pushed: ((stateVal && stateVal.total_pushed) || 0) + pushed,
          total_failed: ((stateVal && stateVal.total_failed) || 0) + (voidRun ? 0 : failed),
          total_skipped: ((stateVal && stateVal.total_skipped) || 0) + (voidRun ? 0 : skipped),
          runs: ((stateVal && stateVal.runs) || 0) + 1,
          void_runs: ((stateVal && stateVal.void_runs) || 0) + (voidRun ? 1 : 0),
          last_run: nowIso,
        };
        await update(TABLES.SYNC_STATE, [{ id: stateRec.id, fields: { key: STATE_KEY, value: JSON.stringify(newVal), updated_at: nowIso } }]);
      }

      return res.status(200).json({
        ok: true,
        mode,
        seen,
        pushed,
        skipped,
        failed,
        chunks,
        waves,
        chunk,
        p: P,
        slim,
        ...(voidRun ? { void_run: true } : {}),
        elapsed_ms: Date.now() - started,
        last_wave_ms: lastWaveMs,
        ...(firstErr ? { first_error: firstErr } : {}),
        done: complete,
        nextCursor,
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
