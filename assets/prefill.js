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
    // Short param names keep these links inside the length that email
    // clients and SMS gateways will render without wrapping.
    var map = { fn: "first", ln: "last", em: "email", mb: "mobile", pc: "postcode", uid: "uid" };
    var out = {};
    var found = false;
    Object.keys(map).forEach(function (k) {
      var v = q.get(k);
      if (v == null) return;
      v = String(v).trim();
      // An unresolved merge tag ("%recipient.first_name%") means CN had no
      // value for that field. Treat it as absent rather than typing a literal
      // percent-string into someone's name box.
      if (!v || v.indexOf("%recipient.") === 0 || v.charAt(0) === "%") return;
      if (v.length > 200) return;
      out[map[k]] = v;
      found = true;
      q.delete(k);
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
