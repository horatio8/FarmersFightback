// Vercel serverless function: comp / VIP token flow for the Rally.
// Validates a claim token, decrements its allowance on redeem, and logs
// the resulting Rally Ticket Comped event to Airtable — reusing the
// same matchOrCreateContact + logEvent pipeline as everything else.
//
// GET  /api/rally-claim?token=VIP-XXXX
//   → { valid: true, max_qty, used_qty } | { valid: false, error }
//
// POST /api/rally-claim
//   Body: { token, qty, first_name, last_name, email, phone, postcode, ref }
//   → { ok: true, referral_code, order_ref } on success
//
// Token store: Airtable table (default name "Rally Comp Tokens") with
// fields: token (text), max_qty (number), used_qty (number),
// status (single-select: active | redeemed | disabled),
// contact (link to Contacts, optional — populated on first redeem so
// the recipient identity is tracked).
//
// Env:
//   AIRTABLE_RALLY_COMP_TOKENS_TABLE   default "Rally Comp Tokens"
//   RALLY_COMP_TOKEN_FALLBACK          optional; comma-separated demo
//                                      tokens that pass validation even
//                                      when the token table isn't set up
//                                      yet. Preview-only convenience.

const {
  matchOrCreateContact,
  setReferralCodeIfMissing,
  logEvent,
  updateContactStatusFromEvent,
} = require("./_airtable");

const AT_BASE = process.env.AIRTABLE_BASE_ID;
const AT_KEY = process.env.AIRTABLE_API_KEY;
const TOKENS_TABLE = process.env.AIRTABLE_RALLY_COMP_TOKENS_TABLE || "Rally Comp Tokens";
const AT_API = "https://api.airtable.com/v0";

const ALLOWED_ORIGINS = new Set([
  "https://farmersfightback.com",
  "https://www.farmersfightback.com",
  "https://preview.farmersfightback.com",
  "https://farmersfightback.vercel.app",
  "https://farmersfightback-tellerconsulting.vercel.app",
]);

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.endsWith("-tellerconsulting.vercel.app")) return origin;
  return null;
}

function escapeFormula(s) {
  return String(s).replace(/'/g, "\\'");
}

async function atFetch(path, opts = {}) {
  if (!AT_BASE || !AT_KEY) {
    const err = new Error("AIRTABLE_BASE_ID or AIRTABLE_API_KEY not set");
    err.code = "MISCONFIGURED";
    throw err;
  }
  const r = await fetch(`${AT_API}/${AT_BASE}/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${AT_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`Airtable ${r.status}: ${body.slice(0, 500)}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return r.json();
}

async function findTokenRecord(token) {
  const params = new URLSearchParams({
    filterByFormula: `{token}='${escapeFormula(String(token).toUpperCase())}'`,
    maxRecords: "1",
    pageSize: "1",
  });
  try {
    const r = await atFetch(`${encodeURIComponent(TOKENS_TABLE)}?${params}`);
    return r.records && r.records[0] ? r.records[0] : null;
  } catch (e) {
    // If the table doesn't exist yet, surface that as a clear error the
    // caller can decide to fall back on. Airtable's error codes vary:
    //   - 422 UNKNOWN_TABLE_NAME (older API)
    //   - 404 NOT_FOUND
    //   - 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND (current API — includes
    //     both "table doesn't exist" and "token lacks access to it")
    const isNoTable = e.status === 422
      || e.status === 404
      || (e.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/i.test(e.body || e.message || ""));
    if (isNoTable) {
      const err = new Error("Token table not configured");
      err.code = "NO_TABLE";
      throw err;
    }
    throw e;
  }
}

function tokenSummary(record) {
  const f = record.fields || {};
  const status = (f.status && f.status.name) || f.status || "active";
  return {
    token: f.token,
    max_qty: Number(f.max_qty) || 0,
    used_qty: Number(f.used_qty) || 0,
    status,
  };
}

function fallbackTokens() {
  const raw = process.env.RALLY_COMP_TOKEN_FALLBACK || "";
  return new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean));
}

async function validate(token) {
  const upper = String(token || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(upper)) return { valid: false, error: "That claim link doesn't look right." };
  try {
    const record = await findTokenRecord(upper);
    if (!record) return { valid: false, error: "This claim link isn't recognised." };
    const t = tokenSummary(record);
    const remaining = Math.max(0, t.max_qty - t.used_qty);
    if (t.status !== "active" && t.status !== "Active") {
      return { valid: false, error: "This claim link has already been used." };
    }
    if (remaining <= 0) {
      return { valid: false, error: "All the tickets on this claim link have been taken." };
    }
    return { valid: true, max_qty: t.max_qty, used_qty: t.used_qty, recordId: record.id };
  } catch (e) {
    if (e.code === "NO_TABLE") {
      // Fallback path for preview / unconfigured environments — accept
      // env-listed tokens with a default max_qty of 2 so the flow can be
      // demoed without a full Airtable setup.
      if (fallbackTokens().has(upper)) {
        return { valid: true, max_qty: 2, used_qty: 0, recordId: null, fallback: true };
      }
      console.error(`Rally comp token table "${TOKENS_TABLE}" not configured.`);
      return { valid: false, error: "Comp tickets aren't set up yet." };
    }
    console.error("rally-claim validate error:", e.message);
    return { valid: false, error: "Couldn't check this link right now — try again in a moment." };
  }
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
      const token = url.searchParams.get("token");
      if (!token) return res.status(400).json({ valid: false, error: "Missing token" });
      const v = await validate(token);
      return res.status(v.valid ? 200 : 400).json(v);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

    const body = req.body || {};
    const token = String(body.token || "").trim().toUpperCase();
    const requestedQty = Math.max(1, Math.min(20, Number(body.qty) || 1));
    const first_name = String(body.first_name || "").trim();
    const last_name = String(body.last_name || "").trim();
    const email = String(body.email || "").trim();
    const phone = String(body.phone || "").trim();
    const postcode = String(body.postcode || "").trim();
    const ref = String(body.ref || "").trim().toUpperCase();

    if (!first_name || !last_name || !email || !phone) {
      return res.status(400).json({ error: "Please fill in your name, email, and phone." });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    const v = await validate(token);
    if (!v.valid) return res.status(400).json({ error: v.error });
    const remaining = Math.max(0, v.max_qty - v.used_qty);
    if (requestedQty > remaining) {
      return res.status(400).json({ error: `Only ${remaining} ticket${remaining === 1 ? "" : "s"} left on this claim link.` });
    }

    // Match or create the contact (existing pipeline handles identity ladder
    // + backfill).
    const { record: contactRec } = await matchOrCreateContact({
      first_name, last_name, email, mobile: phone, postcode,
      source_channel: "Rally Comp Ticket",
    });
    const referral_code = await setReferralCodeIfMissing(contactRec.id, contactRec.fields);

    // Log the Comped event. Unknown event_type just lands in Events with
    // "No Typed Table" — payload preserved for later projection.
    const order_ref = "FFR-" + Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.floor(100 + Math.random() * 899);
    try {
      await logEvent({
        contactRecordId: contactRec.id,
        event_type: "Rally Ticket Comped",
        payload: {
          source: "rally_comp_claim",
          token,
          qty: requestedQty,
          order_ref,
          contact: { first_name, last_name, email, phone, postcode },
          ref: ref || null,
          fallback: v.fallback === true,
        },
        referral_code_used: ref || undefined,
        source_channel: "Rally Comp Ticket",
      });
    } catch (e) {
      console.error("rally-claim logEvent failed:", e.message);
    }

    // Decrement allowance on the token record (skip in fallback mode since
    // there's no record to update).
    if (v.recordId) {
      try {
        const newUsed = v.used_qty + requestedQty;
        const patch = { used_qty: newUsed };
        if (newUsed >= v.max_qty) patch.status = "redeemed";
        // Also stamp the redeeming contact if the schema supports it.
        patch.contact = [contactRec.id];
        await atFetch(`${encodeURIComponent(TOKENS_TABLE)}/${v.recordId}`, {
          method: "PATCH",
          body: JSON.stringify({ fields: patch, typecast: true }),
        });
      } catch (e) {
        console.error("rally-claim decrement failed:", e.message);
        // Non-fatal — the log-and-decrement race is small at this scale.
      }
    }

    try {
      await updateContactStatusFromEvent(contactRec.id, "Rally Ticket Comped", contactRec.fields.status);
    } catch (e) {
      console.error("rally-claim status update failed:", e.message);
    }

    return res.status(200).json({
      ok: true,
      order_ref,
      referral_code,
    });
  } catch (err) {
    if (err.code === "MISCONFIGURED") {
      console.error(err.message);
      return res.status(500).json({ error: "Server misconfigured" });
    }
    console.error("rally-claim handler error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
