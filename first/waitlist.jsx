/* ============================================================
   Farmers Fightback Rally — ticket waitlist (/first)
   Standalone, self-contained page mirroring the /rally design.
   NOT part of the main app.jsx/site.json system.

   On submit it does two parallel writes, mirroring app.jsx
   signPetition():
     1. no-cors form POST to the Campaign Nucleus receiver
     2. JSON POST to /api/event-log (Airtable match-or-create + event)
   plus a browser-only Meta Pixel Lead on success.
   ============================================================ */

const { useState } = React;

const EVENT = {
  date: "Saturday 29 August",
};

// Campaign Nucleus receiver — waitlist list (verbatim per brief).
const CN_RECEIVER_URL =
  "https://teller.campaignnucleus.com/forms/receiver/ea3a05c5-b4d0-4b94-b7ee-671c5003eb34";

/* ---------- tiny inline icons ---------- */
const I = {
  check: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>),
  star: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z"/></svg>),
  bell: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>),
  fb: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M14 8.5V6.8c0-.8.2-1.3 1.4-1.3H17V2.7c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v1.8H8v3h2.6V21H14v-8.5h2.6l.4-3z"/></svg>),
  wa: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.7-.1l.9-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.2.5.3 0 .2 0 .8-.2 1.4z"/></svg>),
  x: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M18.9 1.2h3.68l-8.04 9.19L24 22.79h-7.41l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.2h7.59l5.24 6.93zM17.61 20.6h2.04L6.49 3.29H4.3z"/></svg>),
  sms: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>),
  link: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>),
};

/* Donation matrix — the standard donor tiers; each links straight to its
   Stripe payment page. Mirrors content/site.json donorPage.amounts. */
const DONATE = [
  { amount: 35, url: "https://buy.stripe.com/14AbJ0eNg0in96H2tqbV60Q", tag: "Prints 500 leaflets" },
  { amount: 65, url: "https://buy.stripe.com/28EdR85cG3uzaaL2tqbV60R", tag: "An hour of legal counsel" },
  { amount: 135, url: "https://buy.stripe.com/dRm9AS7kOghlaaL2tqbV60S", tag: "A targeted ad set", isDefault: true },
  { amount: 265, url: "https://buy.stripe.com/5kQeVcfRkghlfv5fgcbV60T", tag: "A camera kit for a farmer" },
  { amount: 550, url: "https://buy.stripe.com/7sY5kCgVo7KP0AbgkgbV60U", tag: "A regional billboard for a week" },
  { amount: 1500, url: "https://buy.stripe.com/7sY4gydJcaX1dmX1pmbV60V", tag: "Fund a full TV campaign run" },
];

/* ---------- attribution helper (inline — no app.jsx here) ----------
   Reads UTM/click-id/ref from the URL, _fbp from the cookie, and the
   landing URL. Returns only the non-empty keys so both the CN body and
   the event-log payload stay clean. */
function getCookie(name) {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function buildAttribution() {
  const out = {};
  try {
    const q = new URLSearchParams(window.location.search);
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ref"].forEach((k) => {
      const v = q.get(k);
      if (v) out[k] = v;
    });
  } catch (e) {}
  const fbp = getCookie("_fbp");
  if (fbp) out._fbp = fbp;
  try { out.landing_url = window.location.href; } catch (e) {}
  return out;
}

/* ---------- masthead ---------- */
function Masthead() {
  return (
    <header className="ffx-mast">
      <span className="ffx-rays" />
      <span className="ffx-sun" />
      <div className="ffx-mast-in">
        <img className="ffx-logo" src="/assets/logo-horizontal.png" alt="Farmers Fightback" />
        <div className="ffx-kicker">Details drop soon</div>
        <h1 className="ffx-title">Be first<span className="ffx-rally">in line</span></h1>
        <div className="ffx-band">
          <div className="ffx-band-date">{EVENT.date}</div>
        </div>
      </div>
    </header>
  );
}

/* ---------- field ---------- */
function Field({ label, opt, err, ...rest }) {
  return (
    <label className={"ffx-field" + (err ? " err" : "")}>
      <span className="ffx-field-l">{label}{opt ? <em>optional</em> : <span className="ffx-req" aria-hidden="true">*</span>}</span>
      <input className="ffx-input" {...rest} />
      {err && <span className="ffx-field-e">{err}</span>}
    </label>
  );
}

/* ============================================================
   WAITLIST FORM
   ============================================================ */
function WaitlistForm({ onDone }) {
  const [form, setForm] = useState({ first: "", last: "", email: "", mobile: "", postcode: "" });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) e.email = "Enter a valid email";
    setErrs(e);
    if (Object.keys(e).length) return;

    setBusy(true);
    const attribution = buildAttribution();
    const first_name = form.first.trim();
    const last_name = form.last.trim();
    const email = form.email.trim();
    const mobile = form.mobile.trim();
    const postcode = form.postcode.trim();

    // 1. Campaign Nucleus receiver push (no-cors, form-encoded).
    try {
      const cnBody = new URLSearchParams({
        first_name,
        last_name,
        email,
        phone: mobile || "",
        postcode: postcode || "",
        ...attribution,
      });
      fetch(CN_RECEIVER_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: cnBody,
        keepalive: true,
      }).catch(() => {});
    } catch (err) {}

    // 2. Airtable native capture via /api/event-log (match-or-create + event).
    try {
      await fetch("/api/event-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "Rally Waitlist",
          first_name,
          last_name,
          email,
          mobile,
          postcode,
          source_channel: "Other",
          payload: { source: "first_waitlist", ...attribution },
        }),
        keepalive: true,
      });
    } catch (err) {}

    // Browser-only Meta Pixel Lead (no server Meta call here, so no dedup).
    if (window.fbq) {
      try { window.fbq("track", "Lead", { content_name: "Rally Waitlist" }); } catch (err) {}
    }

    onDone(first_name);
  };

  return (
    <div className="ffx-card">
      <div className="ffx-pitch">
        <div className="ffx-pitch-tag"><I.star width="13" height="13" /> Waitlist</div>
        <div className="ffx-pitch-h">Get the first shout when details go live</div>
        <p className="ffx-pitch-p">Numbers are limited and this one will move fast. Join the waitlist and we&rsquo;ll text and email you the moment registrations are open &mdash; before we post it anywhere else.</p>
      </div>

      <div className="ffx-sec-h">Your details</div>
      <div className="ffx-fields">
        <Field label="First name" value={form.first} onChange={set("first")} err={errs.first} placeholder="Jane" autoComplete="given-name" />
        <Field label="Last name" value={form.last} onChange={set("last")} placeholder="Farmer" autoComplete="family-name" />
        <Field label="Email" type="email" inputMode="email" value={form.email} onChange={set("email")} err={errs.email} placeholder="jane@example.com" autoComplete="email" />
        <Field label="Mobile" opt type="tel" inputMode="tel" value={form.mobile} onChange={set("mobile")} placeholder="0400 000 000" autoComplete="tel" />
        <Field label="Postcode" opt inputMode="numeric" value={form.postcode} onChange={set("postcode")} placeholder="3387" autoComplete="postal-code" />
      </div>

      <button className="ffx-btn ffx-btn-lg" onClick={submit} disabled={busy}>
        {busy ? "Joining…" : "Join the waitlist →"}
      </button>
    </div>
  );
}

/* ============================================================
   SUCCESS STATE
   ============================================================ */
function SuccessCard({ first }) {
  const url = "https://www.farmersfightback.com/first";
  const text = "Details for the Farmers Fightback Rally drop soon — get on the waitlist so you don't miss out:";
  const enc = encodeURIComponent;
  const [copied, setCopied] = useState(false);
  const chans = [
    { k: "fb", label: "Facebook", Ic: I.fb, href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`, c: "#1877F2" },
    { k: "x", label: "X", Ic: I.x, href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`, c: "#111111" },
    { k: "wa", label: "WhatsApp", Ic: I.wa, href: `https://wa.me/?text=${enc(text + " " + url)}`, c: "#25D366" },
    { k: "sms", label: "Text", Ic: I.sms, href: `sms:?&body=${enc(text + " " + url)}`, c: "#2C6E8F" },
  ];
  const copy = () => {
    try { navigator.clipboard.writeText(url); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ffx-card">
      <div className="ffx-success">
        <span className="ffx-success-badge"><I.check width="34" height="34" /></span>
        <div className="ffx-success-script">You&rsquo;re on the list{first ? ", " + first : ""}.</div>
        <h2 className="ffx-success-h">You&rsquo;re first in line</h2>
        <p className="ffx-success-p">We&rsquo;ll text and email you the moment details are released.</p>
      </div>

      <div className="ffx-block ffx-block--give">
        <div className="ffx-block-h">
          <span className="ffx-block-eb"><I.star width="12" height="12" /> Back the fight</span>
          <h3>Chip in while you wait</h3>
          <p>They have billions. We have you. Every dollar keeps the fight on the road.</p>
        </div>
        <div className="ffx-give-grid">
          {DONATE.map(({ amount, url: durl, tag, isDefault }) => (
            <a key={amount} className={"ffx-give" + (isDefault ? " is-default" : "")} href={durl} target="_top" rel="noopener">
              <span className="ffx-give-amt">${amount}</span>
              <span className="ffx-give-tag">{tag}</span>
            </a>
          ))}
        </div>
      </div>

      <div className="ffx-block">
        <div className="ffx-block-h">
          <span className="ffx-block-eb"><I.star width="12" height="12" /> Bring your people</span>
          <h3>Spread the word</h3>
          <p>The bigger the crowd, the louder we are.</p>
        </div>
        <div className="ffx-share-grid">
          {chans.map(({ k, label, Ic, href, c }) => (
            <a key={k} className="ffx-share-btn" href={href} target="_blank" rel="noreferrer" style={{ "--ch": c }}>
              <span className="ffx-share-ic"><Ic width="18" height="18" /></span>{label}
            </a>
          ))}
          <button type="button" className="ffx-share-btn ffx-share-copy" onClick={copy} style={{ "--ch": "#175530" }}>
            <span className="ffx-share-ic"><I.link width="18" height="18" /></span>{copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      </div>

      <div className="ffx-navrow">
        <a className="ffx-navbtn ffx-navbtn-green" href="/">← Back to home</a>
      </div>
    </div>
  );
}

/* ============================================================
   ROOT
   ============================================================ */
function WaitlistApp() {
  const [done, setDone] = useState(false);
  const [first, setFirst] = useState("");

  return (
    <div className="ffx-app">
      <Masthead />
      <div className="ffx-wrap">
        {done
          ? <SuccessCard first={first} />
          : <WaitlistForm onDone={(f) => {
              setFirst(f); setDone(true);
              // Land on the donor ask, not the masthead, so the give block
              // is the first thing they see on the followup page.
              setTimeout(() => {
                const el = document.querySelector(".ffx-block--give");
                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                else window.scrollTo(0, 0);
              }, 60);
            }} />}
      </div>
      <footer className="ffx-foot">
        <div><span className="ffx-foot-l">Enquiries</span> events@farmersfightback.com</div>
        <div className="ffx-foot-auth">Authorised by Ben Duxson, Farmers Fightback, Marnoo VIC.</div>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<WaitlistApp />);
