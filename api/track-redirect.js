// Click-tracked short links for SMS: farmersfightback.com/fund and /fight
// rewrite here (see vercel.json). Logs the click as an Events row — OUR
// click count, not Cellcast's — then 302s into the donate flow with the
// variant's UTM set. ?c=<referral_code> attributes the click to a contact.
//
//   /fund  → utm_content=ben   (variant A)
//   /fight → utm_content=issue (variant B)

const { logEvent, findContactByReferralCode } = require("./_airtable");
const { hostBase } = require("./_util");

const LINKS = {
  fund: { utm_content: "ben" },
  fight: { utm_content: "issue" },
};

// Messaging apps and social networks fetch the link to render a preview card
// BEFORE the human ever taps it — iMessage, WhatsApp, Messenger, Slack, etc.
// Those prefetches must still get the 302 (so the card renders), but they are
// not clicks and would roughly double the count. Skip logging when the UA
// looks like a bot/preview fetcher.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|telegrambot|discord|slack|linkedin|twitter|pinterest|embedly|quora|outbrain|vkshare|redditbot|applebot|googlebot|bingbot|yandex|baidu|duckduck|semrush|ahrefs|skypeuripreview|google-inspectiontool|googlemessages|googleother|metainspector|okhttp|python-requests|curl|wget|headlesschrome/i;

module.exports = async function handler(req, res) {
  const url = new URL(req.url, hostBase(req));
  const link = url.searchParams.get("l");
  const c = (url.searchParams.get("c") || "").toUpperCase().slice(0, 20);
  const cfg = LINKS[link] || LINKS.fund;
  const ua = req.headers["user-agent"] || "";

  const dest = new URL(`${hostBase(req)}/donate`);
  dest.searchParams.set("utm_source", "sms");
  dest.searchParams.set("utm_medium", "auto");
  dest.searchParams.set("utm_content", cfg.utm_content);
  if (c) dest.searchParams.set("c", c);

  // Log before redirecting (no waitUntil available in plain functions —
  // two quick Airtable calls, worth the ~300ms for accurate click counts).
  // Link-preview bots get the redirect but are never counted as clicks.
  if (!BOT_UA.test(ua)) {
    try {
      let contactRecordId;
      if (c) {
        const contact = await findContactByReferralCode(c).catch(() => null);
        if (contact) contactRecordId = contact.id;
      }
      await logEvent({
        contactRecordId,
        event_type: "SMS Click",
        payload: {
          link,
          utm_content: cfg.utm_content,
          c: c || null,
          ua,
        },
        source_channel: "Other",
        fanout: false,
      });
    } catch (e) {
      console.error("track-redirect log failed:", e.message);
    }
  }

  res.setHeader("Location", dest.toString());
  res.setHeader("Cache-Control", "no-store");
  return res.status(302).end();
};
