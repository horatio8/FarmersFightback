// Campaign Nucleus API client (account slug `teller`). Two endpoints the
// donation-maximisation build relies on (confirmed available in the brief):
//   POST /profiles/match              — match-or-create a profile
//   POST /automations/{id}/profiles   — drop a profile into an automation
//
// Every call is best-effort and never throws: if CN_API_KEY isn't set yet
// the caller gets { skipped: true } and carries on. Ship-dark friendly.
//
// Env:
//   CN_API_KEY   Bearer token for the CN API
//   CN_API_BASE  default https://teller.campaignnucleus.com/api/v1

const CN_BASE = (process.env.CN_API_BASE || "https://teller.campaignnucleus.com/api/v1").replace(/\/$/, "");
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

// Match-or-create a CN profile. `profile` uses CN's field names:
// first_name, last_name, email, mobile/phone, zip, tags[], custom1..10.
// The live CN API rejects POST on this route ("supported: GET, HEAD, PUT,
// PATCH, DELETE" — verified against production), so PUT with a PATCH
// fallback for older tenants.
async function cnProfileMatch(profile) {
  const out = await cnFetch("/profiles/match", profile, "PUT");
  if (out.status === 405) return cnFetch("/profiles/match", profile, "PATCH");
  return out;
}

// Drop a profile into a CN automation (fires its email sequence).
function cnAutomationAdd(automationId, profile) {
  if (!automationId) return Promise.resolve({ skipped: true, reason: "no automation id" });
  return cnFetch(`/automations/${encodeURIComponent(automationId)}/profiles`, profile);
}

module.exports = { cnProfileMatch, cnAutomationAdd };
