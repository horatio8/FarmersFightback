// GET /api/releases[?type=Media%20release|News][&limit=20]
// Published rows from the Media Releases table, newest first. Edge-cached
// five minutes, so a row ticked "published" in Airtable is live within that.

const A = require("../lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const q = req.query || {};
  const limit = Math.min(Number(q.limit) || 20, 100);
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  if (!A.configured()) return res.status(200).json({ live: false, items: [] });
  try {
    const type = q.type ? `, {type}='${String(q.type).replace(/'/g, "")}'` : "";
    const rows = await A.listAll("Media Releases", { filterByFormula: `AND({published}=1${type})`, "sort[0][field]": "date", "sort[0][direction]": "desc" });
    const items = rows.slice(0, limit).map((r) => ({
      slug: r.slug || String(r.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      title: r.title, date: r.date, type: r.type || "Media release", summary: r.summary || "", body: r.body || "",
      attachments: (r.attachments || []).map((a) => ({ url: a.url, name: a.filename, type: a.type })),
      jurisdiction: r.jurisdiction || null,
    }));
    return res.status(200).json({ live: true, items });
  } catch (err) {
    console.error("releases error:", err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ live: false, items: [], error: "unavailable" });
  }
};
