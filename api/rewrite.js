// AI rewrite for the Email the Liberal Party page.
//
// POST /api/rewrite  { session_id, subject, body, first_name }
//   → { subject, body }   (rewritten in the supporter's voice)
//   → 429 { error, reason: "session_limit"|"ip_limit"|"daily_cap" }
//
// Server-side Anthropic call only — ANTHROPIC_API_KEY never reaches the
// client. Limits: 3 rewrites / session (Signups.ai_rewrite_count), 20 / IP /
// hour (per-instance in-memory), and a hard daily cap across all users
// (AI_REWRITE_DAILY_CAP, enforced by counting today's `AI Usage` rows).
//
// Every model attempt (success or failure) logs an `AI Usage` row with token
// counts, estimated cost (Haiku pricing) and a salted SHA-256 IP hash — never
// the raw IP. On success it increments ai_rewrite_count and sets
// ai_rewrite_used on the session's Signups row.
//
// Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-haiku-4-5-20251001),
// AI_REWRITE_DAILY_CAP (default 500), IP_HASH_SALT, plus AIRTABLE_* (_airtable).

const crypto = require("crypto");
const { findOne, updateRow, createRow, listRows, nowIso } = require("./_airtable");

const SIGNUPS_TABLE = process.env.AIRTABLE_SIGNUPS_TABLE || "Signups";
const USAGE_TABLE = process.env.AIRTABLE_AI_USAGE_TABLE || "AI Usage";

const SESSION_LIMIT = 3;
const IP_HOURLY_LIMIT = 20;
const IP_WINDOW_MS = 60 * 60 * 1000;

// Haiku pricing: $1 / M input tokens, $5 / M output tokens.
const COST_IN_PER_TOKEN = 1 / 1_000_000;
const COST_OUT_PER_TOKEN = 5 / 1_000_000;

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

function esc(s) { return String(s).replace(/'/g, "\\'"); }

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || "";
  return crypto.createHash("sha256").update(salt + ip).digest("hex");
}

// Per-instance in-memory IP hourly counter (keyed on hashed IP).
const ipHits = new Map();
function ipLimited(ipHash) {
  const now = Date.now();
  const arr = (ipHits.get(ipHash) || []).filter((t) => now - t < IP_WINDOW_MS);
  ipHits.set(ipHash, arr);
  return arr.length >= IP_HOURLY_LIMIT;
}
function ipRecord(ipHash) {
  const arr = ipHits.get(ipHash) || [];
  arr.push(Date.now());
  ipHits.set(ipHash, arr);
}

const SYSTEM_PROMPT = [
  "You rewrite a supporter's advocacy email to the Australian Liberal Party.",
  "Rules you must follow exactly:",
  "- Rewrite the given subject and body in the supporter's own casual-but-respectful voice.",
  "- Keep every factual claim unchanged. Do not add new claims, statistics, or figures.",
  "- Keep the email addressed to Liberal Party leadership.",
  "- Tone must remain respectful throughout, consistent with a campaign that treats these recipients as people who can do good.",
  "- NEVER speak positively or approvingly of renewables, renewable energy, wind or solar projects, transmission projects, or the 'energy transition'. Do not add lines that endorse, welcome, or accept new energy infrastructure (no 'we support renewables', 'we're not against new energy', 'the transition done well', or anything similar). The campaign's position is that these projects take prime farmland and must be scrapped; stay strictly within that framing. 'Western Renewables Link' may appear only as the project's proper name.",
  "- The body must stay under 1400 characters.",
  '- Return strictly JSON: {"subject": "...", "body": "..."} with no extra commentary and no markdown fences.',
].join("\n");

// Strip markdown fences and pull the first JSON object out of the model text.
function parseModelJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}

function utcDayStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

async function logUsage({ session_id, model, input_tokens, output_tokens, ip_hash }) {
  const estimated_cost_usd =
    (input_tokens || 0) * COST_IN_PER_TOKEN + (output_tokens || 0) * COST_OUT_PER_TOKEN;
  try {
    await createRow(USAGE_TABLE, {
      timestamp: nowIso(),
      session_id: session_id || "",
      model: model || "",
      input_tokens: input_tokens || 0,
      output_tokens: output_tokens || 0,
      estimated_cost_usd: Number(estimated_cost_usd.toFixed(6)),
      ip_hash: ip_hash || "",
    });
  } catch (e) {
    console.error("rewrite usage log failed:", e.message);
  }
}

module.exports = async function handler(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const dailyCap = Number(process.env.AI_REWRITE_DAILY_CAP || 500);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const session_id = String(body.session_id || "").trim().slice(0, 80);
  const subject = String(body.subject || "").slice(0, 4000);
  const bodyText = String(body.body || "").slice(0, 8000);
  const first_name = String(body.first_name || "").trim().slice(0, 80);
  if (!session_id || (!subject && !bodyText)) {
    return res.status(400).json({ error: "session_id, subject and body required" });
  }

  const ip = clientIp(req);
  const ip_hash = hashIp(ip);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Rewrite isn't configured yet." });
  }

  // 1) Per-IP hourly limit (in-memory, cheapest check).
  if (ipLimited(ip_hash)) {
    return res.status(429).json({ error: "Rewrite limit reached for now.", reason: "ip_limit" });
  }

  // 2) Per-session limit via ai_rewrite_count on the Signups row.
  let signupRow = null;
  try {
    signupRow = await findOne(SIGNUPS_TABLE, `{session_id}='${esc(session_id)}'`);
  } catch (e) {
    console.error("rewrite signup lookup failed:", e.message);
  }
  const usedCount = Number((signupRow && signupRow.fields && signupRow.fields.ai_rewrite_count) || 0);
  if (usedCount >= SESSION_LIMIT) {
    return res.status(429).json({ error: "That's the limit of rewrites for now.", reason: "session_limit" });
  }

  // 3) Hard daily cap: count today's AI Usage rows (UTC day).
  try {
    const todays = await listRows(USAGE_TABLE, {
      formula: `IS_AFTER({timestamp}, '${utcDayStartIso()}')`,
      fields: ["timestamp"],
    });
    if (todays.length >= dailyCap) {
      return res.status(429).json({ error: "The rewrite tool is having a breather.", reason: "daily_cap" });
    }
  } catch (e) {
    console.error("rewrite daily cap check failed:", e.message);
  }

  // Count this IP attempt now that pre-flight limits have passed.
  ipRecord(ip_hash);

  const userContent =
    `Supporter first name: ${first_name || "(not provided)"}\n\n` +
    `Current subject:\n${subject}\n\n` +
    `Current body:\n${bodyText}`;

  // Header values must be Latin-1; a key pasted through a smart-punctuation
  // editor (em-dashes, curly quotes, stray whitespace) crashes fetch with a
  // cryptic ByteString error. Trim it and fail loudly if it's still not
  // plain printable ASCII so misconfiguration is diagnosable from the logs.
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    const bad = [...apiKey].findIndex((c) => c < "\x21" || c > "\x7E");
    console.error(`rewrite: ANTHROPIC_API_KEY contains a non-ASCII character at index ${bad} (code ${apiKey.codePointAt(bad)}) — re-paste the key into Vercel from a plain-text source`);
    return res.status(500).json({ error: "Rewrite isn't configured correctly.", reason: "api_key_invalid" });
  }

  let input_tokens = 0;
  let output_tokens = 0;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (data && data.usage) {
      input_tokens = data.usage.input_tokens || 0;
      output_tokens = data.usage.output_tokens || 0;
    }

    if (!r.ok) {
      console.error("rewrite anthropic error:", r.status, JSON.stringify(data).slice(0, 300));
      await logUsage({ session_id, model, input_tokens, output_tokens, ip_hash });
      return res.status(502).json({ error: "Rewrite couldn't complete. Please try again." });
    }

    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";
    const parsed = parseModelJson(text);

    // Log usage regardless of parse outcome.
    await logUsage({ session_id, model, input_tokens, output_tokens, ip_hash });

    if (!parsed || typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
      return res.status(502).json({ error: "Rewrite couldn't complete. Please try again." });
    }

    // Success bookkeeping on the Signups row (best-effort).
    if (signupRow) {
      try {
        await updateRow(SIGNUPS_TABLE, signupRow.id, {
          ai_rewrite_count: usedCount + 1,
          ai_rewrite_used: true,
          updated_at: nowIso(),
        });
      } catch (e) {
        console.error("rewrite signup update failed:", e.message);
      }
    }

    return res.status(200).json({ subject: parsed.subject, body: parsed.body });
  } catch (e) {
    console.error("rewrite failed:", e.message);
    await logUsage({ session_id, model, input_tokens, output_tokens, ip_hash });
    return res.status(502).json({ error: "Rewrite couldn't complete. Please try again." });
  }
};
