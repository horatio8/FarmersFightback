// Vercel serverless function: proxies a YouTube channel's public RSS feed
// and returns a normalised JSON list of recent videos. No API key required.
//
// GET /api/youtube?channelId=UC...
//
// Response:
//   { channelId, title, items: [{ videoId, title, link, published, thumbnail, description }] }

const ALLOWED_ID = /^UC[A-Za-z0-9_-]{22}$/;

function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function pickAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=\"([^\"]*)\"[^>]*\\/?>`));
  return m ? m[1] : "";
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseFeed(xml) {
  const channelTitle = decode(pick(xml, "title"));
  const entries = xml.split(/<entry>/).slice(1).map(chunk => "<entry>" + chunk.split(/<\/entry>/)[0] + "</entry>");
  const items = entries.map(e => {
    const videoId = pick(e, "yt:videoId");
    const title = decode(pick(e, "title"));
    const linkHref = pickAttr(e, "link", "href");
    const published = pick(e, "published");
    const thumbnail = pickAttr(e, "media:thumbnail", "url");
    const description = decode(pick(e, "media:description"));
    return { videoId, title, link: linkHref, published, thumbnail, description };
  });
  return { title: channelTitle, items };
}

module.exports = async (req, res) => {
  const channelId = (req.query && req.query.channelId) || "";
  if (!ALLOWED_ID.test(channelId)) {
    res.status(400).json({ error: "Invalid channelId. Expecting a YouTube channel ID like UCxxxxxxxxxxxxxxxxxxxxx." });
    return;
  }
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const r = await fetch(feedUrl, { headers: { "User-Agent": "FarmersFightback/1.0 (+https://farmersfightback.com)" } });
    if (!r.ok) {
      res.status(502).json({ error: `Upstream YouTube feed returned ${r.status}` });
      return;
    }
    const xml = await r.text();
    const { title, items } = parseFeed(xml);
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ channelId, title, items });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
