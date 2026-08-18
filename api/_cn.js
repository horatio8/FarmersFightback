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

async function cnFetch(path, body, method = "POST", opts = {}) {
  if (!CN_KEY) return { skipped: true, reason: "CN_API_KEY not set" };
  // CN's gateway (nginx) 504s long requests at roughly three minutes, and a
  // hung request otherwise blocks until then — cut our side first so callers
  // fail fast and their budget survives.
  const timeoutMs = opts.timeoutMs || 170000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${CN_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CN_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // fetch() throws outright on a GET carrying a body, and every call here
      // used to pass one — JSON.stringify(null) is the string "null", not
      // nothing. Reads have to omit it entirely.
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
      signal: ctl.signal,
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
    const msg = e.name === "AbortError" ? `client timeout after ${timeoutMs}ms` : e.message;
    console.error(`CN ${method} ${path} failed:`, msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
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
// CN validates with PHP's filter_var, which is stricter than a loose
// "something@something.something" test. Sending an address it rejects costs
// far more than dropping it: the 422 fails the whole bulk call, and the
// split-retry then burns minutes isolating one row. The imported cohort is
// full of truncated addresses ("…@gmail.c", "…@optusnet.com.a", trailing
// dots) — about 4% of it — so this check has to match CN's, not be generous.
// A rejected address doesn't lose the contact: bulkRow falls back to matching
// on mobile, and these addresses cannot receive email anyway.
const EMAIL_RE = new RegExp(
  "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
  + "@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$"
);
function looksLikeEmail(s) {
  const v = String(s || "").trim();
  if (!v || v.length > 254) return false;
  const at = v.indexOf("@");
  if (at < 1 || at > 64) return false;
  return EMAIL_RE.test(v);
}

function bulkRow(r, slim) {
  // A malformed email (double-@ typos exist in the base) risks failing the
  // whole batch, so drop the bad address and match on mobile if there is one.
  const email = looksLikeEmail(r.email) ? r.email : undefined;
  if (!r.uid || (!email && !r.mobile)) return null;
  if (slim) {
    // Minimal payload: identity + the UID, nothing for CN to update beyond
    // the custom field. Used to probe/reduce CN's per-profile match cost.
    return {
      email,
      mobile: email ? undefined : r.mobile,
      custom1: String(r.uid).toUpperCase(),
    };
  }
  return {
    first_name: r.first_name || undefined,
    last_name: r.last_name || undefined,
    email,
    mobile: r.mobile || undefined,
    custom1: String(r.uid).toUpperCase(),
  };
}

async function cnSetUidBulk(rows, opts = {}) {
  const body = (rows || []).map((r) => bulkRow(r, opts.slim)).filter(Boolean);
  if (!body.length) return { skipped: true, reason: "no pushable rows" };
  return cnFetch("/profiles/match/bulk", body, "POST");
}

// Bulk push with split-retry: a failed batch is halved and retried so one bad
// row cannot sink the good ones; small remnants fall back to per-row
// cnProfileMatch, isolating the genuinely broken rows. The whole cascade runs
// against a deadline — when CN itself is failing (gateway 504s), retries stop
// and the remainder reports failed fast instead of eating the caller's budget.
// Returns { pushed, skipped, failed, calls, err } with err = first failure.
async function cnSetUidBulkSafe(rows, opts = {}) {
  const body = (rows || []).map((r) => bulkRow(r, opts.slim)).filter(Boolean);
  const skippedUpfront = (rows || []).length - body.length;
  const deadline = Date.now() + (opts.deadlineMs || 200000);
  const out = await pushSplit(body, deadline);
  return { ...out, skipped: out.skipped + skippedUpfront };
}

async function pushSplit(body, deadline) {
  if (!body.length) return { pushed: 0, skipped: 0, failed: 0, calls: 0 };
  if (Date.now() > deadline) {
    return { pushed: 0, skipped: 0, failed: body.length, calls: 0, err: { error: "retry deadline exhausted" } };
  }
  // Per-row cost is not stable: ~1s during the first backfill, ~2.5s since.
  // At 2500ms/row the timeout sat exactly on the measured cost, so healthy
  // calls were being aborted and re-split — 48 "failures" in a batch of 65
  // that had nothing wrong with it. Allow 5s a row (still inside CN's ~3min
  // gateway limit at these chunk sizes) and let real errors surface as errors.
  const bulkTimeout = Math.min(165000, Math.max(30000, body.length * 5000));
  const out = await cnFetch("/profiles/match/bulk", body, "POST", { timeoutMs: bulkTimeout });
  if (out.skipped) return { pushed: 0, skipped: body.length, failed: 0, calls: 0 };
  if (out.ok) return { pushed: body.length, skipped: 0, failed: 0, calls: 1 };
  if (body.length <= 10) {
    let pushed = 0, failed = 0, calls = 1, err;
    for (const p of body) {
      if (Date.now() > deadline) { failed += 1; err = err || { error: "retry deadline exhausted" }; continue; }
      // eslint-disable-next-line no-await-in-loop
      const one = await cnFetch("/profiles/match", p, "POST", { timeoutMs: 20000 });
      calls += 1;
      if (one && one.ok) pushed += 1;
      else { failed += 1; err = err || { status: one && one.status, body: one && one.body, error: one && one.error }; }
    }
    return { pushed, skipped: 0, failed, calls, err };
  }
  const mid = Math.ceil(body.length / 2);
  const a = await pushSplit(body.slice(0, mid), deadline);
  const b = await pushSplit(body.slice(mid), deadline);
  return {
    pushed: a.pushed + b.pushed,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    calls: a.calls + b.calls + 1,
    err: a.err || b.err,
  };
}

// Drop a profile into a CN automation (fires its email sequence).
function cnAutomationAdd(automationId, profile) {
  if (!automationId) return Promise.resolve({ skipped: true, reason: "no automation id" });
  return cnFetch(`/automations/${encodeURIComponent(automationId)}/profiles`, profile);
}

// Campaign Nucleus landing-page forms. A form doubles as a receiver: entries
// can be posted straight into it, so a signup taken on our own site lands in
// CN as if it had come through the hosted page — same list, same reporting.
//
// Used to mirror the FUNdraiser signups from /fun, which otherwise only ever
// existed in Airtable. Deliberately a SECOND destination, never the first: the
// Airtable write and the Stripe session are the flow that matters, and a CN
// outage must not cost a ticket sale.
const CN_FUN_FORM_ID = process.env.CN_FUN_FORM_ID
  || "4117e43f-2c36-425d-88e4-e330c444b873"; // Farmer Fightback: FUNdraiser

function cnFormEntry(formId, entry, opts = {}) {
  if (!formId) return Promise.resolve({ skipped: true, reason: "no form id" });
  return cnFetch(`/forms/${encodeURIComponent(formId)}/entries`, entry, "POST", {
    // Short leash. This runs inside a checkout request, so it waits on CN for
    // a couple of seconds at most and then gets out of the way.
    timeoutMs: opts.timeoutMs || 4000,
  });
}

// Mirror one FUNdraiser signup into the CN landing page. Never throws — the
// caller is mid-checkout and a reporting copy is not worth a failed sale.
async function cnFunSignup({ first_name, last_name, email, phone, postcode, utm_source, utm_medium, utm_campaign }) {
  if (!email) return { skipped: true, reason: "no email" };
  const first = String(first_name || "").trim();
  const last = String(last_name || "").trim();
  const entry = {
    email: String(email).trim(),
    first_name: first || undefined,
    last_name: last || undefined,
    full_name: [first, last].filter(Boolean).join(" ") || undefined,
    phone: phone ? String(phone).trim() : undefined,
    postcode: postcode ? String(postcode).trim() : undefined,
    utm_source: utm_source || "farmersfightback.com",
    utm_medium: utm_medium || undefined,
    utm_campaign: utm_campaign || "fundraiser",
  };
  Object.keys(entry).forEach((k) => entry[k] === undefined && delete entry[k]);
  try {
    const out = await cnFormEntry(CN_FUN_FORM_ID, entry);
    return { ok: !!(out && out.ok) };
  } catch (e) {
    console.error("cnFunSignup failed:", e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  cnFetch, cnProfileMatch, cnAutomationAdd, cnSetUid, cnSetUidBulk, cnSetUidBulkSafe,
  cnFormEntry, cnFunSignup, CN_UID_FIELD, CN_FUN_FORM_ID,
};
