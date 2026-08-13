// The standing guarantee: every contact holds a referral code, and no two
// contacts hold the same one.
//
// Codes are minted at contact creation, so in the steady state this cron finds
// nothing. It exists because creation is not the only way a contact appears:
// bulk CSV loads, rows typed straight into Airtable and any future import path
// all bypass the application entirely. Those left ~6,000 contacts (10% of the
// table) with no code, and a contact with no code cannot be sent a tokenised
// survey or invitation link.
//
// GET /api/cron/referral-code-integrity   (CRON_SECRET bearer or ?token=ADMIN_TOKEN)
//   ?scan=1     force the duplicate sweep this run
//   ?dry=1      report what it would do, write nothing
//   ?limit=N    cap mints this run
//
// Two phases:
//   MINT   contacts with an empty code get one. Uniqueness comes from the
//          in-memory set of every code in the table, loaded once and updated
//          as we go — one pass of ~550 reads beats one lookup per mint.
//   SWEEP  the same pass detects duplicates. The earliest holder keeps the
//          code (their links are already in the wild); later holders are
//          reissued. Runs at most daily unless ?scan=1 forces it.
//
// New codes are pushed to Campaign Nucleus in the same run: the nightly
// survey-uid-push cron filters on CREATED_TIME, so a contact created in July
// that gets its code today would never match its watermark.

const { select, create, update, listPage, fesc } = require("../../lib/social/airtable");
const { TABLES } = require("../../lib/econ/config");
const { cnSetUidBulkSafe } = require("../_cn");

const CONTACTS = process.env.AIRTABLE_CONTACTS_TABLE || "tblE5snFCtwZmXkry";
const STATE_KEY = "referral_code_integrity";
const BUDGET_MS = 265 * 1000;
const SWEEP_EVERY_MS = 22 * 3600 * 1000; // ~daily, with slack for cron drift
const CN_CHUNK = 40;
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const crypto = require("crypto");
function makeCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}

// Draw against the loaded set — no network round trip per attempt, and the
// set is updated immediately so codes minted in this very run can't clash
// with each other either.
function mintAgainst(taken) {
  for (let i = 0; i < 40; i++) {
    const c = makeCode();
    if (!taken.has(c)) { taken.add(c); return c; }
  }
  for (let i = 0; i < 20; i++) {
    const c = makeCode(8);
    if (!taken.has(c)) { taken.add(c); return c; }
  }
  return null;
}

async function readState() {
  const rows = await select(TABLES.SYNC_STATE, `{key} = '${fesc(STATE_KEY)}'`, null, 1);
  const rec = rows[0] || null;
  let val = null;
  try { val = rec && rec.fields.value ? JSON.parse(rec.fields.value) : null; } catch { val = null; }
  return { rec, val: val || {} };
}

async function writeState(rec, val) {
  const fields = { key: STATE_KEY, value: JSON.stringify(val), updated_at: new Date().toISOString() };
  if (rec) await update(TABLES.SYNC_STATE, [{ id: rec.id, fields }]);
  else await create(TABLES.SYNC_STATE, [fields]);
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  const auth = req.headers.authorization || "";
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const tokenOk = process.env.ADMIN_TOKEN && url.searchParams.get("token") === process.env.ADMIN_TOKEN;
  if (!cronOk && !tokenOk) return res.status(401).json({ error: "unauthorized" });
  res.setHeader("Cache-Control", "no-store");

  const started = Date.now();
  const dry = url.searchParams.get("dry") === "1";
  const forceScan = url.searchParams.get("scan") === "1";
  const limit = Math.max(0, Number(url.searchParams.get("limit")) || 100000);

  try {
    const { rec: stateRec, val: state } = await readState();

    // Cheap probe: is there anything missing a code at all? In the steady
    // state this is one request and the expensive full pass never runs.
    // NB: this listPage passes raw Airtable query params — the filter key is
    // filterByFormula, not formula. A wrong key is ignored silently and the
    // probe then matches every contact, which is exactly what it must not do.
    const probe = await listPage(CONTACTS, {
      filterByFormula: "{referral_code} = ''",
      fields: ["contact_id"],
      pageSize: 1,
    });
    const anyMissing = probe.records.length > 0;
    const lastSweep = Number(state.last_sweep_ms || 0);
    const dueSweep = forceScan || Date.now() - lastSweep > SWEEP_EVERY_MS;

    if (!anyMissing && !dueSweep) {
      return res.status(200).json({
        ok: true, nothing_to_do: true, minted: 0, repaired: 0,
        next_sweep_in_min: Math.max(0, Math.round((SWEEP_EVERY_MS - (Date.now() - lastSweep)) / 60000)),
      });
    }

    // Full pass: every code in the table. Also the only way to see duplicates.
    const taken = new Set();
    const seenAt = new Map(); // code → { id, created } of the earliest holder
    const dupes = []; // later holders, to be reissued
    const missing = []; // { id, email, mobile, first_name, last_name }
    let offset;
    let scanned = 0;
    let truncated = false;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await listPage(CONTACTS, {
        fields: ["referral_code", "email", "mobile", "first_name", "last_name"],
        pageSize: 100,
        offset,
      });
      for (const r of page.records) {
        scanned += 1;
        const f = r.fields || {};
        const code = String(f.referral_code || "").trim().toUpperCase();
        if (!code) {
          if (missing.length < limit) {
            missing.push({ id: r.id, email: f.email, mobile: f.mobile, first_name: f.first_name, last_name: f.last_name });
          }
          continue;
        }
        if (taken.has(code)) {
          // Keep the earliest holder: their code is already in emails and
          // share links. The later record is the one that gets reissued.
          const first = seenAt.get(code);
          const mine = { id: r.id, created: r.createdTime, code, email: f.email, mobile: f.mobile, first_name: f.first_name, last_name: f.last_name };
          if (first && new Date(r.createdTime) < new Date(first.created)) {
            dupes.push({ ...first, code });
            seenAt.set(code, mine);
          } else {
            dupes.push(mine);
          }
        } else {
          taken.add(code);
          seenAt.set(code, { id: r.id, created: r.createdTime });
        }
      }
      offset = page.offset;
      if (Date.now() - started > BUDGET_MS * 0.55) { truncated = Boolean(offset); break; }
    } while (offset);

    const work = [
      ...missing.map((m) => ({ ...m, reason: "missing" })),
      ...dupes.slice(0, Math.max(0, limit - missing.length)).map((d) => ({ ...d, reason: "duplicate" })),
    ];

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, scanned, truncated,
        missing: missing.length, duplicates: dupes.length,
        sample_duplicate_codes: [...new Set(dupes.map((d) => d.code))].slice(0, 10),
      });
    }

    // Assign and write in batches of 10 (Airtable's per-request cap).
    const assigned = [];
    for (const w of work) {
      const code = mintAgainst(taken);
      if (!code) break;
      assigned.push({ ...w, code });
    }

    let written = 0;
    for (let i = 0; i < assigned.length; i += 10) {
      if (Date.now() - started > BUDGET_MS) break;
      const batch = assigned.slice(i, i + 10);
      // eslint-disable-next-line no-await-in-loop
      await update(CONTACTS, batch.map((a) => ({ id: a.id, fields: { referral_code: a.code } })));
      written += batch.length;
    }
    const done = assigned.slice(0, written);

    // Push the new codes to CN now. survey-uid-push keys off CREATED_TIME, so
    // an old contact newly given a code would never reach its watermark.
    let cnPushed = 0, cnFailed = 0;
    const pushable = done.filter((d) => d.email || d.mobile);
    for (let i = 0; i < pushable.length; i += CN_CHUNK) {
      if (Date.now() - started > BUDGET_MS) break;
      const batch = pushable.slice(i, i + CN_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const out = await cnSetUidBulkSafe(
        batch.map((b) => ({ first_name: b.first_name, last_name: b.last_name, email: b.email, mobile: b.mobile, uid: b.code })),
        { deadlineMs: Math.max(20000, BUDGET_MS - (Date.now() - started)) }
      );
      cnPushed += out.pushed; cnFailed += out.failed;
    }

    const mintedCount = done.filter((d) => d.reason === "missing").length;
    const repairedCount = done.filter((d) => d.reason === "duplicate").length;
    const complete = !truncated && written === assigned.length;

    await writeState(stateRec, {
      ...state,
      // Only a complete pass proves the table is clean, so only then does the
      // sweep clock reset — a truncated run must not buy itself a day off.
      last_sweep_ms: complete ? Date.now() : lastSweep,
      last_run: new Date().toISOString(),
      last_scanned: scanned,
      last_minted: mintedCount,
      last_repaired: repairedCount,
      total_minted: (Number(state.total_minted) || 0) + mintedCount,
      total_repaired: (Number(state.total_repaired) || 0) + repairedCount,
      runs: (Number(state.runs) || 0) + 1,
    });

    return res.status(200).json({
      ok: true,
      scanned,
      truncated,
      complete,
      missing_found: missing.length,
      duplicates_found: dupes.length,
      minted: mintedCount,
      repaired: repairedCount,
      cn_pushed: cnPushed,
      cn_failed: cnFailed,
      elapsed_ms: Date.now() - started,
    });
  } catch (e) {
    console.error("referral-code-integrity:", e.message);
    return res.status(500).json({ error: "failed", detail: e.message });
  }
};
