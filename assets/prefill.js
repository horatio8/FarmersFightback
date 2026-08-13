/* Tokenised email links: capture the recipient's details, then scrub them.
 *
 * A Campaign Nucleus send builds the link with merge tags, e.g.
 *   /demand?fn=%recipient.first_name%&ln=%recipient.last_name%
 *          &em=%recipient.email%&mb=%recipient.phone%&uid=%recipient.FarmersFightback_UID%
 * so the action page arrives already filled in and the supporter only has to
 * write and send.
 *
 * Why the details ride in the link rather than behind a lookup: the obvious
 * design is ?uid=CODE plus an endpoint that returns the contact. But
 * referral codes are published — every share link is /page?ref=CODE, posted
 * to Facebook — so such an endpoint would hand anyone who has seen a shared
 * link that supporter's email address and mobile number. There is no version
 * of that which is safe, so the data travels in the recipient's own link.
 *
 * This file MUST load before Clarity, the Meta Pixel or anything else that
 * reads location.href, because those would otherwise ship a URL containing a
 * real name, email and mobile to a third party. It runs synchronously, copies
 * the values into sessionStorage and rewrites the address bar in the same
 * tick, so by the time any tag initialises the query string is gone. That
 * also keeps the details out of browser history and out of any link the
 * supporter copies and pastes to a friend.
 */
(function () {
  var KEY = "ff_prefill";
  try {
    var q = new URLSearchParams(window.location.search);
    // Several params can feed one field, because Campaign Nucleus's recipient
    // variables don't follow the profile's own field names — its live sends
    // use %recipient.first%, not %recipient.first_name% — and the names for
    // last/email/mobile aren't in any campaign we've sent, so they can't be
    // read off history. Rather than guess (or send a test blast to find out),
    // the link carries every plausible tag for each field and the first one
    // that actually resolved wins. Unresolved tags arrive as the literal
    // "%recipient.x%" and are discarded below, so the wrong guesses cost
    // nothing but URL length.
    var map = {
      first: ["fn", "fn2"],
      last: ["ln", "ln2"],
      email: ["em", "em2"],
      mobile: ["mb", "mb2", "mb3"],
      postcode: ["pc", "pc2"],
      uid: ["uid"],
    };
    var out = {};
    var found = false;
    Object.keys(map).forEach(function (field) {
      map[field].forEach(function (k) {
        var v = q.get(k);
        q.delete(k);
        if (out[field] || v == null) return; // first resolved variant wins
        v = String(v).trim();
        // An unresolved merge tag means CN had no value under that name.
        // Treat it as absent rather than typing a percent-string into
        // someone's name box.
        if (!v || v.charAt(0) === "%" || v.indexOf("%recipient") !== -1) return;
        if (v.length > 200) return;
        out[field] = v;
        found = true;
      });
    });
    if (!found) return;
    try { sessionStorage.setItem(KEY, JSON.stringify(out)); } catch (e) {}
    // Rewrite before anything else can read the URL. Keep every other param
    // (utm_*, ref, hash) so attribution and #anchor jumps still work.
    var rest = q.toString();
    var clean = window.location.pathname + (rest ? "?" + rest : "") + window.location.hash;
    try { window.history.replaceState({}, "", clean); } catch (e) {}
  } catch (e) {}
})();
