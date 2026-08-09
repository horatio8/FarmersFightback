// Campaign Nucleus API client (account slug `teller`). Two endpoints the
// donation-maximisation build relies on (confirmed available in the brief):
//   POST /profiles/match              — match-or-create a profile
//   POST /automations/{id}/profiles   — drop a profile into an automation
//
// Every call is best-effort and never throws: if CN_API_KEY isn't set yet
// the caller gets { skipped: true } and carries on. Ship-dark friendly.
//
// Env:
//   CN_API_KEY   Bearer token for the CN API (tenant-scoped — carries the
//                teller account, no slug needed in the URL)
//   CN_API_BASE  default https://api.campaignnucleus.com/v1
//                (probed against production: the tenant subdomain's
//                /api/v1 is CN's internal web API — rejects POST and
//                throws Laravel CSRF errors; the central api.* host is
//                the real public API)

const CN_BASE = (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/$/, "");
const CN_KEY = process.env.CN_API_KEY;

async function cnFetch(path, body, method = "POST") {
  if (!CN_KEY) return { skipped: true, reason: "CN_API_KEY not set" };
  try {
    const r = await fetch(`${CN_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CN_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      console.error(`CN ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: r.status, body: text.slice(0, 300) };
    }
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: true, status: r.status, json };
  } catch (e) {
    console.error(`CN ${method} ${path} failed:`, e.message);
    return { ok: false, error: e.message };
  }
}

// The CRM custom field (Settings > CRM) whose alias backs the email merge tag
// %recipient.FarmersFightback_UID%. We populate it with the contact's
// referral_code so one value serves as both the survey link token and the
// referral attribution code.
//
// Probed against production: custom fields are set as a TOP-LEVEL key on the
// profile body, not nested under `fields` — sending `fields: {…}` is accepted
// with a 200 but silently leaves the column null. They come back on read under
// the same top-level key. /profiles/match both matches and updates it.
const CN_UID_FIELD = "FarmersFightback_UID";

// Match-or-create a CN profile. `profile` uses CN's field names:
// first_name, last_name, email, mobile/phone, zip, tags[], custom1..10, plus
// any CRM custom field alias as a top-level key.
// POST per the documented contract; PUT fallback in case a tenant router
// answers 405 (the internal web API does).
async function cnProfileMatch(profile) {
  const out = await cnFetch("/profiles/match", profile, "POST");
  if (out.status === 405) return cnFetch("/profiles/match", profile, "PUT");
  return out;
}

// Set (or refresh) a contact's survey/referral UID on their CN profile.
// Best-effort like everything else here: never throws, returns the raw result.
function cnSetUid({ first_name, last_name, email, mobile, uid }) {
  if (!uid || (!email && !mobile)) {
    return Promise.resolve({ skipped: true, reason: "uid and an email or mobile required" });
  }
  return cnProfileMatch({
    first_name: first_name || undefined,
    last_name: last_name || undefined,
    email: email || undefined,
    mobile: mobile || undefined,
    [CN_UID_FIELD]: String(uid).toUpperCase(),
  });
}

// Bulk variant of cnSetUid: one POST /profiles/match/bulk for a whole batch.
// Probed against production: custom1 is the column backing the
// FarmersFightback_UID CRM alias — the bulk endpoint matches existing
// profiles (names and tags intact) and sets it, echoing the alias back.
// Rows use the same shape cnSetUid takes: {first_name,last_name,email,mobile,uid}.
function looksLikeEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
}

function bulkRow(r) {
  // A malformed email (double-@ typos exist in the base) risks failing the
  // whole batch, so drop the bad address and match on mobile if there is one.
  const email = looksLikeEmail(r.email) ? r.email : undefined;
  if (!r.uid || (!email && !r.mobile)) return null;
  return {
    first_name: r.first_name || undefined,
    last_name: r.last_name || undefined,
    email,
    mobile: r.mobile || undefined,
    custom1: String(r.uid).toUpperCase(),
  };
}

async function cnSetUidBulk(rows) {
  const body = (rows || []).map(bulkRow).filter(Boolean);
  if (!body.length) return { skipped: true, reason: "no pushable rows" };
  return cnFetch("/profiles/match/bulk", body, "POST");
}

// Bulk push with split-retry: a failed batch is halved and retried so one bad
// row cannot sink 250 good ones; small remnants fall back to per-row
// cnProfileMatch, isolating the genuinely broken rows. Returns
// { pushed, skipped, failed, calls, err } with err = first failure detail.
async function cnSetUidBulkSafe(rows) {
  const body = (rows || []).map(bulkRow).filter(Boolean);
  const skippedUpfront = (rows || []).length - body.length;
  const out = await pushSplit(body);
  return { ...out, skipped: out.skipped + skippedUpfront };
}

async function pushSplit(body) {
  if (!body.length) return { pushed: 0, skipped: 0, failed: 0, calls: 0 };
  const out = await cnSetUidBulk0(body);
  if (out.skipped) return { pushed: 0, skipped: body.length, failed: 0, calls: 0 };
  if (out.ok) return { pushed: body.length, skipped: 0, failed: 0, calls: 1 };
  if (body.length <= 25) {
    let pushed = 0, failed = 0, calls = 1, err;
    for (const p of body) {
      // eslint-disable-next-line no-await-in-loop
      const one = await cnProfileMatch(p);
      calls += 1;
      if (one && one.ok) pushed += 1;
      else { failed += 1; err = err || { status: one && one.status, body: one && one.body, error: one && one.error }; }
    }
    return { pushed, skipped: 0, failed, calls, err };
  }
  const mid = Math.ceil(body.length / 2);
  const a = await pushSplit(body.slice(0, mid));
  const b = await pushSplit(body.slice(mid));
  return {
    pushed: a.pushed + b.pushed,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    calls: a.calls + b.calls + 1,
    err: a.err || b.err,
  };
}

function cnSetUidBulk0(body) {
  return cnFetch("/profiles/match/bulk", body, "POST");
}

// Drop a profile into a CN automation (fires its email sequence).
function cnAutomationAdd(automationId, profile) {
  if (!automationId) return Promise.resolve({ skipped: true, reason: "no automation id" });
  return cnFetch(`/automations/${encodeURIComponent(automationId)}/profiles`, profile);
}

module.exports = { cnFetch, cnProfileMatch, cnAutomationAdd, cnSetUid, cnSetUidBulk, cnSetUidBulkSafe, CN_UID_FIELD };
