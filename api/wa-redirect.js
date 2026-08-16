// Click-tracked short links for the WhatsApp channel invite.
//
//   farmersfightback.com/wa1  → variant A (warm / gratitude-led copy)
//   farmersfightback.com/wa2  → variant B (urgency / stakes-led copy)
//
// Both land on the same WhatsApp channel. The auto-replies that carry these
// links are being A/B tested, and WhatsApp channel followers are anonymous, so
// a join cannot be attributed back to a message variant. Our own domain is the
// only place the click can be counted — hence two paths instead of one.
//
// vercel.json rewrites /wa1 and /wa2 onto this function. The public links stay
// clean: the variant arrives as an internal query param the supporter never
// sees, types, or can mangle.
//
// A plain vercel.json redirect would NOT be counted: it resolves at the edge
// before any page exists, so there is nothing to run analytics on. It would
// look like success and produce an empty dashboard. That is the whole reason
// this is a function.
//
// 307, deliberately, and no-store with it. A 301/308 is cached hard by
// browsers and by the in-app webviews inside Messenger and Instagram, so
// repeat clicks would stop reaching this function and the count would silently
// under-report. 307 keeps every click observable.
//
// Privacy: variant, timestamp, referrer and a COARSE user agent — platform and
// app family only. No IP, no full UA string, no fingerprinting. These are
// supporters, not traffic.

const { logEvent } = require("./_airtable");

const CHANNEL = "https://whatsapp.com/channel/0029VbDYIQW3gvWSlsf4ln16";
const EVENT_TYPE = "WhatsApp Click";

const VARIANTS = {
  wa1: "A",
  wa2: "B",
};

// Messaging apps fetch a link to build its preview card before any human taps
// it — and these links are going into Messenger and Instagram DMs, where that
// happens on every single send. Preview fetchers must still get the redirect
// so the card renders, but counting them would inflate the result by roughly
// the number of messages sent rather than the number of people who clicked,
// which would make the A/B test meaningless.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|discord|slack|linkedin|twitter|pinterest|embedly|quora|redditbot|applebot|googlebot|bingbot|yandex|baidu|duckduck|semrush|ahrefs|skypeuripreview|google-inspectiontool|googleother|metainspector|okhttp|python-requests|curl|wget|headlesschrome/i;

// Deliberately lossy. Enough to know "iPhone, opened from inside Instagram"
// without keeping a string that identifies a device.
function coarseUA(ua) {
  const s = String(ua || "");
  const platform = /iPhone|iPad|iOS/i.test(s) ? "iOS"
    : /Android/i.test(s) ? "Android"
      : /Windows|Macintosh|X11|Linux/i.test(s) ? "desktop"
        : "other";
  // Meta's in-app browsers identify themselves in the UA: Instagram by name,
  // Messenger and the Facebook app by their FBAN/FBAV build tokens.
  const app = /Instagram/i.test(s) ? "instagram"
    : /FBAN|FBAV|FB_IAB|Messenger/i.test(s) ? "facebook"
      : "browser";
  return `${platform}/${app}`;
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  const key = String(url.searchParams.get("v") || "").toLowerCase();
  const variant = VARIANTS[key] || VARIANTS.wa1;
  const ua = req.headers["user-agent"] || "";

  // Record before redirecting, and never let storage failure block the
  // redirect. A supporter who cannot reach the channel is a worse outcome
  // than a missing analytics row.
  if (!BOT_UA.test(ua)) {
    try {
      await logEvent({
        event_type: EVENT_TYPE,
        source_channel: "Other",
        payload: {
          variant,
          path: key || "wa1",
          ua: coarseUA(ua),
          referrer: String(req.headers.referer || req.headers.referrer || "").slice(0, 200),
        },
        // No typed projection table for these, and flagging every row as
        // "No Typed Table" would blunt a signal that means something else.
        fanout: false,
      });
    } catch (e) {
      console.error("wa-redirect log failed:", e.message);
    }
  }

  res.setHeader("Location", CHANNEL);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.status(307).end();
};
