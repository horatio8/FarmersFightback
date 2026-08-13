/* Tokenised email links: fetch the recipient's details from Campaign Nucleus.
 *
 * A CN send builds the link with an opaque profile id, e.g.
 *   /demand?p=%recipient.id%&p2=%recipient.uuid%&…
 * and this script trades that id for the person's details through our own
 * server, so the action page arrives filled in.
 *
 * Two rules shape the design:
 *
 *   No personal data in the URL. Names, emails and mobiles in a query string
 *   end up in browser history, in anything the supporter copies and pastes,
 *   and in the hands of every tag on the page that reads location.href — this
 *   one runs Clarity and the Meta Pixel. Only an opaque id travels.
 *
 *   The id must be unguessable. It is a CN profile UUID: 122 bits, published
 *   nowhere. The referral code is deliberately not used, because those ARE
 *   published — every share link is /page?ref=CODE, posted to Facebook — so
 *   keying a lookup on one would expose that supporter's email and mobile to
 *   anyone who had seen it.
 *
 * Details come from CN, not Airtable: Airtable does not hold a complete
 * record of everyone CN mails.
 *
 * Load this BEFORE any analytics tag. It strips the id from the address bar
 * synchronously, and starts the lookup before React has even parsed, so the
 * fields are usually populated by first paint.
 */
(function () {
  var KEY = "ff_prefill";
  var EVT = "ff-prefill-ready";
  // Several names for one thing: CN's recipient variables don't follow its
  // profile field names (live sends use %recipient.first%, not
  // %recipient.first_name%), no campaign this account has sent contains an id
  // tag, and CN's API publishes neither the tag list nor a way to render one.
  // So the link carries every plausible name; unresolved ones arrive as the
  // literal "%recipient.x%" and are ignored server-side.
  var ID_PARAMS = ["p", "p2", "p3", "p4", "p5", "p6"];

  function publish(data) {
    try { sessionStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent(EVT, { detail: data })); } catch (e) {}
  }

  try {
    var q = new URLSearchParams(window.location.search);
    var send = [];
    ID_PARAMS.forEach(function (k) {
      var v = q.get(k);
      q.delete(k);
      if (v == null) return;
      v = String(v).trim();
      if (!v || v.charAt(0) === "%" || v.indexOf("%recipient") !== -1) return;
      if (v.length > 64) return;
      send.push(k + "=" + encodeURIComponent(v));
    });

    // Scrub first, ask questions after: the id leaves the address bar before
    // any tag can read it, and before the supporter can copy the link.
    // Everything else (utm_*, ref, the #anchor) is preserved.
    if (send.length) {
      var rest = q.toString();
      var clean = window.location.pathname + (rest ? "?" + rest : "") + window.location.hash;
      try { window.history.replaceState({}, "", clean); } catch (e) {}
    }

    // A prefill already in this tab's storage (they reloaded, or wandered off
    // and came back) is reused rather than re-fetched.
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) {}
    if (!send.length) {
      if (cached) publish(cached);
      return;
    }

    fetch("/api/prefill/resolve?" + send.join("&"), {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.found || !j.prefill) return;
        publish(j.prefill);
      })
      .catch(function () { /* a failed lookup just leaves the form empty */ });
  } catch (e) {}
})();
