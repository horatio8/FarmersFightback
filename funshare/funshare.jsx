/* ============================================================
   Farmers Fightback — share the sign-up (/funshare)
   Standalone, self-contained page mirroring the /rally & /first
   design (ffx- system, styles inlined in funshare/index.html).
   NOT part of the main app.jsx/site.json system and NOT in the menu.

   Sole purpose: get people to share the rally sign-up page
   (/first) across Facebook, X, email, text, WhatsApp, LinkedIn,
   Telegram, Reddit — plus copy-link. Each outbound link carries
   per-platform UTM params so signups from a share are attributable
   in Clarity / Campaign Nucleus.
   ============================================================ */

const { useState } = React;

// The sign-up page we want everyone to share.
const SHARE_BASE = "https://www.farmersfightback.com/first";
const SHARE_TITLE = "Farmers Fightback Rally";
// One line that reads well as a post, an SMS, and an email body.
const SHARE_MSG =
  "Stand with Aussie farmers. Details for the Farmers Fightback Rally drop soon — get on the list so you don't miss out:";
const EMAIL_SUBJECT = "Stand with Aussie farmers — get on the list";

// Per-platform tagged link so a signup can be traced back to the share.
function taggedUrl(platform) {
  return `${SHARE_BASE}?utm_source=funshare&utm_medium=${platform}&utm_campaign=rally_waitlist`;
}

/* ---------- tiny inline icons ---------- */
const I = {
  star: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z"/></svg>),
  check: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>),
  fb: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M14 8.5V6.8c0-.8.2-1.3 1.4-1.3H17V2.7c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v1.8H8v3h2.6V21H14v-8.5h2.6l.4-3z"/></svg>),
  x: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M18.9 1.2h3.68l-8.04 9.19L24 22.79h-7.41l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.2h7.59l5.24 6.93zM17.61 20.6h2.04L6.49 3.29H4.3z"/></svg>),
  wa: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.7-.1l.9-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.2.5.3 0 .2 0 .8-.2 1.4z"/></svg>),
  li: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>),
  mail: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="2.5" y="4.5" width="19" height="15" rx="2.2"/><path d="M3 6l9 6.5L21 6"/></svg>),
  sms: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>),
  tg: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>),
  rd: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M24 11.78a2.34 2.34 0 0 0-2.34-2.34c-.63 0-1.2.25-1.62.66a11.4 11.4 0 0 0-6.05-1.9l1.03-4.85 3.37.72a1.67 1.67 0 1 0 .18-.83l-3.76-.8a.42.42 0 0 0-.5.32l-1.15 5.42a11.44 11.44 0 0 0-6.14 1.9 2.33 2.33 0 0 0-1.62-.66 2.34 2.34 0 0 0-.95 4.48c-.03.23-.05.46-.05.7 0 3.56 4.14 6.44 9.25 6.44s9.25-2.88 9.25-6.44c0-.24-.02-.47-.05-.7A2.34 2.34 0 0 0 24 11.78zM6.14 13.44a1.67 1.67 0 1 1 3.34 0 1.67 1.67 0 0 1-3.34 0zm9.32 4.4a5.9 5.9 0 0 1-3.46.98 5.9 5.9 0 0 1-3.46-.98.42.42 0 0 1 .5-.68 5.1 5.1 0 0 0 2.96.8c1.12 0 2.16-.25 2.96-.82a.42.42 0 1 1 .5.7zm-.22-2.73a1.67 1.67 0 1 1 0-3.34 1.67 1.67 0 0 1 0 3.34z"/></svg>),
  link: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>),
};

const enc = encodeURIComponent;

/* The share channels, in priority order. `href` is a function so each
   link carries its own UTM medium. Copy-link is handled separately. */
const CHANNELS = [
  { k: "facebook",  label: "Facebook", Ic: I.fb,   c: "#1877F2", href: () => `https://www.facebook.com/sharer/sharer.php?u=${enc(taggedUrl("facebook"))}` },
  { k: "x",         label: "X",        Ic: I.x,    c: "#111111", href: () => `https://twitter.com/intent/tweet?text=${enc(SHARE_MSG)}&url=${enc(taggedUrl("x"))}` },
  { k: "whatsapp",  label: "WhatsApp", Ic: I.wa,   c: "#25D366", href: () => `https://wa.me/?text=${enc(SHARE_MSG + " " + taggedUrl("whatsapp"))}` },
  { k: "sms",       label: "Text",     Ic: I.sms,  c: "#2C6E8F", href: () => `sms:?&body=${enc(SHARE_MSG + " " + taggedUrl("sms"))}` },
  { k: "email",     label: "Email",    Ic: I.mail, c: "#C1573B", href: () => `mailto:?subject=${enc(EMAIL_SUBJECT)}&body=${enc(SHARE_MSG + "\n\n" + taggedUrl("email"))}` },
  { k: "linkedin",  label: "LinkedIn", Ic: I.li,   c: "#0A66C2", href: () => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(taggedUrl("linkedin"))}` },
  { k: "telegram",  label: "Telegram", Ic: I.tg,   c: "#229ED9", href: () => `https://t.me/share/url?url=${enc(taggedUrl("telegram"))}&text=${enc(SHARE_MSG)}` },
  { k: "reddit",    label: "Reddit",   Ic: I.rd,   c: "#FF4500", href: () => `https://www.reddit.com/submit?url=${enc(taggedUrl("reddit"))}&title=${enc(SHARE_TITLE)}` },
];

/* ---------- masthead ---------- */
function Masthead() {
  return (
    <header className="ffx-mast">
      <span className="ffx-rays" />
      <span className="ffx-sun" />
      <div className="ffx-mast-in">
        <img className="ffx-logo" src="/assets/logo-horizontal.png" alt="Farmers Fightback" />
        <div className="ffx-kicker">Now bring backup</div>
        <h1 className="ffx-title">Share the<span className="ffx-rally">sign-up</span></h1>
        <p className="ffx-sub">The rally only hits as hard as the crowd behind it. Send the sign-up to everyone who&rsquo;d stand with farmers &mdash; <strong>it takes ten seconds</strong>.</p>
      </div>
    </header>
  );
}

/* ============================================================
   SHARE CARD
   ============================================================ */
function ShareCard() {
  const [shared, setShared] = useState([]);   // platform keys tapped
  const [copied, setCopied] = useState(false);
  const plainUrl = taggedUrl("copy");

  const mark = (k) => setShared((s) => (s.includes(k) ? s : [...s, k]));

  const onShare = (ch, e) => {
    // Best-effort share-intent signal for retargeting; never blocks the link.
    try { if (window.fbq) window.fbq("trackCustom", "Share", { platform: ch.k }); } catch (err) {}
    // Popup platforms open cleanly in a new tab; mailto/sms navigate in place
    // (default anchor behaviour), so only intercept the http(s) ones.
    if (/^https?:/.test(ch.href())) {
      e.preventDefault();
      window.open(ch.href(), "_blank", "noopener,noreferrer");
    }
    mark(ch.k);
  };

  const copy = () => {
    try { navigator.clipboard.writeText(plainUrl).then(() => flagCopied(), () => fallbackCopy()); }
    catch (err) { fallbackCopy(); }
  };
  const fallbackCopy = () => {
    try {
      const t = document.createElement("textarea");
      t.value = plainUrl; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.focus(); t.select();
      document.execCommand("copy"); document.body.removeChild(t);
      flagCopied();
    } catch (err) {}
  };
  const flagCopied = () => {
    try { if (window.fbq) window.fbq("trackCustom", "Share", { platform: "copy" }); } catch (err) {}
    mark("copy");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const count = shared.length;

  return (
    <div className="ffx-card">
      <div className="ffx-pitch">
        <div className="ffx-pitch-tag"><I.star width="13" height="13" /> Why it matters</div>
        <div className="ffx-pitch-h">Every share puts more boots on the ground</div>
        <p className="ffx-pitch-p">Details drop soon and spots are limited. The more people on the list, the bigger the turnout &mdash; and the harder farmers are to ignore. Pick a couple of channels below and pass it on.</p>
      </div>

      <div className="ffx-block">
        <div className="ffx-block-h">
          <span className="ffx-block-eb"><I.star width="12" height="12" /> Spread the word</span>
          <h3>Share the sign-up</h3>
          <p>Tap a channel to post or send it. Do a few &mdash; every one counts.</p>
        </div>

        <div className="ffx-share-grid">
          {CHANNELS.map((ch) => (
            <a
              key={ch.k}
              className={"ffx-share-btn" + (shared.includes(ch.k) ? " is-shared" : "")}
              href={ch.href()}
              target="_blank"
              rel="noreferrer"
              style={{ "--ch": ch.c }}
              onClick={(e) => onShare(ch, e)}
            >
              <span className="ffx-share-ic">
                {shared.includes(ch.k) ? <I.check width="17" height="17" /> : <ch.Ic width="18" height="18" />}
              </span>
              {ch.label}
            </a>
          ))}
          <button type="button" className="ffx-share-btn ffx-share-copy" onClick={copy} style={{ "--ch": "#175530" }}>
            <span className="ffx-share-ic">{copied || shared.includes("copy") ? <I.check width="17" height="17" /> : <I.link width="18" height="18" />}</span>
            {copied ? "Link copied!" : "Copy link"}
          </button>
        </div>

        {count > 0 && (
          <div className="ffx-fine" style={{ marginTop: 14, fontWeight: 700, color: "var(--field-green)" }}>
            {count === 1 ? "Nice — shared to 1 place. Keep going!" : `Legend — shared to ${count} places. That's real reach.`}
          </div>
        )}
      </div>

      <div className="ffx-navrow">
        <a className="ffx-navbtn ffx-navbtn-gold" href="/first">Haven&rsquo;t signed up yet? Join the list →</a>
        <a className="ffx-navbtn ffx-navbtn-green" href="/">← Back to home</a>
      </div>
    </div>
  );
}

/* ============================================================
   ROOT
   ============================================================ */
function FunShareApp() {
  return (
    <div className="ffx-app">
      <Masthead />
      <div className="ffx-wrap">
        <ShareCard />
      </div>
      <footer className="ffx-foot">
        <div><span className="ffx-foot-l">Enquiries</span> events@farmersfightback.com</div>
        <div className="ffx-foot-auth">Authorised by Ben Duxson, Farmers Fightback, Marnoo VIC.</div>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<FunShareApp />);
