// Read the /wa1 vs /wa2 A/B result.
//
//   https://farmersfightback.com/api/admin/wa-clicks?token=ADMIN_TOKEN
//   ...&json=1     raw numbers instead of the table
//   ...&days=7     only the last N days (default: all)
//
// Open it in a browser and it prints the scoreboard. That is the point: a
// test nobody can check easily is a test nobody checks.
//
// Counts Events rows written by /api/wa-redirect. Preview fetchers were never
// logged in the first place, so these are taps by people.

// listRows, not listPage: the Events log was split across two bases on
// 18 Aug 2026 and listRows sweeps both, so the scoreboard keeps the taps that
// landed before the move.
const { listRows } = require("../_airtable");
const { requireBasicAuth } = require("../_util");

const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";
const EVENT_TYPE = "WhatsApp Click";

const LABELS = {
  A: "/wa1 — warm / gratitude-led",
  B: "/wa2 — urgency / stakes-led",
};

function authed(req, res) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || "";
  const tokenOk = Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
  const cronOk = Boolean(process.env.CRON_SECRET)
    && (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET}`;
  if (tokenOk || cronOk) return true;
  return requireBasicAuth(req, res);
}

function parsePayload(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (!authed(req, res)) return;

  const url = new URL(req.url, "https://x");
  const days = Number(url.searchParams.get("days")) || 0;
  const wantJson = url.searchParams.get("json") === "1";

  // ?after=<ISO> pins the start of the test, so pre-launch verification
  // clicks are excluded for good rather than subtracted by hand every time.
  const after = (url.searchParams.get("after") || "").trim();

  let formula = `{event_type}='${EVENT_TYPE}'`;
  if (after && !Number.isNaN(new Date(after).getTime())) {
    formula = `AND(${formula},IS_AFTER({timestamp},'${new Date(after).toISOString()}'))`;
  } else if (days > 0) {
    formula = `AND(${formula},IS_AFTER({timestamp},DATEADD(TODAY(),-${days},'days')))`;
  }

  const totals = { A: 0, B: 0 };
  const byDay = {};
  const byUA = {};
  let scanned = 0;

  try {
    const rows = await listRows(EVENTS, { formula, fields: ["payload", "timestamp"] });
    for (const rec of rows) {
      const f = rec.fields || {};
      const p = parsePayload(f.payload);
      const v = p.variant === "B" ? "B" : "A";
      totals[v] += 1;
      scanned += 1;
      const day = String(f.timestamp || "").slice(0, 10);
      if (day) {
        byDay[day] = byDay[day] || { A: 0, B: 0 };
        byDay[day][v] += 1;
      }
      const ua = p.ua || "unknown";
      byUA[ua] = byUA[ua] || { A: 0, B: 0 };
      byUA[ua][v] += 1;
    }
  } catch (e) {
    console.error("wa-clicks:", e.message);
    return res.status(500).json({ error: "count failed", detail: e.message.slice(0, 200) });
  }

  const total = totals.A + totals.B;
  const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");
  // Which is ahead, and by how much in relative terms — the number worth
  // acting on. With a small sample this is noise, so say so rather than
  // letting a 3-click lead read as a winner.
  const leader = totals.A === totals.B ? null : (totals.A > totals.B ? "A" : "B");
  const lift = leader && Math.min(totals.A, totals.B) > 0
    ? `${((Math.max(totals.A, totals.B) / Math.min(totals.A, totals.B) - 1) * 100).toFixed(0)}%`
    : null;
  const confident = total >= 100 && leader
    && Math.abs(totals.A - totals.B) >= Math.sqrt(total) * 2;

  const result = {
    total_clicks: total,
    variants: {
      A: { label: LABELS.A, clicks: totals.A, share: pct(totals.A) },
      B: { label: LABELS.B, clicks: totals.B, share: pct(totals.B) },
    },
    leader,
    lift,
    verdict: !leader ? "dead level"
      : confident ? `${leader} is ahead by ${lift} — enough clicks to act on`
        : `${leader} is ahead by ${lift || "a little"}, but this is still inside the noise`,
    by_day: Object.fromEntries(Object.entries(byDay).sort()),
    by_device: byUA,
    window: after ? `since ${after}` : days > 0 ? `last ${days} days` : "all time",
  };

  if (wantJson) return res.status(200).json({ ok: true, ...result });

  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dayRows = Object.entries(result.by_day).reverse().map(([d, c]) =>
    `<tr><td>${esc(d)}</td><td>${c.A}</td><td>${c.B}</td></tr>`).join("");
  const uaRows = Object.entries(byUA).sort((a, b) => (b[1].A + b[1].B) - (a[1].A + a[1].B))
    .map(([u, c]) => `<tr><td>${esc(u)}</td><td>${c.A}</td><td>${c.B}</td></tr>`).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>WhatsApp invite A/B</title>
<style>
 body{font:15px/1.6 system-ui,-apple-system,sans-serif;margin:24px;color:#12354B;max-width:760px}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#667;margin:0 0 22px;font-size:13px}
 .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px}
 .card{flex:1;min-width:220px;border:1px solid #dde;border-radius:8px;padding:16px}
 .card.win{border-color:#12354B;background:#f6f9fb}
 .n{font-size:34px;font-weight:700;line-height:1.1}
 .lbl{font-size:12px;color:#667;text-transform:uppercase;letter-spacing:.08em}
 .verdict{padding:12px 14px;background:#f4f4f2;border-radius:8px;margin:18px 0}
 table{border-collapse:collapse;width:100%;margin:10px 0 26px}
 th,td{border:1px solid #e3e3e8;padding:6px 10px;text-align:right}
 td:first-child,th:first-child{text-align:left}
 th{background:#12354B;color:#fff;font-weight:600}
 h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#667;margin:24px 0 0}
</style>
<h1>WhatsApp invite — A/B</h1>
<p class="sub">Taps on /wa1 and /wa2. Link-preview fetches are excluded. ${esc(result.window)}.</p>
<div class="cards">
  <div class="card${leader === "A" ? " win" : ""}"><div class="lbl">A · /wa1 · warm</div><div class="n">${totals.A}</div><div>${pct(totals.A)}</div></div>
  <div class="card${leader === "B" ? " win" : ""}"><div class="lbl">B · /wa2 · urgency</div><div class="n">${totals.B}</div><div>${pct(totals.B)}</div></div>
  <div class="card"><div class="lbl">Total</div><div class="n">${total}</div><div>${esc(scanned)} rows</div></div>
</div>
<div class="verdict"><strong>${esc(result.verdict)}</strong></div>
<h2>By day</h2>
<table><tr><th>Day</th><th>A /wa1</th><th>B /wa2</th></tr>${dayRows || '<tr><td colspan="3">no clicks yet</td></tr>'}</table>
<h2>By device</h2>
<table><tr><th>Platform / app</th><th>A /wa1</th><th>B /wa2</th></tr>${uaRows || '<tr><td colspan="3">no clicks yet</td></tr>'}</table>
<p class="sub">Raw numbers: add <code>&amp;json=1</code>. Narrow the window: <code>&amp;days=7</code>.</p>`);
};
