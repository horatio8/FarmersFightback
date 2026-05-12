// Vercel serverless function: returns a normalised list of recent videos for a
// YouTube channel. Tries the public RSS feed first (fast and structured) and
// falls back to scraping the channel /videos and /shorts tabs when YouTube's
// RSS endpoint 404s for the channel (it does that intermittently for some
// channels). For scraped IDs, titles are pulled via the public oEmbed
// endpoint, batched. No API key required.
//
// GET /api/youtube?channelId=UC...
//
// Response: { channelId, title, items: [{ videoId, title, link, thumbnail }] }

const ALLOWED_ID = /^UC[A-Za-z0-9_-]{22}$/;
const UA = "Mozilla/5.0 (compatible; FarmersFightbackBot/1.0; +https://farmersfightback.com)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function decode(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}
function pickAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=\"([^\"]*)\"[^>]*\\/?>`));
  return m ? m[1] : "";
}

async function tryRss(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const xml = await r.text();
  const channelTitle = decode(pick(xml, "title"));
  const entries = xml.split(/<entry>/).slice(1).map(c => "<entry>" + c.split(/<\/entry>/)[0] + "</entry>");
  if (!entries.length) return null;
  const items = entries.map(e => ({
    videoId: pick(e, "yt:videoId"),
    title: decode(pick(e, "title")),
    link: pickAttr(e, "link", "href"),
    published: pick(e, "published"),
    thumbnail: pickAttr(e, "media:thumbnail", "url"),
  })).filter(it => it.videoId);
  return { title: channelTitle, items };
}

async function fetchTabIds(channelId, tab) {
  const url = `https://www.youtube.com/channel/${channelId}${tab}`;
  const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-AU,en" } });
  if (!r.ok) return [];
  const html = await r.text();
  const all = Array.from(html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)).map(m => m[1]);
  const seen = new Set();
  return all.filter(id => (seen.has(id) ? false : seen.add(id) && true));
}

async function oembed(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function tryScrape(channelId) {
  // Combine /videos (long-form) and /shorts to get the broadest set, deduped.
  const [longs, shorts] = await Promise.all([fetchTabIds(channelId, "/videos"), fetchTabIds(channelId, "/shorts")]);
  const seen = new Set();
  const merged = [];
  for (const id of [...longs, ...shorts]) {
    if (!seen.has(id)) { seen.add(id); merged.push(id); }
  }
  const top = merged.slice(0, 12); // grab a few extra; consumers can slice(0, 9)
  // Pull titles in parallel via oEmbed
  const settled = await Promise.all(top.map(id => oembed(id)));
  const items = top.map((id, i) => ({
    videoId: id,
    title: (settled[i] && settled[i].title) || "Latest video",
    link: `https://www.youtube.com/watch?v=${id}`,
    published: "",
    thumbnail: (settled[i] && settled[i].thumbnail_url) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  }));
  const channelTitle = (settled.find(x => x && x.author_name) || {}).author_name || "";
  return { title: channelTitle, items };
}

module.exports = async (req, res) => {
  const channelId = (req.query && req.query.channelId) || "";
  if (!ALLOWED_ID.test(channelId)) {
    res.status(400).json({ error: "Invalid channelId. Expecting a YouTube channel ID like UC..." });
    return;
  }
  try {
    let result = await tryRss(channelId);
    if (!result || !result.items || !result.items.length) {
      result = await tryScrape(channelId);
    }
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ channelId, ...result });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
