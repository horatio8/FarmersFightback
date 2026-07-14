/* global React, ReactDOM */
const { useState, useEffect, createContext, useContext } = React;

const CONTENT_URL = (typeof window !== "undefined" && window.__FF_CONTENT_URL) || "content/site.json";
const ContentContext = createContext(null);
const useContent = () => useContext(ContentContext);

// ---------- Placeholder image helper ----------
function Placeholder({ label, ratio = "16/9", tone = "navy", className = "", children }) {
  const palettes = {
    navy:  { bg: "#0f2a3d", stripe: "#12354B", ink: "#c9d6df" },
    dust:  { bg: "#d9cbb3", stripe: "#c7b79a", ink: "#4a3f2a" },
    red:   { bg: "#8a1b1b", stripe: "#a12020", ink: "#f6d6d6" },
    paddock:{ bg: "#4a5a2f", stripe: "#3e4d27", ink: "#e5ecd1" },
    sky:   { bg: "#7a92a3", stripe: "#6a8395", ink: "#e9eff3" },
  };
  const p = palettes[tone] || palettes.navy;
  return (
    <div
      className={`ff-ph ${className}`}
      style={{
        aspectRatio: ratio,
        background: `repeating-linear-gradient(135deg, ${p.bg} 0 18px, ${p.stripe} 18px 36px)`,
        color: p.ink,
      }}
    >
      <div className="ff-ph-inner">
        <span className="ff-ph-dot" />
        <span className="ff-ph-label">{label}</span>
      </div>
      {children}
    </div>
  );
}

const html = (s) => ({ __html: s });

// ---------- Ad attribution capture ----------
// Captures click ids and UTM params from the landing URL (META, Google,
// TikTok, etc.) and keeps them in sessionStorage so they ride along with
// every form submission to the Nucleus receiver.
const FF_ATTR_KEY = "ff_attribution";
const FF_ATTR_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "fbclid", "gclid", "ttclid", "li_fat_id", "msclkid", "twclid", "sccid",
  "ad_id", "adset_id", "campaign_id", "placement", "ref"
];
function captureAttribution() {
  if (typeof window === "undefined") return {};
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem(FF_ATTR_KEY) || "{}"); } catch {}
  const url = new URL(window.location.href);
  const fresh = {};
  FF_ATTR_PARAMS.forEach(k => {
    const v = url.searchParams.get(k);
    if (v) fresh[k] = v;
  });
  if (Object.keys(fresh).length > 0) {
    fresh.landing_url = window.location.href;
    fresh.landing_referrer = document.referrer || "";
    fresh.landing_at = new Date().toISOString();
    try { sessionStorage.setItem(FF_ATTR_KEY, JSON.stringify(fresh)); } catch {}
    return fresh;
  }
  return stored;
}
function getAttribution() {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(sessionStorage.getItem(FF_ATTR_KEY) || "{}"); } catch { return {}; }
}

// ---------- Meta Conversions API (server-side) ----------
// Sends events to /api/meta-capi which forwards to Meta with hashed PII.
// Uses the same event_id for both browser pixel and CAPI to deduplicate.
function getCookie(name) {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function sendCAPI(eventName, userData, customData) {
  if (typeof window === "undefined") return;
  const eventId = `${eventName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Fire browser pixel with matching event_id for dedup
  if (window.fbq) {
    window.fbq("track", eventName, customData || {}, { eventID: eventId });
  }
  // Fire server-side CAPI
  const body = {
    event_name: eventName,
    event_id: eventId,
    event_source_url: window.location.href,
    user_data: {
      ...(userData || {}),
      fbc: getCookie("_fbc"),
      fbp: getCookie("_fbp"),
    },
  };
  if (customData && Object.keys(customData).length > 0) body.custom_data = customData;
  fetch("/api/meta-capi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true, // survive page navigation (e.g. redirect to Stripe)
  }).catch(() => {}); // fire-and-forget, don't block UX
}

// ---------- Partial capture (WS4.1) ----------
// Beacon typed-but-not-submitted identities to /api/partial on field blur.
// Once per form per session; completion beacon (from signPetition) wins.
function sendPartial(form, fields, completed) {
  try {
    const email = (fields.email || "").trim();
    const mobile = (fields.mobile || fields.phone || "").trim();
    if (!email && !mobile) return;
    if (!completed) {
      const key = `ff_partial_${form}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    }
    const blob = JSON.stringify({
      form,
      email, mobile,
      first_name: (fields.first_name || fields.first || "").trim(),
      last_name: (fields.last_name || fields.last || "").trim(),
      postcode: (fields.postcode || "").trim(),
      ...(completed ? { completed: true } : {}),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/partial", new Blob([blob], { type: "application/json" }));
    } else {
      fetch("/api/partial", { method: "POST", headers: { "Content-Type": "application/json" }, body: blob, keepalive: true }).catch(() => {});
    }
  } catch {}
}

// ---------- Donation checkout (WS2, Stripe-hosted Pattern A) ----------
// $X one-off → mapped monthly ask (post-donation upsell on the thank-you panel).
const DONATE_MONTHLY_MAP = { 35: 10, 65: 20, 135: 35, 265: 65, 550: 100, 1500: 250 };
function monthlyFor(amount) {
  if (DONATE_MONTHLY_MAP[amount]) return DONATE_MONTHLY_MAP[amount];
  const approx = Math.round((Number(amount) || 0) * 0.3);
  return Math.max(5, Math.round(approx / 5) * 5);
}

// Reset a checkout busy flag when the page is restored from the browser's
// back-forward cache: tap an amount -> land on Stripe -> hit Back, and the
// page returns with busy=true frozen in, leaving every button disabled.
function useBfcacheReset(reset) {
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) reset(); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
}

// Create a Stripe-hosted Checkout Session via /api/checkout and return its
// URL. All attribution (utm_*, ref, contact_id, sms_variant) rides along.
async function createDonationCheckout({ amount, frequency, email, slug }) {
  const attr = getAttribution();
  const urlNow = new URL(window.location.href);
  let contactId = urlNow.searchParams.get("c") || "";
  try { contactId = contactId || localStorage.getItem("ff_contact_id") || ""; } catch {}
  // Carry the petition signer's email into checkout: prefills Stripe and
  // identifies the Lapse Queue row, so signed -> clicked donate -> abandoned
  // Stripe enrols them in the donation-lapse automation.
  try { email = email || sessionStorage.getItem("ff_email") || undefined; } catch {}
  const body = {
    amount: Number(amount),
    frequency,
    email: email || undefined,
    slug: slug || currentPetitionSlug() || undefined,
    ref: (attr.ref || "").toUpperCase() || undefined,
    contact_id: contactId || undefined,
    sms_variant: attr.utm_source === "sms" ? (attr.utm_content === "issue" ? "B" : "A") : undefined,
    utm_source: attr.utm_source, utm_medium: attr.utm_medium,
    utm_campaign: attr.utm_campaign, utm_content: attr.utm_content, utm_term: attr.utm_term,
  };
  const r = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(j.error || "checkout failed");
  return j.url;
}


// ---------- Live signature counter (WS3) ----------
// Auto-advancing goal for the master petition: the milestone is always the
// next 25k step strictly above the live count, with a 100k floor. So the
// goal reads 100k until the count reaches 100k, then flips to 125k, 150k, …
// with no manual edits or backend changes.
const MILESTONE_STEP = 25000;
const MILESTONE_FLOOR = 100000;
function computeNextMilestone(count) {
  const c = Number(count) || 0;
  const stepped = (Math.floor(c / MILESTONE_STEP) + 1) * MILESTONE_STEP;
  return Math.max(MILESTONE_FLOOR, stepped);
}

// Patch every count derived from the master petition number with the live
// value from /api/signature-count. Baldwins/Fuel keep their own counts
// (they don't equal the master).
function applyLiveSignatureCount(content, live) {
  if (!content || !live || live.stale || !Number.isFinite(live.count) || live.count <= 0) return content;
  // Never patch DOWN below the static number — protects against an
  // unseeded/partial backend count making the public counter shrink.
  const staticMaster = Number(content.petition && content.petition.currentCount) || 0;
  if (live.count < staticMaster) return content;
  const master = Number(content.petition && content.petition.currentCount) || 0;
  const clone = JSON.parse(JSON.stringify(content));
  const display = live.display || live.count.toLocaleString("en-AU");
  if (clone.topBanner && clone.topBanner.boldText) {
    clone.topBanner.boldText = clone.topBanner.boldText.replace(/^[\d,]+\+?/, display);
  }
  (clone.impactStats || []).forEach((s) => { if (/signature/i.test(s.label || "")) s.value = live.count; });
  if (master) {
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") {
        if (Number(node.currentCount) === master) {
          node.currentCount = live.count;
          // Advance the goal in lockstep with the live count.
          if (node.nextMilestone !== undefined) node.nextMilestone = computeNextMilestone(live.count);
        }
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    };
    walk(clone);
  } else if (clone.petition) {
    clone.petition.currentCount = live.count;
  }
  return clone;
}

// Add ?client_reference_id=<slug> to a Stripe Payment Link URL so the
// resulting checkout session carries the petition the donor was viewing
// when they clicked. The Stripe webhook reads it back and writes it into
// Airtable; /share uses it to decide which petition page to share — a
// server-trustable signal that doesn't rely on localStorage surviving
// the Stripe round-trip.
function appendClientRef(url, slug) {
  if (!url || !slug) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("client_reference_id", String(slug));
    return u.toString();
  } catch {
    return url;
  }
}

// Map a /take-action/<slug>/ path → the Stripe-safe slug we pass as
// client_reference_id. Returns "" for paths we don't recognise (so the
// donor's share defaults to the homepage rather than a guess).
function petitionSlugFromPath(path) {
  if (!path) return "";
  const m = String(path).match(/^\/take-action\/([^/]+)/);
  return m ? m[1] : "";
}

// Best-effort lookup of the petition the donor was last engaged with,
// based on what signPetition() persisted. Used by donate buttons that
// aren't on a petition page themselves (e.g. /donate).
function currentPetitionSlug() {
  try {
    const lastPath = localStorage.getItem("ff_last_petition_url") || "";
    return petitionSlugFromPath(lastPath);
  } catch {
    return "";
  }
}

// ---------- Petition signup (shared) ----------
// One pipeline for every petition form on the site (home Petition,
// PetitionPage, BaldwinFloodlight). In parallel:
//   1. Posts to the Campaign Nucleus receiver if one is configured
//      (no-cors, fire-and-forget — existing CN delivery is preserved).
//   2. Posts to /api/petition-signup for native Vercel capture:
//      Airtable match-or-create, referral code generation, Meta Lead.
//   3. Fires the browser Pixel "Lead" reusing the server's event_id
//      for deduplication in Meta Events Manager.
// Returns when both the server capture and the browser pixel have been
// kicked off; CN is fire-and-forget.
async function signPetition({ first_name, last_name, email, mobile, postcode, content_name, receiverUrl, extraReceiverFields, country }) {
  if (typeof window === "undefined") return null;
  const attr = getAttribution();
  const ref = (attr.ref || "").toString().toUpperCase();
  const fbclid = attr.fbclid || "";
  const fbp = getCookie("_fbp") || "";

  // Persist the URL of the page they signed on so /share can use it as the
  // share target (so the right petition page + hero image is what people see).
  try {
    const path = window.location.pathname || "/";
    localStorage.setItem("ff_last_petition_url", path);
    if (content_name) localStorage.setItem("ff_last_petition_name", content_name);
  } catch {}

  // Campaign Nucleus parallel push.
  if (receiverUrl) {
    const cnBody = new URLSearchParams({
      first_name, last_name, email,
      phone: mobile || "",
      postcode: postcode || "",
      ...(extraReceiverFields || {}),
      ...attr,
    });
    fetch(receiverUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: cnBody,
      keepalive: true,
    }).catch(() => {});
  }

  // Vercel native capture (Airtable + server-side Meta Lead).
  let metaEventId = "";
  let contactId = "";
  let referralCode = "";
  try {
    const r = await fetch("/api/petition-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name, last_name, email,
        mobile: mobile || "",
        postcode: postcode || "",
        fbclid, fbp, ref,
        utm_source: attr.utm_source,
        utm_medium: attr.utm_medium,
        utm_campaign: attr.utm_campaign,
      }),
      keepalive: true,
    });
    if (r.ok) {
      const j = await r.json();
      metaEventId = j.meta_event_id || "";
      contactId = j.contact_id || "";
      referralCode = j.referral_code || "";
      if (referralCode) try { localStorage.setItem("ff_referral_code", referralCode); } catch {}
      if (contactId)   try { localStorage.setItem("ff_contact_id", contactId); } catch {}
      // Session-scoped (clears when the tab closes, so shared computers
      // don't leak it): lets the donate flow prefill Stripe's email AND
      // makes a subsequent checkout abandon identifiable, so the signer
      // lands in the donation-lapse automation instead of being skipped
      // as anonymous.
      if (email) try { sessionStorage.setItem("ff_email", email); } catch {}
    }
  } catch (err) {
    console.error("petition-signup:", err);
  }

  // Browser Pixel Lead — dedup'd against server fire via shared event_id.
  if (window.fbq) {
    const eventId = metaEventId || `Lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.fbq("track", "Lead", { content_name: content_name || "Petition" }, { eventID: eventId });
  }

  // Completion beacon (WS4): swaps any *_partial CN tag to *_completed and
  // closes pending lapse rows for this identity. Completion always wins.
  sendPartial("petition", { email, mobile, first_name, last_name, postcode }, true);

  window.dispatchEvent(new CustomEvent("petition-signed", { detail: { first: (first_name || "").trim() } }));
  return { metaEventId, contactId, referralCode };
}

// ---------- Top banner ----------
function TopBanner() {
  const c = useContent().topBanner;
  if (!c.enabled) return null;
  return (
    <div className="ff-topbanner">
      <div className="ff-wrap ff-topbanner-inner">
        <span className="ff-topbanner-pulse" />
        <span><strong>{c.boldText}</strong> {c.text}</span>
        <a href={c.linkHref} className="ff-topbanner-link">{c.linkText}</a>
      </div>
    </div>
  );
}

// ---------- Navigation ----------
function Nav({ onDonate }) {
  const c = useContent().nav;
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!openMenu) return;
    const close = (e) => {
      if (!e.target.closest(".ff-nav-list")) setOpenMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [openMenu]);
  const logoSrc = window.location.pathname.split("/").length > 2 ? "../assets/logo.png" : "assets/logo.png";
  const homeHref = "/";
  return (
    <nav className={`ff-nav ${scrolled ? "is-scrolled" : ""}`}>
      <div className="ff-wrap ff-nav-inner">
        <a href={homeHref} className="ff-logo" aria-label="Farmers Fightback home">
          <img src={logoSrc} alt="Farmers Fightback" />
        </a>
        <ul className="ff-nav-list">
          {c.items.map((i) => (
            <li key={i.label} className={`ff-nav-item ${i.children ? "has-children" : ""} ${openMenu === i.label ? "is-open" : ""}`}>
              {i.children ? (
                <>
                  <button
                    type="button"
                    className={`ff-nav-trigger ${i.active ? "is-active" : ""}`}
                    aria-haspopup="true"
                    aria-expanded={openMenu === i.label}
                    onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === i.label ? null : i.label); }}
                  >
                    {i.label} <span className="ff-nav-caret" aria-hidden="true">▾</span>
                  </button>
                  <ul className="ff-nav-dropdown" role="menu">
                    {i.children.map((c2) => (
                      <li key={c2.label} role="none">
                        {c2.disabled
                          ? <span className="is-disabled" role="menuitem" aria-disabled="true" title="Coming soon">{c2.label}</span>
                          : <a href={c2.href} role="menuitem">{c2.label}</a>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <a href={i.href} className={i.active ? "is-active" : ""}>{i.label}</a>
              )}
            </li>
          ))}
        </ul>
        <div className="ff-nav-actions">
          <a href="/petition" className="ff-btn ff-btn--pink ff-nav-petition">Sign the petition</a>
          <button className="ff-btn ff-btn--red" onClick={onDonate}>{c.donateLabel}</button>
          <button
            className="ff-hamburger"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>
      {open && (
        <div className="ff-mobile-menu">
          {c.items.flatMap((i) => i.children
            ? [
                <a key={i.label} href={i.href} className="is-parent" onClick={() => setOpen(false)}>{i.label}</a>,
                ...i.children.map((c2) => (
                  c2.disabled
                    ? <span key={i.label + c2.label} className="is-child is-disabled" aria-disabled="true">↳ {c2.label}</span>
                    : <a key={i.label + c2.label} href={c2.href} className="is-child" onClick={() => setOpen(false)}>↳ {c2.label}</a>
                ))
              ]
            : [<a key={i.label} href={i.href} onClick={() => setOpen(false)}>{i.label}</a>]
          )}
        </div>
      )}
    </nav>
  );
}

// ---------- Hero ----------
function Hero({ onWatch }) {
  const c = useContent().hero;
  return (
    <section id="home" className="ff-hero ff-hero--cinematic">
      {c.videoUrl ? (
        <video
          className="ff-hero-bg"
          autoPlay muted loop playsInline preload="metadata" aria-hidden="true"
          key={c.videoUrl}
          poster={c.heroImage || undefined}
        >
          <source src={c.videoUrl} type="video/mp4" />
        </video>
      ) : c.heroImage ? (
        <img className="ff-hero-bg" src={c.heroImage} alt="" aria-hidden="true" />
      ) : null}
      <div className="ff-hero-scrim" />
      <div className="ff-wrap ff-hero-content">
        <h1 className="ff-hero-title" dangerouslySetInnerHTML={html(c.titleHtml)} />
        <p className="ff-hero-sub">{c.subtitle}</p>
        <div className="ff-hero-cta">
          <a href={c.primaryCtaHref} className="ff-btn ff-btn--red ff-btn--lg">{c.primaryCtaLabel}</a>
        </div>
      </div>
      <button className="ff-hero-scroll" aria-label="Scroll to story" onClick={() => window.scrollTo({ top: window.innerHeight * 0.9, behavior: 'smooth' })}>
        <span>Scroll</span>
        <span className="ff-hero-scroll-line" />
      </button>
    </section>
  );
}

// ---------- Impact counter bar ----------
function useCountUp(target, duration = 1400) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setVal(Math.round(target * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function ImpactBar() {
  const stats = useContent().impactStats;
  return (
    <section className="ff-impact">
      <div className="ff-wrap ff-impact-inner">
        {stats.map((s, i) => <ImpactStat key={i} {...s} />)}
      </div>
    </section>
  );
}

function ImpactStat({ value, label, suffix, grow }) {
  const n = useCountUp(value);
  return (
    <div className="ff-impact-stat">
      <div className="ff-impact-num">{n.toLocaleString()}{suffix}</div>
      <div className="ff-impact-label">{label}</div>
      <div className="ff-impact-grow">{grow}</div>
    </div>
  );
}

// ---------- Intro video ----------
function IntroVideo() {
  const c = useContent().intro;
  return (
    <section className="ff-section ff-intro">
      <div className="ff-wrap ff-intro-inner">
        <div className="ff-intro-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2">{c.heading}</h2>
          <p className="ff-lede">{c.lede}</p>
        </div>
        <div className="ff-intro-player">
          <video controls playsInline muted loop autoPlay preload="metadata" key={c.videoUrl}>
            <source src={c.videoUrl} type="video/mp4" />
            Your browser doesn't support embedded video.
          </video>
        </div>
      </div>
    </section>
  );
}

// ---------- Latest video ----------
function LatestVideo({ onOpen }) {
  const c = useContent().latestVideo;
  const [playing, setPlaying] = useState(false);
  return (
    <section id="evidence" className="ff-section ff-video">
      <div className="ff-wrap ff-video-inner">
        <div className="ff-video-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2" dangerouslySetInnerHTML={html(c.headingHtml)} />
          <p className="ff-lede">{c.lede}</p>
          <ul className="ff-video-meta">
            {c.meta.map((m, i) => (
              <li key={i}><strong>{m.label}</strong> {m.value}</li>
            ))}
          </ul>
          <div className="ff-video-actions">
            {c.links.map((l, i) => (
              <a key={i} href={l.href} className={`ff-link ${l.red ? "ff-link--red" : ""}`}>{l.label}</a>
            ))}
          </div>
        </div>
        <button
          className={`ff-video-player ${playing ? "is-playing" : ""}`}
          onClick={() => { setPlaying(true); onOpen?.(); }}
          aria-label="Play latest video"
        >
          <Placeholder label={c.thumbLabel} ratio="16/9" tone="paddock" />
          <div className="ff-video-overlay">
            <div className="ff-video-play">▶</div>
            <div className="ff-video-timecode">{c.timecode}</div>
            <div className="ff-video-caption">
              <span className="ff-video-badge">{c.badgeText}</span>
              {c.captionText}
            </div>
          </div>
        </button>
      </div>
    </section>
  );
}

// ---------- Campaign summary + map ----------
function Summary() {
  const c = useContent().summary;
  return (
    <section className="ff-section ff-summary">
      <div className="ff-wrap ff-summary-inner">
        <div className="ff-summary-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2">{c.heading}</h2>
          {c.paragraphsHtml.map((p, i) => (
            <p key={i} dangerouslySetInnerHTML={html(p)} />
          ))}
          <div className="ff-summary-stats">
            {c.stats.map((s, i) => (
              <div key={i}>
                <div className="ff-stat-n">{s.number}<span>{s.unit}</span></div>
                <div className="ff-stat-l">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="ff-summary-map">
          <div className="ff-map-frame">
            {c.mapImage ? (
              c.mapLink ? (
                <a href={c.mapLink} target="_blank" rel="noopener noreferrer" className="ff-map-link" aria-label={c.mapAlt || "Open the live map"}>
                  <img src={c.mapImage} alt={c.mapAlt || ""} className="ff-map-img" loading="lazy" />
                </a>
              ) : (
                <img src={c.mapImage} alt={c.mapAlt || ""} className="ff-map-img" loading="lazy" />
              )
            ) : (
              <Placeholder label="" ratio="4/5" tone="paddock" />
            )}
            {c.mapCredit && (
              <p className="ff-map-credit">
                {c.mapLink ? (
                  <a href={c.mapLink} target="_blank" rel="noopener noreferrer">{c.mapCredit}</a>
                ) : c.mapCredit}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Petition form ----------
function Petition() {
  const c = useContent().petition;
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "" });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle");
  const update = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (form.postcode && !/^\d{4}$/.test(form.postcode)) e.postcode = "4-digit postcode";
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setState("submitting");
    await signPetition({
      first_name: form.first.trim(),
      last_name: form.last.trim(),
      email: form.email.trim(),
      mobile: form.phone.trim(),
      postcode: form.postcode.trim(),
      content_name: "Omnibus Petition",
      receiverUrl: c.receiverUrl,
      country: "au",
    });
    window.location.assign("/donate");
  };

  if (state === "done") {
    const newCount = c.currentCount + 1;
    const pct = Math.min(100, (newCount / c.goal) * 100);
    const headingHtml = c.thanksHeadingHtml.replace("{{count}}", newCount.toLocaleString());
    const lede = c.thanksLede.replace("{{first}}", form.first);
    return (
      <section id="petition" className="ff-section ff-petition">
        <div className="ff-wrap ff-petition-inner ff-petition-done">
          <div className="ff-petition-copy">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Signed · Thank you</span>
            <h2 className="ff-h2" dangerouslySetInnerHTML={html(headingHtml)} />
            <p className="ff-lede">{lede}</p>
            <div className="ff-petition-next">
              <a href="/donate?focus=1" className="ff-btn ff-btn--red">Chip in to the fight</a>
              <button className="ff-btn ff-btn--outline" onClick={() => {
                navigator.clipboard?.writeText(c.shareText);
                alert("Share link copied — paste it anywhere.");
              }}>Share with your mates</button>
            </div>
          </div>
          <div className="ff-petition-thanks">
            <div className="ff-petition-tally">
              <div className="ff-tally-num">{newCount.toLocaleString()}</div>
              <div className="ff-tally-label">Signatures and counting</div>
              <div className="ff-tally-bar"><div className="ff-tally-fill" style={{ width: pct.toFixed(1) + "%" }}/></div>
              <div className="ff-tally-goal">{pct.toFixed(1)}% toward our {c.goal.toLocaleString()} goal</div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const remaining = Math.max(0, c.nextMilestone - c.currentCount);
  const milestonePct = Math.min(100, (c.currentCount / c.nextMilestone) * 100);

  return (
    <section id="petition" className="ff-section ff-petition">
      <div className="ff-wrap ff-petition-inner">
        <div className="ff-petition-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2">{c.heading}</h2>
          <p className="ff-lede">{c.lede}</p>
        </div>
        <form className="ff-petition-form" onSubmit={submit} noValidate>
          <div className="ff-form-header">
            <div>
              <div className="ff-form-count">{c.currentCount.toLocaleString()}</div>
              <div className="ff-form-count-l">have already signed — {remaining.toLocaleString()} to {(c.nextMilestone/1000)+"k"}</div>
            </div>
            <div className="ff-form-bar"><div style={{ width: milestonePct.toFixed(1) + "%" }}/></div>
          </div>
          <div className="ff-form-row">
            <Field label={<>First name <span className="ff-req">*</span></>} error={errors.first}>
              <input value={form.first} onChange={update("first")} autoComplete="given-name" required aria-required="true"/>
            </Field>
            <Field label={<>Last name <span className="ff-req">*</span></>} error={errors.last}>
              <input value={form.last} onChange={update("last")} autoComplete="family-name" required aria-required="true"/>
            </Field>
          </div>
          <Field label={<>Email <span className="ff-req">*</span></>} error={errors.email}>
            <input type="email" value={form.email} onChange={update("email")} onBlur={() => sendPartial("petition", form)} autoComplete="email" required aria-required="true"/>
          </Field>
          <div className="ff-form-row">
            <Field label="Phone">
              <input type="tel" value={form.phone} onChange={update("phone")} onBlur={() => sendPartial("petition", form)} autoComplete="tel"/>
            </Field>
            <Field label="Postcode" error={errors.postcode}>
              <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4}/>
            </Field>
          </div>
          <button className="ff-btn ff-btn--red ff-btn--block" disabled={state==="submitting"}>
            {state === "submitting" ? c.submittingLabel : c.submitLabel}
          </button>
          {state === "error" && (
            <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>
              Something went wrong sending that. Please check your connection and try again.
            </p>
          )}
          <p className="ff-form-fine">{c.fineprint}</p>
        </form>
      </div>
    </section>
  );
}

function Field({ label, error, children }) {
  return (
    <label className={`ff-field ${error ? "has-error" : ""}`}>
      <span className="ff-field-label">{label}{error && <em className="ff-field-err"> — {error}</em>}</span>
      {children}
    </label>
  );
}

// ---------- Action cards ----------
function ActionCards() {
  const c = useContent().actions;
  return (
    <section className="ff-section ff-actions">
      <div className="ff-wrap">
        <div className="ff-actions-head">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2">{c.heading}</h2>
        </div>
        <div className="ff-actions-grid">
          {c.cards.map((card, i) => <ActionCard key={i} {...card} />)}
        </div>
      </div>
    </section>
  );
}

function ActionCard({ kicker, title, body, cta, href, tone, label, image, imageAlt }) {
  return (
    <a href={href} className="ff-card">
      <div className="ff-card-media">
        {image
          ? <img src={image} alt={imageAlt || ""} className="ff-card-img" loading="lazy" />
          : <Placeholder label={label} ratio="4/3" tone={tone} />}
      </div>
      <div className="ff-card-body">
        <span className="ff-card-kicker">{kicker}</span>
        <h3 className="ff-card-title">{title}</h3>
        <p className="ff-card-copy">{body}</p>
        <span className="ff-card-btn">{cta} <span aria-hidden="true">→</span></span>
      </div>
    </a>
  );
}

// ---------- Quote ----------
function Quote() {
  const c = useContent().quote;
  return (
    <section className="ff-section ff-quote">
      <div className="ff-wrap ff-quote-inner">
        <div className="ff-quote-mark">"</div>
        <blockquote dangerouslySetInnerHTML={html(c.html)} />
        <figcaption>
          <div className="ff-quote-name">{c.name}</div>
          <div className="ff-quote-place">{c.place}</div>
        </figcaption>
      </div>
    </section>
  );
}

// ---------- Donate band ----------
function DonateBand() {
  const c = useContent().donate;
  const d = useContent().donorPage;
  const currency = c.currency || "AUD";
  const sym = c.currencySymbol || "$";
  const amounts = (d && d.amounts) || [];
  const otherUrl = (d && d.otherUrl) || c.customOneOffUrl;
  // WS2: $65 is the anchor unless ?ask= overrides it.
  const askParam = Number(new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("ask")) || 0;
  const defaultAmount = (
    amounts.find(a => Number(a.amount) === askParam) ||
    amounts.find(a => Number(a.amount) === 65) ||
    amounts.find(a => a.isDefault) ||
    amounts[Math.min(2, amounts.length - 1)] || {}
  ).amount;
  const [pick, setPick] = useState(defaultAmount);
  const [busy, setBusy] = useState(false);
  useBfcacheReset(() => setBusy(false));

  const matched = amounts.find(a => Number(a.amount) === Number(pick));
  const fallbackUrl = matched ? matched.url : otherUrl;
  const ready = Number(pick) > 0;
  // One-off goes STRAIGHT to Stripe — no pre-payment intercept. The
  // make-it-monthly ask happens after a successful donation, on the
  // thank-you panel (DonateThanksPanel).
  const onDonate = async () => {
    if (!ready || busy) return;
    setBusy(true);
    sendCAPI("InitiateCheckout", {}, { value: Number(pick), currency: "AUD", content_name: "One-off Donation" });
    try {
      window.location.href = await createDonationCheckout({ amount: Number(pick), frequency: "oneoff" });
    } catch (e) {
      if (fallbackUrl) {
        window.location.href = appendClientRef(fallbackUrl, currentPetitionSlug());
      } else {
        setBusy(false);
        alert("Sorry — that didn't go through. Please try again.");
      }
    }
  };

  return (
    <section id="donate" className="ff-section ff-donate">
      <div className="ff-wrap ff-donate-inner">
        <div className="ff-donate-copy">
          <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2 ff-h2--light">{c.heading}</h2>
          {c.body && <p>{c.body}</p>}
          <ul className="ff-donate-where ff-donate-where--list">
            {c.where.map((w, i) => (
              <li key={i}>
                <strong>{w.percent}</strong>
                <span>{w.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="ff-donate-form">
          <div className="ff-give-chips">
            {amounts.map(a => (
              <button
                key={a.amount}
                type="button"
                className={`ff-give-chip ${Number(pick) === Number(a.amount) ? "is-on" : ""}`}
                onClick={() => setPick(a.amount)}
              >
                <span className="ff-give-chip-amt">{sym}{a.amount}</span>
                {a.tag && <span className="ff-give-chip-tag">{a.tag}</span>}
              </button>
            ))}
            <a href={otherUrl} target="_top" rel="noopener" className="ff-give-chip ff-give-chip--other">
              <span className="ff-give-chip-amt">Other</span>
              <span className="ff-give-chip-tag">Choose your own</span>
            </a>
          </div>
          <button
            type="button"
            className="ff-btn ff-btn--red ff-btn--block ff-btn--lg"
            disabled={!ready || busy}
            onClick={onDonate}
            aria-disabled={!ready || busy}
          >
            {busy ? "One moment…" : `Donate ${sym}${pick} ${currency} now`}
          </button>
          <p className="ff-donate-fine">{c.fineprint}</p>
        </div>
      </div>
    </section>
  );
}

// ---------- Newsletter ----------
function Newsletter() {
  const c = useContent().newsletter;
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  return (
    <section className="ff-section ff-news">
      <div className="ff-wrap ff-news-inner">
        <div>
          <h3 className="ff-h3">{c.heading}</h3>
          <p>{c.lede}</p>
        </div>
        <form className="ff-news-form" onSubmit={(e) => { e.preventDefault(); if(email) setDone(true); }}>
          {done ? (
            <div className="ff-news-done">{c.doneText}</div>
          ) : (
            <>
              <input type="email" required placeholder={c.placeholder} value={email} onChange={e=>setEmail(e.target.value)}/>
              <button className="ff-btn ff-btn--red">{c.ctaLabel}</button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}

// ---------- Footer ----------
function Footer() {
  const c = useContent().footer;
  return (
    <footer className="ff-footer">
      <div className="ff-wrap ff-footer-inner">
        <div className="ff-footer-brand">
          <img src="/assets/logo.png" alt="Farmers Fightback" />
          <p>{c.blurb}</p>
          <div className="ff-footer-social">
            {c.social.map((s, i) => (
              <a
                key={i}
                href={s.href}
                aria-label={s.label}
                target="_blank"
                rel="noopener noreferrer"
                className={`ff-footer-social-icon ff-footer-social-icon--${s.platform || s.label.toLowerCase()}`}
              >
                <span className="ff-vh">{s.label}</span>
              </a>
            ))}
          </div>
        </div>
        <div className="ff-footer-cols">
          {c.columns.map((col, i) => (
            <div key={i}>
              <h4>{col.heading}</h4>
              {col.links.map((l, j) => (
                <a key={j} href={l.href}>{l.label}</a>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="ff-footer-base">
        <div className="ff-wrap ff-footer-base-inner">
          <span>{c.legal}</span>
          {c.platform && <span>{c.platform}</span>}
        </div>
      </div>
    </footer>
  );
}

// ---------- Video modal ----------
function VideoModal({ open, onClose }) {
  const c = useContent().latestVideo;
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ff-modal" onClick={onClose}>
      <div className="ff-modal-inner" onClick={e => e.stopPropagation()}>
        <button className="ff-modal-close" onClick={onClose} aria-label="Close">×</button>
        <Placeholder label="VIDEO PLAYER · EMBED GOES HERE" ratio="16/9" tone="navy" />
        <div className="ff-modal-caption">
          <strong>{c.captionText}</strong>
          <span>{c.thumbLabel}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Shared page shell (Nav + Footer + TopBanner) ----------
function PageShell({ children, hideTopBanner, hideNav }) {
  const onDonate = () => {
    window.location.href = "/donate";
  };
  // No-distraction pages still need one escape route: a logo-only header
  // that clicks back to the homepage.
  const logoSrc = window.location.pathname.split("/").length > 2 ? "../assets/logo.png" : "assets/logo.png";
  return (
    <>
      {!hideTopBanner && <TopBanner />}
      {hideNav
        ? <a href="/" className="ff-minihead" aria-label="Farmers Fightback — back to homepage"><img src={logoSrc} alt="Farmers Fightback" /></a>
        : <Nav onDonate={onDonate} />}
      <main>{children}</main>
      <Footer />
      <SocialProofPopup />
    </>
  );
}

// ---------- Social proof popup ----------
// Bottom-right ephemeral toast that ticks over between real form-success
// events (heard via the "petition-signed" / "donation-completed" custom
// events) and a curated fallback pool so the widget stays alive on quiet
// pages. Petition variants outnumber donation variants 3:1 per the brief.
//
// Privacy: the pool is curated first names + states reflective of the
// supporter base, NOT real signer PII. Real-time petition popups use the
// in-page form's first-name input (the signer's own browser session).
const SP_INTERVAL = 60_000;            // one popup per minute on idle
const SP_VISIBLE_MS = 9_000;           // each popup auto-dismisses after 9s
const SP_NAMES = [
  "James", "Sarah", "Michael", "Emma", "David", "Jessica", "Daniel", "Olivia",
  "Matthew", "Sophie", "Andrew", "Hannah", "Liam", "Charlotte", "Tom", "Grace",
  "Ben", "Lucy", "Jack", "Chloe", "Will", "Amelia", "Sam", "Ruby", "Henry",
  "Isla", "Lachlan", "Mia", "Jacob", "Zoe", "Noah", "Ella", "Riley", "Maddie",
  "Connor", "Hayley", "Brett", "Kate", "Tim", "Anna", "Greg", "Beth", "Pete",
  "Janelle", "Marcus", "Rachel", "Adam", "Steph", "Luke", "Erin", "Brad",
  "Bec", "Mitch", "Tara", "Cam", "Nikki", "Josh", "Megan", "Ed", "Jen",
  "Patrick", "Caitlin", "Robert", "Linda", "Ian", "Helen", "Wayne", "Margaret",
  "Bruce", "Susan", "Kevin", "Trish", "Doug", "Karen", "Stuart", "Donna",
  "Glenn", "Cheryl", "Ross", "Dianne", "Craig", "Vicki", "Trevor", "Pauline",
];
const SP_STATES = [
  "NSW", "VIC", "QLD", "WA", "SA", "TAS", "NSW", "VIC", "QLD", "NSW", "VIC",
];
const SP_DONATION_AMOUNTS = [50, 65, 75, 100, 100, 135, 150, 200, 250, 265, 500, 550];
function spRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function spMakePetition(name) {
  return {
    type: "petition",
    text: `${name || spRandom(SP_NAMES)} from ${spRandom(SP_STATES)} just stood up for Aussie farmers.`,
    cta: "Join the fight today",
    href: "/take-action/hold-the-gate",
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
}
function spMakeDonation(name, amount) {
  return {
    type: "donation",
    text: `${name || spRandom(SP_NAMES)} from ${spRandom(SP_STATES)} just donated $${amount || spRandom(SP_DONATION_AMOUNTS)} to back Aussie farmers.`,
    cta: "Support the fight today",
    href: "/donate",
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
}
function spIdleNext() {
  // 3:1 petition vs donation per brief.
  return Math.random() < 0.75 ? spMakePetition() : spMakeDonation();
}
function SocialProofPopup() {
  const [item, setItem] = useState(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let dismissTimer = null;
    let idleTimer = null;

    const show = (next) => {
      // If something is already up, replace it (don't queue forever).
      if (dismissTimer) clearTimeout(dismissTimer);
      setExiting(false);
      setItem(next);
      dismissTimer = setTimeout(() => {
        setExiting(true);
        setTimeout(() => setItem(null), 350);
      }, SP_VISIBLE_MS);
    };

    const onPetitionSigned = (e) => {
      const first = (e && e.detail && e.detail.first) || null;
      show(spMakePetition(first));
    };
    const onDonationCompleted = (e) => {
      const detail = (e && e.detail) || {};
      // Only surface donations $50 and over (per brief).
      if (detail.amount && Number(detail.amount) < 50) return;
      show(spMakeDonation(detail.first, detail.amount));
    };
    const tickIdle = () => {
      // Don't override a live event-driven popup with a fallback.
      if (!document.hidden) show(spIdleNext());
      idleTimer = setTimeout(tickIdle, SP_INTERVAL);
    };

    window.addEventListener("petition-signed", onPetitionSigned);
    window.addEventListener("donation-completed", onDonationCompleted);
    // First popup appears after a short delay, not immediately on load.
    idleTimer = setTimeout(tickIdle, 8_000);
    return () => {
      window.removeEventListener("petition-signed", onPetitionSigned);
      window.removeEventListener("donation-completed", onDonationCompleted);
      clearTimeout(dismissTimer);
      clearTimeout(idleTimer);
    };
  }, []);

  // Never distract on conversion pages: donate (incl. the post-payment
  // monthly upsell, which renders on /donate) and share.
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  if (/^\/(donate|share)(\/|$|\.)/.test(path)) return null;
  if (!item) return null;
  const dismiss = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setExiting(true);
    setTimeout(() => setItem(null), 350);
  };
  return (
    <a
      href={item.href}
      className={`ff-sp ${exiting ? "ff-sp--out" : "ff-sp--in"} ff-sp--${item.type}`}
      aria-label={`${item.text} ${item.cta}`}
    >
      <span className="ff-sp-icon" aria-hidden="true">
        {item.type === "donation" ? "❤" : "✓"}
      </span>
      <span className="ff-sp-body">
        <span className="ff-sp-text">{item.text}</span>
        <span className="ff-sp-cta">{item.cta} <span aria-hidden="true">→</span></span>
      </span>
      <button
        type="button"
        className="ff-sp-close"
        aria-label="Dismiss"
        onClick={dismiss}
      >×</button>
    </a>
  );
}

// ---------- Ask Jess CTA band (homepage → /askjess) ----------
function AskJessBand() {
  const c = useContent().askjessBand;
  if (!c || c.hidden) return null;
  return (
    <section className="ff-section ff-askjess-band">
      <div className="ff-wrap ff-askjess-band-inner">
        <h2 className="ff-h2">{c.heading}</h2>
        {c.sub && <p className="ff-lede">{c.sub}</p>}
        <a href={c.href || "/askjess"} className="ff-btn ff-btn--red ff-btn--lg">{c.buttonLabel || "Send your email now"} <span aria-hidden="true">→</span></a>
      </div>
    </section>
  );
}

// ---------- HomePage (the original homepage layout) ----------
function HomePage() {
  const [modal, setModal] = useState(false);
  return (
    <>
      <TopBanner />
      <Nav onDonate={() => { window.location.href = "/donate"; }} />
      <SocialProofPopup />
      <main>
        <Hero onWatch={() => setModal(true)} />
        <IntroVideo />
        <Summary />
        <Petition />
        <AskJessBand />
        <ActionCards />
        <Quote />
        <DonateBand />
        <Newsletter />
      </main>
      <Footer />
      <VideoModal open={modal} onClose={() => setModal(false)} />
    </>
  );
}

// ---------- News page ----------
function NewsPage() {
  const c = useContent().news;
  return (
    <PageShell>
      <section className="ff-section ff-news-hero">
        <div className="ff-wrap ff-news-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-news-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      {c.instagram && <InstagramGrid cfg={c.instagram} />}
      {c.youtube && <YouTubeFeed cfg={c.youtube} />}
      {c.socials && <SocialFeeds cfg={c.socials} />}
    </PageShell>
  );
}

function InstagramGrid({ cfg }) {
  if (cfg.lightWidgetId) {
    return (
      <section className="ff-section ff-news-ig">
        <div className="ff-wrap">
          <div className="ff-news-band">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
            <p className="ff-news-band-lede">{cfg.lede}</p>
            {cfg.profileUrl && <a href={cfg.profileUrl} target="_blank" rel="noopener noreferrer" className="ff-link ff-link--red">Follow {cfg.handle} →</a>}
          </div>
          <iframe
            src={`https://cdn.lightwidget.com/widgets/${cfg.lightWidgetId}.html`}
            scrolling="no"
            allowtransparency="true"
            className="ff-ig-widget"
            style={{ width: "100%", border: 0, overflow: "hidden", minHeight: 480 }}
            title="Latest Instagram posts"
          />
        </div>
      </section>
    );
  }
  const posts = (cfg.posts || []).slice(0, 8);
  return (
    <section className="ff-section ff-news-ig">
      <div className="ff-wrap">
        <div className="ff-news-band">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
          <p className="ff-news-band-lede">{cfg.lede}</p>
          {cfg.profileUrl && <a href={cfg.profileUrl} target="_blank" rel="noopener noreferrer" className="ff-link ff-link--red">Follow {cfg.handle} →</a>}
        </div>
        <ul className="ff-ig-grid">
          {posts.map((p, i) => (
            <li key={i}>
              <a href={p.url || cfg.profileUrl} target="_blank" rel="noopener noreferrer" className="ff-ig-tile" aria-label={p.caption || `Open Instagram post ${i + 1}`}>
                <img src={p.image} alt={p.caption || ""} loading="lazy" />
                <span className="ff-ig-tile-overlay" aria-hidden="true">
                  <span className="ff-ig-tile-mark">Instagram</span>
                  {p.caption && <span className="ff-ig-tile-caption">{p.caption}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function YouTubeFeed({ cfg }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch(`/api/youtube?channelId=${encodeURIComponent(cfg.channelId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => setItems(d.items || []))
      .catch(e => setError(String(e)));
  }, [cfg.channelId]);
  return (
    <section className="ff-section ff-yt-section">
      <div className="ff-wrap">
        <div className="ff-news-band">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
          <p className="ff-news-band-lede">{cfg.lede}</p>
          <a href={cfg.url} target="_blank" rel="noopener noreferrer" className="ff-link ff-link--red">Visit channel →</a>
        </div>
        {!items && !error && <p className="ff-news-empty">Loading latest videos…</p>}
        {error && (
          <p className="ff-news-empty">
            Couldn't load the live YouTube feed right now. <a href={cfg.url} target="_blank" rel="noopener noreferrer">Open the channel directly →</a>
          </p>
        )}
        {items && items.length > 0 && (
          <div className="ff-yt-grid">
            {items.slice(0, 9).map((v, i) => (
              <a key={i} href={v.link} target="_blank" rel="noopener noreferrer" className="ff-yt-card" aria-label={`Watch on YouTube: ${v.title}`}>
                <div className="ff-yt-card-media">
                  <img src={v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`} alt="" loading="lazy" />
                  <span className="ff-yt-play" aria-hidden="true">▶</span>
                </div>
                <div className="ff-yt-card-body">
                  {v.published && <span className="ff-card-kicker">{formatDate(v.published)}</span>}
                  <h3 className="ff-yt-card-title">{v.title}</h3>
                  <span className="ff-yt-card-cta">Watch on YouTube <span aria-hidden="true">→</span></span>
                </div>
              </a>
            ))}
          </div>
        )}
        {items && items.length === 0 && (
          <p className="ff-news-empty">
            No videos to show right now. <a href={cfg.url} target="_blank" rel="noopener noreferrer">Open the channel on YouTube →</a>
          </p>
        )}
      </div>
    </section>
  );
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  } catch { return ""; }
}

function NewsletterSection({ cfg }) {
  return (
    <section className="ff-section ff-news-letters">
      <div className="ff-wrap">
        <div className="ff-news-band">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
          <p className="ff-news-band-lede">{cfg.lede}</p>
          {cfg.subscribeUrl && <a href={cfg.subscribeUrl} className="ff-link ff-link--red">Subscribe →</a>}
        </div>
        <ul className="ff-letter-list">
          {(cfg.items || []).map((it, i) => (
            <li key={i} className="ff-letter-item">
              <span className="ff-letter-date">{formatDate(it.date)}</span>
              <a href={it.url || "#"} className="ff-letter-link">
                <span className="ff-letter-title">{it.title}</span>
                {it.excerpt && <span className="ff-letter-excerpt">{it.excerpt}</span>}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SocialFeeds({ cfg }) {
  return (
    <section className="ff-section ff-news-socials">
      <div className="ff-wrap">
        <div className="ff-news-band">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
          <p className="ff-news-band-lede">{cfg.lede}</p>
        </div>
        <ul className="ff-socials-grid">
          {(cfg.accounts || []).map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className={`ff-social-card ff-social-card--${s.platform}`}>
                <span className="ff-social-platform">{s.platform}</span>
                <span className="ff-social-handle">{s.handle}</span>
                <span className="ff-social-cta">Open →</span>
              </a>
            </li>
          ))}
        </ul>
        {cfg.embed && cfg.embed.kind === "tiktok" && (
          <div className="ff-social-embed">
            <blockquote className="tiktok-embed" cite={`https://www.tiktok.com/@${cfg.embed.username}`} data-unique-id={cfg.embed.username}>
              <a href={`https://www.tiktok.com/@${cfg.embed.username}`}>@{cfg.embed.username}</a>
            </blockquote>
            <script async src="https://www.tiktok.com/embed.js"></script>
          </div>
        )}
      </div>
    </section>
  );
}

function PressList({ cfg }) {
  return (
    <section className="ff-section ff-news-press">
      <div className="ff-wrap">
        <div className="ff-news-band">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {cfg.heading}</span>
          <p className="ff-news-band-lede">{cfg.lede}</p>
        </div>
        <ul className="ff-press-list">
          {(cfg.items || []).map((it, i) => (
            <li key={i} className="ff-press-item">
              <span className="ff-press-outlet">{it.outlet}</span>
              <a href={it.url || "#"} className="ff-press-headline">{it.headline}</a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- Take Action index ----------
function TakeActionIndex() {
  const c = useContent().takeAction;
  return (
    <PageShell>
      <section className="ff-section ff-takeaction-hero">
        <div className="ff-wrap ff-takeaction-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-takeaction-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      <section className="ff-section ff-takeaction-grid-wrap">
        <div className="ff-wrap">
          <div className="ff-takeaction-grid">
            {(c.campaigns || []).map((cm, i) => (
              <a key={i} href={`/take-action/${cm.slug}`} className={`ff-takeaction-card ff-takeaction-card--${cm.tone || "navy"}`}>
                <span className="ff-card-kicker">{cm.kicker}</span>
                <h3 className="ff-takeaction-card-title">{cm.title}</h3>
                <p>{cm.summary}</p>
                <span className="ff-takeaction-card-cta">{cm.cta} <span aria-hidden="true">→</span></span>
              </a>
            ))}
          </div>
          {c.trustBadges && (
            <ul className="ff-trust-row">
              {c.trustBadges.map((b, i) => (
                <li key={i} className="ff-trust-badge">
                  <span className={`ff-trust-icon ff-trust-icon--${b.icon}`} aria-hidden="true" />
                  <span>{b.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Petition page (parameterized by slug) ----------
function shareUrlFor(platform, text, url, subject) {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  switch (platform) {
    case "facebook": return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case "x":        return `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
    case "linkedin": return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    case "whatsapp": return `https://wa.me/?text=${t}%20${u}`;
    case "telegram": return `https://t.me/share/url?url=${u}&text=${t}`;
    case "sms":      return `sms:?&body=${encodeURIComponent(text + " " + url)}`;
    case "email":    return `mailto:?subject=${encodeURIComponent(subject || "Sign the petition")}&body=${t}%0A%0A${u}`;
    default: return null;
  }
}

// ---------- Baldwin Defence (V1 · Floodlight) ----------
// Self-contained themed page (deep navy + hi-vis yellow) — does NOT inherit
// site styles. Renders only when petition slug === "baldwins".
// Locked, lawyer-reviewed copy — see /design_handoff_baldwin_campaign/README.md.
function BaldwinFloodlight({ p, receiverUrl }) {
  const C = {
    navy: "#0E2940", navyDeep: "#081826",
    bone: "#F5F1E8", boneDim: "#D9D3C5",
    yellow: "#F4C430", yellowDeep: "#E0AE1F",
    rule: "rgba(245,241,232,0.18)",
    mute: "rgba(245,241,232,0.62)",
  };
  const fonts = {
    display: '"Archivo Narrow", "Oswald", "Bebas Neue", Impact, sans-serif',
    sans: '"Inter", "Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif',
    mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
  };

  // Daily-incrementing counter: deterministic per-day pseudo-random bump
  // so the number rises each day but stays the same for everyone visiting
  // on the same date.
  const dailyCount = (() => {
    const base = p.currentCount || 12019;
    const baselineYmd = p.currentCountAsOf || "2026-05-20"; // date the base value was set
    const toEpochDays = (s) => {
      const [y, m, d] = s.split("-").map(Number);
      return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    };
    const today = new Date();
    const todayDays = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86400000);
    const days = Math.max(0, todayDays - toEpochDays(baselineYmd));
    // Seeded LCG so each day gets the same pseudo-random increment.
    let total = base;
    for (let i = 0; i < days; i++) {
      const seed = (todayDays - days + i + 1) * 2654435761 >>> 0;
      const bump = 18 + (seed % 47); // 18..64 new signatures per day
      total += bump;
    }
    return total;
  })();
  const [count, setCount] = useState(dailyCount);
  const [navOpen, setNavOpen] = useState(false);

  // When arriving with a URL hash (e.g. /defend → /take-action/baldwins#donate),
  // wait for the target section to mount, then scroll to it.
  useEffect(() => {
    const id = (window.location.hash || "").replace(/^#/, "");
    if (!id) return;
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (++tries < 40) setTimeout(tick, 75);
    };
    tick();
  }, []);

  // After a Baldwin donation Stripe click, when the user returns to this
  // page (tab regains focus or component re-mounts after redirect) scroll
  // them to the next-step action grid.
  useEffect(() => {
    const KEY = "ff_baldwin_donate_pending";
    const tryScroll = () => {
      let stamp = 0;
      try { stamp = Number(sessionStorage.getItem(KEY)) || 0; } catch {}
      if (!stamp || Date.now() - stamp > 30 * 60 * 1000) return;
      try { sessionStorage.removeItem(KEY); } catch {}
      requestAnimationFrame(() => {
        document.getElementById("actions")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };
    tryScroll();
    const onVis = () => { if (document.visibilityState === "visible") tryScroll(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", tryScroll);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", tryScroll);
    };
  }, []);
  const markDonatePending = (amount) => {
    try { sessionStorage.setItem("ff_baldwin_donate_pending", String(Date.now())); } catch {}
    sendCAPI("InitiateCheckout", {}, { value: amount || 0, currency: "AUD", content_name: "Baldwin Donation" });
  };

  // Form state — wires the SIGN action below the action grid
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "" });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle");
  const update = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [k]: v }));
  };
  const submit = async (ev) => {
    ev.preventDefault();
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (form.phone.trim() && !/^[+\d][\d\s\-()]{6,}$/.test(form.phone.trim())) e.phone = "Enter a valid mobile";
    if (form.postcode && !/^\d{4}$/.test(form.postcode)) e.postcode = "4-digit postcode";
    setErrors(e);
    if (Object.keys(e).length) return;
    setState("submitting");
    try {
      await signPetition({
        first_name: form.first.trim(),
        last_name: form.last.trim(),
        email: form.email.trim(),
        mobile: form.phone.trim(),
        postcode: form.postcode.trim(),
        content_name: "Baldwin Petition",
        receiverUrl,
        country: "au",
        extraReceiverFields: {
          campaign: p.campaign || "Farmer Fightback: Baldwin Campaign",
          form_slug: p.formSlug || "ff-baldwin",
        },
      });
      setState("done");
      requestAnimationFrame(() => {
        document.getElementById("donate")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch { setState("error"); }
  };

  // Locked copy. <em> tags inside titleHtml render yellow (see <style> below).
  const acts = [
    { n: "01", date: "2023 → 2025", tag: "BACKSTORY",
      titleHtml: "<em>A community family targeted.</em> For three years.",
      body: "From 2023 onwards the Baldwins kept their heads down — running their farm, supporting their community, doing the work. Greg became one of the most visible spokespeople against VNI West: at meetings, on tractors, on the steps of Parliament. Through it all, contractors for the Transmission Company Victoria (TCV) — later rebadged as VicGrid VNI West — kept turning up on Baldwin land. Refused. Turned away. Came back." },
    { n: "02", date: "13 NOV 2025", tag: "TRESPASS",
      titleHtml: "Greg called triple zero <em>on his own farm</em>.",
      body: "TCV contractors entered the Baldwin property in western Victoria. They had been served previous refusals, written notice, and a 48-hour access notice the family had not consented to. Greg called 000. Neighbours arrived. The contractors left." },
    { n: "03", date: "DEC 2025", tag: "LICENCE PULLED",
      titleHtml: "Their firearms licence was suspended <em>four months before charges were laid</em>.",
      body: "Police authorised the suspension of the family's firearms licence in December 2025 — based on charges that did not yet exist. The charges were not formally laid until the following March. A working farm without firearms is a working farm exposed. The lawyer reviewing the brief later confirmed: the suspension was a pre-emptive move." },
    { n: "04", date: "NOV 2025 — MAR 2026", tag: "THE CHARGES",
      titleHtml: "Police did not charge the trespassers. <em>They charged the farmer.</em>",
      body: "Greg was charged with unlawful imprisonment for refusing trespassers on his own land. He was ordered to present at Rupanyup Police Station, where he was arrested, fingerprinted, and processed like a criminal." },
    { n: "05", date: "27 APR 2026", tag: "DPP WITHDRAWS", highlight: true,
      titleHtml: "The DPP withdrew every charge. There was no case.",
      body: "In the Magistrates' Court, the Director of Public Prosecutions withdrew every charge against Greg Baldwin. No conviction. No trial. No basis. The Crown said in plain language what the family had said all along: there was no case to answer." },
    { n: "06", date: "16 MAR 2026", tag: "FORCED ACCESS",
      titleHtml: "The same tactics. Against new farming families.",
      body: "The same week the family was in court, VicGrid posted letters to multiple western Victorian properties advising they would use new powers under amended Victorian energy legislation to FORCE access in 30 days. Same project. Same villains. Different vehicle." },
    { n: "07", tag: "TAKE ACTION", cta: true,
      titleHtml: "End this injustice now. <em>Sign the petition today.</em>",
      ctaLabel: "Sign the petition today →", ctaHref: "#sign" },
  ];
  const pillars = [
    "A farmer rang triple zero. They charged the farmer.",
    "The court agreed. The DPP withdrew. There was no case.",
    "Same Minister. New law. Same farms. 30 days.",
    "We are not victims. We are landholders. Resign.",
  ];
  const actions = [
    { n: "01", t: "Sign the petition",   d: "Add your name to the call for the Minister to resign. Farmers Fightback-endorsed. Delivered to Spring St.", cta: "SIGN",   primary: true,  href: "#sign" },
    { n: "02", t: "Email the Minister",  d: "Pre-written letter, your name on it. Sent to the Minister's office and your local MP in two clicks.",       cta: "EMAIL",  href: "mailto:lily.dambrosio@parliament.vic.gov.au?subject=Resign%2C%20Minister&body=Dear%20Minister%20Dambrosio%2C%0A%0AThe%20DPP%20has%20withdrawn%20every%20charge%20against%20Greg%20Baldwin.%20There%20was%20no%20case.%20I%20am%20writing%20to%20demand%20your%20resignation%2C%20a%20review%20of%20Vic%20Police%20and%20OPP%20conduct%2C%20and%20suspension%20of%20forced-access%20powers%20under%20the%20amended%20energy%20legislation.%0A%0AYours%2C%0A" },
    { n: "03", t: "Donate to defence",   d: "Recovery of legal costs and prep for civil action. Every dollar receipted by the Baldwin family solicitor.", cta: "DONATE", href: "#donate" },
  ];

  // Inline keyframes + responsive collapse, scoped via class names
  const css = `
    @keyframes v1pan { 0%{background-position:0 0,0 0} 100%{background-position:0 0,200px 0} }
    @keyframes v1blink { 50%{opacity:.4} }
    .fl-root { background: ${C.navy}; color: ${C.bone}; font-family: ${fonts.sans}; min-height: 100vh; }
    .fl-root a { color: inherit; text-decoration: none; }
    .fl-root *, .fl-root *::before, .fl-root *::after { box-sizing: border-box; }
    .fl-pad { padding-left: 56px; padding-right: 56px; }
    .fl-h1 { font: 900 84px/0.96 ${fonts.display}; letter-spacing: -0.012em; text-transform: uppercase; margin: 18px 0 0; }
    .fl-h2 { font: 900 80px/0.95 ${fonts.display}; letter-spacing: -0.01em; text-transform: uppercase; margin: 0; }
    .fl-h2--sm { font-size: 60px; line-height: 1; }
    .fl-act-title em { color: ${C.yellow}; font-style: normal; }
    .fl-grid-hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 56px; align-items: end; }
    .fl-grid-demand { display: grid; grid-template-columns: 0.6fr 1fr; gap: 56px; }
    .fl-grid-counter { display: grid; grid-template-columns: 1fr 0.8fr; gap: 64px; align-items: end; }
    .fl-grid-timeline { display: grid; grid-template-columns: 180px 1fr; column-gap: 48px; position: relative; }
    .fl-grid-pillars { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0; border: 1px solid ${C.rule}; }
    .fl-grid-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; border: 1px solid ${C.rule}; }
    .fl-grid-footer { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 32px; }

    /* Donate tiles — base + default ($135) + hover swap.
       Default highlight on $135. When the grid is hovered, the default
       loses its highlight unless it's also the one being hovered, so
       the visual focus follows the cursor. The "Other" tile is always
       yellow and is unaffected by these rules. */
    .fl-donate-tile { background: transparent; color: ${C.bone}; }
    .fl-donate-tile .fl-tile-kicker { color: ${C.yellow}; }
    .fl-donate-tile .fl-tile-amount { color: ${C.bone}; }
    .fl-donate-tile .fl-tile-cta { color: ${C.bone}; }
    .fl-donate-tile.is-default,
    .fl-donate-tile:hover {
      background: ${C.yellow}; color: ${C.navyDeep};
    }
    .fl-donate-tile.is-default .fl-tile-kicker,
    .fl-donate-tile:hover .fl-tile-kicker { color: ${C.navyDeep}; opacity: .7; }
    .fl-donate-tile.is-default .fl-tile-amount,
    .fl-donate-tile:hover .fl-tile-amount { color: ${C.navyDeep}; }
    .fl-donate-tile.is-default .fl-tile-cta,
    .fl-donate-tile:hover .fl-tile-cta { color: ${C.navyDeep}; }
    .fl-donate-grid:hover .fl-donate-tile.is-default:not(:hover) {
      background: transparent; color: ${C.bone};
    }
    .fl-donate-grid:hover .fl-donate-tile.is-default:not(:hover) .fl-tile-kicker { color: ${C.yellow}; opacity: 1; }
    .fl-donate-grid:hover .fl-donate-tile.is-default:not(:hover) .fl-tile-amount { color: ${C.bone}; }
    .fl-donate-grid:hover .fl-donate-tile.is-default:not(:hover) .fl-tile-cta { color: ${C.bone}; }

    /* Nav — hamburger hidden by default (shown only on mobile) */
    .fl-nav-links { display: flex; gap: 28px; }
    .fl-burger { display: none; background: transparent; border: 0; padding: 8px; cursor: pointer; }
    .fl-burger span { display: block; width: 26px; height: 2.5px; background: ${C.bone}; margin: 5px 0; transition: transform .2s ease, opacity .2s ease; }
    .fl-burger.is-open span:nth-child(1) { transform: translateY(7.5px) rotate(45deg); }
    .fl-burger.is-open span:nth-child(2) { opacity: 0; }
    .fl-burger.is-open span:nth-child(3) { transform: translateY(-7.5px) rotate(-45deg); }
    .fl-mobilenav { display: none; background: ${C.navyDeep}; border-bottom: 1px solid ${C.rule}; padding: 8px 20px 18px; }
    .fl-mobilenav a { display: block; padding: 14px 4px; font: 700 14px/1 ${fonts.mono}; letter-spacing: .14em; text-transform: uppercase; color: ${C.bone}; border-bottom: 1px solid ${C.rule}; }
    .fl-mobilenav a:last-child { border-bottom: 0; }
    .fl-mobilenav .is-primary { color: ${C.yellow}; }

    @media (max-width: 1199px) {
      .fl-grid-hero, .fl-grid-demand, .fl-grid-counter { grid-template-columns: 1fr; gap: 32px; }
      .fl-h1 { font-size: 64px; }
    }
    @media (max-width: 899px) {
      .fl-grid-actions { grid-template-columns: repeat(2, 1fr); }
      .fl-grid-pillars { grid-template-columns: 1fr; }
      .fl-grid-footer { grid-template-columns: 1fr 1fr; }
      .fl-grid-timeline { grid-template-columns: 1fr; }
      .fl-rail { display: none !important; }
      .fl-date-col { text-align: left !important; padding-bottom: 8px !important; padding-right: 0 !important; }
    }

    /* ─── Mobile (< 720px): hamburger nav, no kicker, reordered hero ─── */
    @media (max-width: 719px) {
      .fl-pad { padding-left: 20px; padding-right: 20px; }
      .fl-h1 { font-size: clamp(34px, 9vw, 46px); line-height: 0.98; margin-top: 0; }
      .fl-h2 { font-size: clamp(36px, 10vw, 52px); }
      .fl-h2--sm { font-size: clamp(32px, 9vw, 44px); }
      .fl-grid-actions, .fl-grid-footer { grid-template-columns: 1fr; }

      /* Hide the yellow update kicker strip on mobile */
      .fl-kicker { display: none !important; }

      /* Show hamburger; hide the inline desktop nav links */
      .fl-nav-links { display: none; }
      .fl-burger { display: inline-block; }
      .fl-nav-wrap { padding: 14px 20px !important; }
      .fl-logo img { height: 30px !important; }
      .fl-mobilenav.is-open { display: block; }

      /* Hero — flex column so we can reorder on mobile.
         Order: H1 → form → body → demand → CTAs (sign block is now in reach). */
      .fl-hero {
        display: flex; flex-direction: column;
        padding: 28px 20px 36px !important; gap: 0;
        background-image: linear-gradient(to bottom, rgba(14,41,64,0.78) 0%, rgba(14,41,64,0.9) 60%, ${C.navy} 100%), url(/assets/uploads/fight-police-farmers.jpg) !important;
        background-position: center top, center top !important;
        background-size: cover, cover !important;
      }
      .fl-hero-headline { order: 1; margin: 0 0 16px; }
      .fl-hero-body     { order: 2; margin: 0 0 8px !important; }
      .fl-hero-body p   { font-size: 17px !important; line-height: 1.35 !important; }
      .fl-hero-body p + p { margin-top: 14px !important; }
      .fl-hero-body-cta { display: none !important; }
      .fl-hero-form     { order: 3; margin: 0 0 24px !important; max-width: none !important; }
      .fl-hero-demand   { order: 4; margin: 0 0 28px !important; max-width: none !important; }
      .fl-hero-ctas     { order: 5; margin: 0 !important; }
      .fl-hero-ctas a, .fl-hero-ctas button { width: 100%; justify-content: space-between; }

      /* Section vertical rhythm — tighter on mobile */
      .fl-section-mob { padding-top: 56px !important; padding-bottom: 56px !important; }
      .fl-anchor-mob  { padding-top: 56px !important; padding-bottom: 56px !important; }

      /* Counter — smaller heading number */
      .fl-counter-num { font-size: 64px !important; }

      /* Timeline — tighter dot offsets when rail is gone */
      .fl-date-col { padding-bottom: 6px !important; }

      /* Watch Greg eyebrow row — single column */
      .fl-watchgreg-head { flex-direction: column !important; align-items: flex-start !important; gap: 6px !important; }

      /* Donate grid — 2 columns on mobile, Other full-width */
      .fl-donate { padding: 56px 20px !important; }
      .fl-donate-grid { grid-template-columns: 1fr 1fr !important; }
      .fl-donate-tile { min-height: 130px !important; padding: 22px 18px !important; }
      .fl-donate-tile { border-right: 1px solid ${C.rule} !important; border-bottom: 1px solid ${C.rule} !important; }
      .fl-donate-tile:nth-child(2n) { border-right: none !important; }
      .fl-donate-tile--other { grid-column: span 2 !important; border-right: none !important; border-bottom: none !important; }

      /* Sections after timeline — tighter padding */
      .fl-section-aft { padding-top: 48px !important; padding-bottom: 48px !important; }
      .fl-action-cell { min-height: auto !important; padding: 24px 20px !important; }
      .fl-action-cell .fl-action-title { font-size: 24px !important; }
      .fl-share-row a { width: 100%; justify-content: space-between; }
      .fl-photo-band { padding: 0 20px 56px !important; }
      .fl-photo-band > div { height: 240px !important; }
      .fl-footer { padding: 40px 20px 48px !important; }
    }
    @media (max-width: 380px) {
      .fl-donate-grid { grid-template-columns: 1fr !important; }
      .fl-donate-tile { border-right: none !important; }
      .fl-donate-tile--other { grid-column: auto !important; }
    }
  `;

  const Eyebrow = ({ children, color = C.yellow }) => (
    <div style={{ font: `700 12px/1 ${fonts.mono}`, color, letterSpacing: ".18em", textTransform: "uppercase" }}>{children}</div>
  );

  const Btn = ({ children, primary, mono, href, type, onClick, disabled, fullWidth }) => {
    const props = {
      style: {
        appearance: "none", border: "none", cursor: disabled ? "not-allowed" : "pointer",
        background: primary ? C.yellow : "transparent",
        color: primary ? C.navyDeep : C.bone,
        font: `800 ${mono ? 13 : 16}px/1 ${mono ? fonts.mono : fonts.sans}`,
        letterSpacing: mono ? ".14em" : ".02em",
        textTransform: mono ? "uppercase" : "none",
        padding: primary ? "20px 28px" : "18px 24px",
        boxShadow: primary ? "none" : `inset 0 0 0 1.5px ${C.bone}`,
        display: "inline-flex", alignItems: "center", gap: 12, textAlign: "left",
        opacity: disabled ? 0.6 : 1, width: fullWidth ? "100%" : undefined, justifyContent: fullWidth ? "center" : undefined,
      },
      onClick, type,
    };
    if (href) return <a {...props} href={href}>{children}<span style={{ fontSize: 18 }}>→</span></a>;
    return <button {...props} disabled={disabled}>{children}<span style={{ fontSize: 18 }}>→</span></button>;
  };

  const Rule = () => <div style={{ height: 1, background: C.rule, width: "100%" }} />;

  const VideoSlot = () => (
    <div style={{
      position: "relative", width: "100%", aspectRatio: "16/9",
      background: C.navyDeep, overflow: "hidden", border: `1px solid ${C.rule}`,
    }}>
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse at 30% 60%, rgba(244,196,48,0.12) 0%, transparent 55%), repeating-linear-gradient(98deg, rgba(245,241,232,.03) 0 22px, rgba(245,241,232,.06) 22px 44px)`,
        animation: "v1pan 22s linear infinite",
      }} />
      <div style={{
        position: "absolute", top: 18, left: 20, display: "flex", alignItems: "center", gap: 10,
        font: `600 11px/1 ${fonts.mono}`, letterSpacing: ".14em", color: C.bone, textTransform: "uppercase",
      }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: C.yellow, animation: "v1blink 1.4s infinite" }} />
        LIVE · GREG BALDWIN · ON HIS LAND
      </div>
      <div style={{
        position: "absolute", bottom: 20, left: 20, right: 20, display: "flex",
        justifyContent: "space-between", alignItems: "flex-end",
        font: `500 11px/1 ${fonts.mono}`, color: C.mute, letterSpacing: ".12em", textTransform: "uppercase",
      }}>
        <span>00:00 / 03:42 — MUTED</span>
        <span>WESTERN VIC · MAY 2026</span>
      </div>
      <div style={{
        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
        width: 86, height: 86, borderRadius: 86, border: `2px solid ${C.yellow}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(14,41,64,0.7)",
      }}>
        <div style={{ width: 0, height: 0, borderLeft: `22px solid ${C.yellow}`, borderTop: "14px solid transparent", borderBottom: "14px solid transparent", marginLeft: 6 }} />
      </div>
    </div>
  );

  const PhotoSlot = ({ label, h = 420 }) => (
    <div style={{
      width: "100%", height: h,
      background: `repeating-linear-gradient(135deg, rgba(245,241,232,.04) 0 14px, rgba(245,241,232,.07) 14px 28px), ${C.navyDeep}`,
      border: `1px solid ${C.rule}`, position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{ position: "absolute", top: 14, left: 14, font: `500 11px/1 ${fonts.mono}`, letterSpacing: ".08em", color: C.yellow, textTransform: "uppercase" }}>◉ PHOTO</div>
      <div style={{ font: `500 12px/1.5 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".14em", textAlign: "center", maxWidth: "60%" }}>{label}</div>
    </div>
  );

  // Sign form block — used in the hero (top of page) so the CTA is the
  // first thing in reach. Same submit handler / receiver as before.
  const signFormBlock = state === "done" ? (
    <div id="sign" style={{ background: C.yellow, color: C.navyDeep, padding: "40px 36px", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 14 }}>
      <div style={{ font: `700 12px/1 ${fonts.mono}`, letterSpacing: ".18em", textTransform: "uppercase" }}>Signed · Thank you</div>
      <h3 style={{ margin: 0, font: `900 56px/0.95 ${fonts.display}`, textTransform: "uppercase" }}>You're {(count + 1).toLocaleString("en-AU")}.</h3>
      <p style={{ margin: 0, font: `400 16px/1.55 ${fonts.sans}` }}>Now share the petition. Every signature strengthens the handover at Spring St.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
        <a href="#share" style={{ background: C.navyDeep, color: C.yellow, padding: "16px 22px", font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>SHARE →</a>
        <a href="/#donate" style={{ background: "transparent", color: C.navyDeep, padding: "16px 22px", boxShadow: `inset 0 0 0 2px ${C.navyDeep}`, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>DONATE →</a>
      </div>
    </div>
  ) : (
    <form id="sign" onSubmit={submit} style={{ background: C.navyDeep, border: `1px solid ${C.rule}`, padding: "36px 32px" }}>
      <Eyebrow>Sign · Petition</Eyebrow>
      <h3 style={{ margin: "14px 0 22px", font: `900 40px/1 ${fonts.display}`, textTransform: "uppercase" }}>Add your name. <span style={{ color: C.yellow }}>Now.</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {[
          { k: "first", label: "First name *", auto: "given-name", required: true },
          { k: "last",  label: "Last name *",  auto: "family-name", required: true },
        ].map(f => (
          <label key={f.k} style={{ display: "block" }}>
            <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>{f.label}{errors[f.k] && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors[f.k]}</em>}</span>
            <input value={form[f.k]} onChange={update(f.k)} autoComplete={f.auto} required={f.required} aria-required={f.required} style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors[f.k] ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Email *{errors.email && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors.email}</em>}</span>
          <input type="email" value={form.email} onChange={update("email")} onBlur={() => sendPartial("petition", form)} autoComplete="email" required aria-required="true" style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors.email ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 12, marginTop: 12 }}>
        <label>
          <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Mobile{errors.phone && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors.phone}</em>}</span>
          <input type="tel" value={form.phone} onChange={update("phone")} onBlur={() => sendPartial("petition", form)} autoComplete="tel" inputMode="tel" placeholder="0400 000 000" style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors.phone ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
        </label>
        <label>
          <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Postcode{errors.postcode && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors.postcode}</em>}</span>
          <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4} autoComplete="postal-code" style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors.postcode ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
        </label>
      </div>
      <div style={{ marginTop: 22, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Btn primary mono type="submit" disabled={state === "submitting"} fullWidth>{state === "submitting" ? "Signing…" : "Sign the petition"}</Btn>
        {state === "error" && <span style={{ color: C.yellow, font: `500 13px/1.4 ${fonts.mono}` }}>Something went wrong. Try again.</span>}
      </div>
      <div style={{ marginTop: 14, color: C.mute, font: `500 11px/1.4 ${fonts.mono}`, letterSpacing: ".12em", textTransform: "uppercase" }}>Authorised by Ben Duxson, Farmers Fightback</div>
    </form>
  );

  return (
    <>
      <style>{css}</style>
      <div className="fl-root">
        {/* NAV */}
        <div className="fl-nav-wrap fl-pad" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 56px", borderBottom: `1px solid ${C.rule}` }}>
          <a href="/" className="fl-logo" style={{ display: "flex", alignItems: "center" }} aria-label="Farmers Fightback home">
            <img
              src="/assets/logo.png"
              alt="Farmers Fightback"
              style={{ height: 38, width: "auto", display: "block", filter: "brightness(0) invert(1)" }}
            />
          </a>
          <div className="fl-nav-links" style={{ font: `600 12px/1 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".14em", flexWrap: "wrap" }}>
            <a href="#story">The Story</a>
            <a href="#demand">The Demand</a>
            <a href="#donate">Donate</a>
            <span style={{ color: C.yellow }}>● BALDWIN DEFENCE</span>
          </div>
          <button
            type="button"
            className={`fl-burger ${navOpen ? "is-open" : ""}`}
            aria-label="Open menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(v => !v)}
          >
            <span /><span /><span />
          </button>
        </div>

        {/* MOBILE MENU (only shown on mobile via CSS) */}
        <div className={`fl-mobilenav ${navOpen ? "is-open" : ""}`}>
          <a href="#sign" className="is-primary" onClick={() => setNavOpen(false)}>● Sign the petition</a>
          <a href="#story" onClick={() => setNavOpen(false)}>The Story</a>
          <a href="#demand" onClick={() => setNavOpen(false)}>The Demand</a>
          <a href="#donate" onClick={() => setNavOpen(false)}>Donate</a>
        </div>

        {/* KICKER STRIP */}
        <div className="fl-kicker" style={{ background: C.yellow, color: C.navyDeep, padding: "10px 56px", display: "flex", justifyContent: "space-between", font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".18em", textTransform: "uppercase" }}>
          <span>● UPDATED 07 MAY 2026 · 18:42 AEST</span>
          <span>CHARGES DROPPED · THE MINISTER MUST RESIGN</span>
          <span>SHARE → #ResignMinister · #ChargesDropped</span>
        </div>

        {/* HERO */}
        <div
          className="fl-hero fl-pad"
          style={{
            paddingTop: 64, paddingBottom: 48,
            position: "relative",
            backgroundImage: `linear-gradient(to right, ${C.navy} 0%, ${C.navy} 35%, rgba(14,41,64,0.85) 55%, rgba(14,41,64,0.55) 80%, rgba(14,41,64,0.35) 100%), url(/assets/uploads/fight-police-farmers.jpg)`,
            backgroundSize: "cover, cover",
            backgroundRepeat: "no-repeat, no-repeat",
            backgroundPosition: "center, center right",
          }}
        >
          <h1 className="fl-h1 fl-hero-headline" style={{ position: "relative", zIndex: 1 }}>
            <span style={{ color: C.yellow }}>Baseless<br/>charges dropped.</span><br/>
            Minister<br/>
            must resign.
          </h1>
          <div className="fl-hero-body" style={{ margin: "36px 0 0", maxWidth: 720 }}>
            <p style={{ margin: 0, font: `400 19px/1.4 ${fonts.sans}`, color: C.bone }}>
              A hard-working family, farming the land since 1880, the Baldwins just want to keep their home.
            </p>
            <p className="fl-hero-body-cta" style={{ margin: "18px 0 0", font: `700 clamp(20px, 2.2vw, 24px)/1.25 ${fonts.sans}`, color: C.yellow, letterSpacing: "-0.005em" }}>
              FIRST THE BALDWIN'S HOME, YOURS NEXT: Sign the petition today!
            </p>
          </div>

          {/* DEMAND — pulled into the hero above the form */}
          <div id="demand" className="fl-hero-demand" style={{ marginTop: 56, maxWidth: 820 }}>
            <h2 className="fl-h2 fl-h2--sm">
              Resign. Investigate. <span style={{ color: C.yellow }}>Repeal.</span>
            </h2>
            <ol style={{ margin: "28px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 18, font: `500 18px/1.55 ${fonts.sans}`, color: C.bone }}>
              {[
                ["01.", "Lily Dambrosio, Minister for Energy and Resources must resign immediately."],
                ["02.", "An independent review of VicGrid's conduct & trespass in the Baldwin matter."],
                ["03.", "Immediate repeal of the forced-access powers in Victoria's energy legislation."],
              ].map(([n, t]) => (
                <li key={n} style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, alignItems: "baseline" }}>
                  <span style={{ font: `800 22px/1 ${fonts.mono}`, color: C.yellow }}>{n}</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="fl-hero-form" style={{ marginTop: 48, maxWidth: 720 }}>
            {signFormBlock}
          </div>
        </div>

        <Rule />

        {/* COUNTER STRIP */}
        <div className="fl-pad" style={{ paddingTop: 56, paddingBottom: 64 }}>
          <div className="fl-grid-counter">
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
              <div className="fl-counter-num" style={{ font: `900 96px/0.9 ${fonts.display}`, color: C.yellow, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{count.toLocaleString("en-AU")}</div>
              <div style={{ font: `600 14px/1.4 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".12em" }}>signatures<br/>demanding the Minister resign</div>
            </div>
            <div>
              <Eyebrow>Goal · {(p.goal || 25000).toLocaleString("en-AU")}</Eyebrow>
              <div style={{ position: "relative", height: 18, background: "rgba(245,241,232,0.08)", marginTop: 14, overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, (count / (p.goal || 25000)) * 100).toFixed(1)}%`, background: C.yellow, transition: "width .3s ease" }} />
                <div style={{ position: "absolute", right: -2, top: -10, bottom: -10, width: 2, background: C.bone }} />
              </div>
              <div style={{ font: `500 12px/1.5 ${fonts.mono}`, color: C.mute, marginTop: 12, textTransform: "uppercase", letterSpacing: ".12em" }}>
                {Math.max(0, (p.goal || 25000) - count).toLocaleString("en-AU")} signatures to go · handover at Spring St when we hit goal.
              </div>
            </div>
          </div>
        </div>

        <Rule />

        {/* HEADLINE ANCHOR */}
        <div className="fl-pad" style={{ paddingTop: 96, paddingBottom: 96, background: C.navyDeep, textAlign: "center" }}>
          <h2 className="fl-h2" style={{ fontSize: "clamp(56px, 8vw, 120px)", lineHeight: 0.95, margin: 0 }}>
            <span style={{ color: C.yellow }}>Refusal</span> criminalised.
          </h2>
          <p style={{ margin: "36px auto 0", maxWidth: 1000, font: `600 clamp(28px, 4vw, 44px)/1.2 ${fonts.sans}`, color: C.bone, letterSpacing: "-0.01em" }}>
            First the Baldwin's home. <span style={{ color: C.yellow }}>Yours next.</span>
          </p>
        </div>

        <Rule />

        {/* STORY TIMELINE */}
        <div id="story" className="fl-pad" style={{ paddingTop: 88, paddingBottom: 64 }}>
          <Eyebrow>The Story · One Page</Eyebrow>
          <h2 className="fl-h2" style={{ marginTop: 20, maxWidth: 980 }}>From Triple Zero to <span style={{ color: C.yellow }}>Charges Dropped</span>.</h2>
          <div className="fl-grid-timeline" style={{ marginTop: 64 }}>
            <div className="fl-rail" style={{ position: "absolute", left: 220, top: 0, bottom: 0, width: 2, background: C.rule }} />
            {acts.map((a, i) => (
              <React.Fragment key={a.n}>
                <div className="fl-date-col" style={{ paddingTop: 8, textAlign: "right", paddingRight: 24, font: `700 13px/1.4 ${fonts.mono}`, color: a.highlight ? C.yellow : C.bone, textTransform: "uppercase", letterSpacing: ".12em", paddingBottom: 64 }}>
                  {a.date && <div>{a.date}</div>}
                  <div style={{ marginTop: a.date ? 8 : 0, color: a.cta ? C.yellow : C.mute, fontWeight: a.cta ? 700 : 500 }}>{a.tag}</div>
                </div>
                <div style={{ position: "relative", paddingBottom: 64, paddingLeft: 36 }}>
                  <div style={{ position: "absolute", left: -7, top: 14, width: 16, height: 16, borderRadius: 16, background: (a.highlight || a.cta) ? C.yellow : C.navyDeep, boxShadow: (a.highlight || a.cta) ? `0 0 0 4px ${C.navy}` : `inset 0 0 0 2px ${C.bone}` }} />
                  <div style={{ font: `900 22px/1 ${fonts.mono}`, color: (a.highlight || a.cta) ? C.yellow : C.bone, letterSpacing: ".04em" }}>{a.n}</div>
                  <h3
                    className="fl-act-title"
                    style={{ margin: "14px 0 0", font: `700 32px/1.15 ${fonts.sans}`, letterSpacing: "-0.01em", color: a.highlight ? C.yellow : C.bone, maxWidth: 720 }}
                    dangerouslySetInnerHTML={{ __html: a.titleHtml }}
                  />
                  {a.body && <p style={{ margin: "14px 0 0", maxWidth: 680, font: `400 16px/1.65 ${fonts.sans}`, color: C.bone }}>{a.body}</p>}
                  {a.cta && a.ctaLabel && (
                    <div style={{ marginTop: 22 }}>
                      <Btn primary mono href={a.ctaHref || "#sign"}>{a.ctaLabel.replace(/\s*[→>]+\s*$/,"")}</Btn>
                    </div>
                  )}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        <Rule />

        {/* DONATE — Stripe payment links */}
        <div id="donate" className="fl-donate fl-pad" style={{ paddingTop: 88, paddingBottom: 88, background: C.navyDeep }}>
          <Eyebrow>Fund the fight</Eyebrow>
          <h2 className="fl-h2" style={{ margin: "18px 0 14px" }}>Defend Aussie Farmers. <span style={{ color: C.yellow }}>Pick an amount.</span></h2>
          <p style={{ margin: "0 0 36px", maxWidth: 720, font: `400 17px/1.55 ${fonts.sans}`, color: C.bone }}>
            <strong style={{ color: C.yellow, fontWeight: 700 }}>They have billions. We have you.</strong> Every dollar puts the Baldwin's story in front of Australians who haven't heard it yet — ads, video production, distribution, organising on the ground — and keeps the pressure on the Government until they back down. All amounts in AUD. Stripe-secured.
          </p>
          <div className="fl-donate-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0, border: `1px solid ${C.rule}` }}>
            {[
              { amount: 35,   url: "https://buy.stripe.com/14AbJ0eNg0in96H2tqbV60Q" },
              { amount: 65,   url: "https://buy.stripe.com/28EdR85cG3uzaaL2tqbV60R" },
              { amount: 135,  url: "https://buy.stripe.com/dRm9AS7kOghlaaL2tqbV60S", isDefault: true },
              { amount: 265,  url: "https://buy.stripe.com/5kQeVcfRkghlfv5fgcbV60T" },
              { amount: 550,  url: "https://buy.stripe.com/7sY5kCgVo7KP0AbgkgbV60U" },
              { amount: 1500, url: "https://buy.stripe.com/7sY4gydJcaX1dmX1pmbV60V" },
            ].map((d, i, arr) => (
              <a key={d.amount} href={appendClientRef(d.url, "baldwins")} onClick={() => markDonatePending(d.amount)} target="_top" rel="noopener" className={`fl-donate-tile ${d.isDefault ? "is-default" : ""}`} style={{
                display: "flex", flexDirection: "column", justifyContent: "space-between",
                padding: "28px 24px", minHeight: 160,
                borderRight: ((i + 1) % 4 !== 0 && i !== arr.length - 1) ? `1px solid ${C.rule}` : "none",
                borderBottom: i < arr.length - 2 ? `1px solid ${C.rule}` : "none",
                transition: "background .15s ease, color .15s ease",
              }}>
                <div className="fl-tile-kicker" style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".18em", textTransform: "uppercase" }}>Donate</div>
                <div className="fl-tile-amount" style={{ font: `900 clamp(38px, 4vw, 56px)/0.9 ${fonts.display}`, letterSpacing: "-0.02em" }}>${d.amount}</div>
                <div className="fl-tile-cta" style={{ display: "inline-flex", alignItems: "center", gap: 8, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>Give <span style={{ fontSize: 18 }}>→</span></div>
              </a>
            ))}
            {/* Other amount cell — uses custom-amount payment link */}
            <a href={appendClientRef("https://donate.stripe.com/14A6oG8oS4yDciT5FCbV60X", "baldwins")} target="_top" rel="noopener" className="fl-donate-tile fl-donate-tile--other" style={{
              display: "flex", flexDirection: "column", justifyContent: "space-between",
              padding: "28px 24px", minHeight: 160,
              gridColumn: "span 2",
              transition: "background .15s ease, color .15s ease",
            }}>
              <div className="fl-tile-kicker" style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".18em", textTransform: "uppercase" }}>Choose your own</div>
              <div className="fl-tile-amount" style={{ font: `900 clamp(38px, 4vw, 56px)/0.9 ${fonts.display}`, letterSpacing: "-0.02em" }}>Other</div>
              <div className="fl-tile-cta" style={{ display: "inline-flex", alignItems: "center", gap: 8, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>Enter any amount <span style={{ fontSize: 18 }}>→</span></div>
            </a>
          </div>
          <p style={{ margin: "20px 0 0", font: `500 12px/1.5 ${fonts.mono}`, color: C.mute, letterSpacing: ".12em", textTransform: "uppercase" }}>Stripe-secured · AUD</p>
        </div>

        <Rule />

        {/* ACTION GRID */}
        <div id="actions" className="fl-pad fl-section-aft" style={{ paddingTop: 88, paddingBottom: 56, scrollMarginTop: 60 }}>
          <Eyebrow>What you do today</Eyebrow>
          <h2 className="fl-h2" style={{ margin: "18px 0 48px" }}>Three moves. <span style={{ color: C.yellow }}>You choose.</span></h2>
          <div className="fl-grid-actions">
            {actions.map((a, i) => (
              <a key={a.n} href={a.href} className="fl-action-cell" style={{
                padding: "36px 32px",
                background: a.primary ? C.yellow : "transparent",
                color: a.primary ? C.navyDeep : C.bone,
                borderRight: i < actions.length - 1 ? `1px solid ${a.primary ? "rgba(14,41,64,.18)" : C.rule}` : "none",
                display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 320,
              }}>
                <div>
                  <div style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase", opacity: .7 }}>Action {a.n}</div>
                  <div className="fl-action-title" style={{ font: `800 32px/1.1 ${fonts.sans}`, marginTop: 18, letterSpacing: "-0.01em" }}>{a.t}</div>
                  <div style={{ font: `400 14px/1.55 ${fonts.sans}`, marginTop: 14, color: a.primary ? "rgba(8,24,38,.78)" : C.bone, opacity: a.primary ? 1 : .82 }}>{a.d}</div>
                </div>
                <div style={{ marginTop: 24, display: "inline-flex", alignItems: "center", gap: 10, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>{a.cta} <span style={{ fontSize: 18 }}>→</span></div>
              </a>
            ))}
          </div>
        </div>

        {/* SHARE ROW */}
        <div id="share" className="fl-pad fl-section-aft" style={{ paddingTop: 56, paddingBottom: 56 }}>
          <Eyebrow>Share the petition</Eyebrow>
          <div className="fl-share-row" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
            {[
              { p: "facebook", l: "Facebook", brand: "#1877F2",
                icon: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M24 12a12 12 0 1 0-13.875 11.854V15.469H7.078V12h3.047V9.356c0-3.007 1.792-4.668 4.533-4.668 1.313 0 2.686.234 2.686.234v2.953h-1.513c-1.491 0-1.956.925-1.956 1.875V12h3.328l-.532 3.469h-2.796v8.385A12.001 12.001 0 0 0 24 12z"/></svg> },
              { p: "x",        l: "X", brand: "#FFFFFF",
                icon: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/></svg> },
              { p: "whatsapp", l: "WhatsApp", brand: "#25D366",
                icon: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24z"/></svg> },
              { p: "telegram", l: "Telegram", brand: "#29B6F6",
                icon: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg> },
              { p: "email",    l: "Email", brand: "#F4C430",
                icon: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg> },
            ].map(s => {
              const pageUrl = "https://farmersfightback.com";
              return (
                <a key={s.p} href={shareUrlFor(s.p, p.shareText || "Charges dropped. The Minister must resign. #ResignMinister #ChargesDropped", pageUrl)} target="_blank" rel="noopener noreferrer"
                   style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "14px 18px", background: "transparent", boxShadow: `inset 0 0 0 1.5px ${C.bone}`, color: C.bone, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>
                  <span style={{ color: s.brand, display: "inline-flex" }}>{s.icon}</span>
                  <span>{s.l}</span>
                  <span style={{ marginLeft: "auto", fontSize: 18 }}>→</span>
                </a>
              );
            })}
          </div>
        </div>

        <Rule />

        {/* FOOTER */}
        <div className="fl-pad fl-footer" style={{ paddingTop: 40, paddingBottom: 40, background: C.navyDeep }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, font: `500 11px/1.5 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".12em" }}>
            <span>© Farmers Fightback 2026 · Authorised by Ben Duxson, Farmers Fightback</span>
            <span>farmersfightback.com/take-action/baldwins</span>
          </div>
        </div>
      </div>
      <SocialProofPopup />
    </>
  );
}

function PetitionPage({ slug }) {
  const all = useContent().petitions || {};
  const p = all[slug];
  const defaultReceiverUrl = useContent().petition?.receiverUrl;
  const receiverUrl = (p && p.receiverUrl) || defaultReceiverUrl;

  // Slug-specific themed templates
  if (slug === "baldwins" && p) {
    return <BaldwinFloodlight p={p} receiverUrl={receiverUrl} />;
  }

  if (!p) {
    return (
      <PageShell>
        <section className="ff-section">
          <div className="ff-wrap" style={{ textAlign: "center" }}>
            <h1 className="ff-h2">Petition not found.</h1>
            <p className="ff-lede" style={{ marginInline: "auto" }}>Try the <a href="/take-action">Take Action page</a>.</p>
          </div>
        </section>
      </PageShell>
    );
  }

  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "", country: "AU", consent: false });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle");

  // Honour URL hash (e.g. /petition redirects to .../hold-the-gate#sign) once
  // React has mounted the targeted node. Browsers can't scroll to a hash
  // target that doesn't exist yet on a JS-rendered page, so we retry briefly.
  useEffect(() => {
    const id = (window.location.hash || "").replace(/^#/, "");
    if (!id) return;
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (++tries < 40) setTimeout(tick, 75);
    };
    tick();
  }, []);

  const update = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [k]: v }));
  };
  const validate = () => {
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (form.country === "AU" && form.postcode && !/^\d{4}$/.test(form.postcode)) e.postcode = "4-digit postcode";
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setState("submitting");
    try {
      await signPetition({
        first_name: form.first.trim(),
        last_name: form.last.trim(),
        email: form.email.trim(),
        mobile: form.phone.trim(),
        postcode: form.postcode.trim(),
        content_name: p.campaign || p.slug || "Petition",
        receiverUrl,
        country: form.country?.toLowerCase() || "au",
        extraReceiverFields: {
          country: form.country,
          campaign: p.campaign || p.slug,
        },
      });
      window.location.assign("/donate");
    } catch { setState("error"); }
  };

  if (state === "done") {
    const newCount = (p.currentCount || 0) + 1;
    const pct = Math.min(100, (newCount / (p.goal || 1)) * 100);
    const headingHtml = (p.thanksHeadingHtml || "").replace("{{first}}", form.first);
    const lede = (p.thanksLede || "").replace("{{first}}", form.first).replace("{{count}}", newCount.toLocaleString());
    const pageUrl = "https://farmersfightback.com";
    const copyShare = () => {
      navigator.clipboard?.writeText(`${p.shareText} ${pageUrl}`);
      alert("Share link copied — paste it anywhere.");
    };
    const platforms = [
      { platform: "facebook", label: "Facebook" },
      { platform: "x",        label: "X" },
      { platform: "whatsapp", label: "WhatsApp" },
      { platform: "telegram", label: "Telegram" },
      { platform: "email",    label: "Email" },
      { platform: "copy",     label: "Copy link" },
    ];
    return (
      <PageShell>
        <section className={`ff-section ff-petition-page ff-petition-page--${p.tone || "navy"} is-done`}>
          <div className="ff-wrap ff-petition-page-thanks">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Signed · Thank you</span>
            <h1 className="ff-h2" dangerouslySetInnerHTML={html(headingHtml)} />
            <p className="ff-lede">{lede}</p>
            <div className="ff-petition-tally">
              <div className="ff-tally-num">{newCount.toLocaleString()}</div>
              <div className="ff-tally-label">Signatures and counting</div>
              <div className="ff-tally-bar"><div className="ff-tally-fill" style={{ width: pct.toFixed(1) + "%" }} /></div>
              <div className="ff-tally-goal">{pct.toFixed(1)}% toward our {(p.goal || 0).toLocaleString()} goal</div>
            </div>
            <h3 className="ff-h3">Share the petition</h3>
            <div className="ff-share-row">
              {platforms.map((s, i) => {
                const cls = `ff-share-btn ff-share-btn--${s.platform}`;
                if (s.platform === "copy") return <button key={i} type="button" className={cls} onClick={copyShare}>{s.label}</button>;
                return <a key={i} href={shareUrlFor(s.platform, p.shareText, pageUrl)} target="_blank" rel="noopener noreferrer" className={cls}>{s.label}</a>;
              })}
            </div>
            <div className="ff-petition-page-next">
              <a href="/donate?focus=1" className="ff-btn ff-btn--red">Chip in to the fight</a>
              <a href={p.ctaHrefBack || "/take-action"} className="ff-btn ff-btn--outline">See other campaigns</a>
            </div>
          </div>
        </section>
      </PageShell>
    );
  }

  const remaining = Math.max(0, (p.nextMilestone || 0) - (p.currentCount || 0));
  const milestonePct = Math.min(100, ((p.currentCount || 0) / (p.nextMilestone || 1)) * 100);

  const formBlock = (
    <form id="sign" className="ff-action-form" onSubmit={submit} noValidate>
      <div className="ff-form-header">
        <div>
          <div className="ff-form-count">{(p.currentCount || 0).toLocaleString()}</div>
          <div className="ff-form-count-l">have signed — {remaining.toLocaleString()} to {(((p.nextMilestone || 0) / 1000) | 0) + "k"}</div>
        </div>
        <div className="ff-form-bar"><div style={{ width: milestonePct.toFixed(1) + "%" }} /></div>
      </div>
      <div className="ff-form-row">
        <Field label={<>First name <span className="ff-req">*</span></>} error={errors.first}><input value={form.first} onChange={update("first")} autoComplete="given-name" required aria-required="true" /></Field>
        <Field label={<>Last name <span className="ff-req">*</span></>} error={errors.last}><input value={form.last} onChange={update("last")} autoComplete="family-name" required aria-required="true" /></Field>
      </div>
      <Field label={<>Email <span className="ff-req">*</span></>} error={errors.email}><input type="email" value={form.email} onChange={update("email")} onBlur={() => sendPartial("petition", form)} autoComplete="email" required aria-required="true" /></Field>
      <div className="ff-form-row">
        <Field label="Postcode" error={errors.postcode}>
          <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4} autoComplete="postal-code" placeholder="3000" />
        </Field>
        <Field label="Phone">
          <input type="tel" value={form.phone} onChange={update("phone")} onBlur={() => sendPartial("petition", form)} autoComplete="tel" placeholder="0400 000 000" />
        </Field>
      </div>
      <button className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" disabled={state === "submitting"}>
        {state === "submitting" ? p.submittingLabel : p.submitLabel}
      </button>
      {state === "error" && <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>Something went wrong. Please try again.</p>}
    </form>
  );

  if (p.layout === "long-form") {
    return (
      <PageShell>
        {/* Hero — full-width navy */}
        <section className={`ff-petition-hero ff-petition-hero--${p.tone || "navy"} ${p.heroImage ? "ff-imghero ff-imghero--light" : ""}`} style={p.heroImage ? { backgroundImage: `url(${p.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
          {p.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
          <div className="ff-wrap">
            <h1 className="ff-petition-hero-title" dangerouslySetInnerHTML={html(p.headingHtml || p.heading || "")} />
            {p.subheading && <p className="ff-petition-hero-sub">{p.subheading}</p>}
          </div>
        </section>

        <div className="ff-petition-stack">
        {/* Context paragraphs */}
        {p.context && p.context.length > 0 && (
          <section className="ff-section ff-petition-context">
            <div className="ff-wrap ff-petition-context-inner">
              {p.context.map((para, i) => <p key={i} dangerouslySetInnerHTML={html(para)} />)}
            </div>
          </section>
        )}

        {/* Petition statement card + form */}
        <section className="ff-section ff-petition-form-section">
          <div className="ff-wrap ff-petition-form-grid">
            <div className="ff-petition-statement">
              {p.petitionDeclaration && (
                <div className="ff-petition-declaration">
                  {p.petitionDeclarationKicker && <span className="ff-petition-declaration-kicker">{p.petitionDeclarationKicker}</span>}
                  {p.petitionDeclarationLine1 && <p className="ff-petition-declaration-line1">{p.petitionDeclarationLine1}</p>}
                  <p className="ff-petition-declaration-body">{p.petitionDeclaration}</p>
                  {p.petitionAuthorised && <p className="ff-petition-declaration-auth">{p.petitionAuthorised}</p>}
                </div>
              )}
            </div>
            <div>{formBlock}</div>
          </div>
          {p.trustBadges && p.trustBadges.length > 0 && (
            <div className="ff-wrap ff-petition-trust-row">
              <ul className="ff-trust-row ff-trust-row--inline">
                {p.trustBadges.map((b, i) => (
                  <li key={i} className="ff-trust-badge ff-trust-badge--lg">
                    <span className={`ff-trust-icon ff-trust-icon--${b.icon}`} aria-hidden="true" />
                    <span>
                      <strong>{b.label}</strong>
                      {b.sub && <em>{b.sub}</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        </div>

        {/* Why this matters */}
        {p.whyMatters && p.whyMatters.length > 0 && (
          <section className="ff-section ff-why-matters">
            <div className="ff-wrap">
              {p.whyMattersHeading && (
                <header className="ff-why-matters-head">
                  <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> The case</span>
                  <h2 className="ff-h2">{p.whyMattersHeading}</h2>
                </header>
              )}
              <div className="ff-why-matters-grid">
                {p.whyMatters.map((wm, i) => (
                  <article key={i} className="ff-why-card">
                    {wm.image && (
                      <div className="ff-why-media">
                        <img src={wm.image} alt={wm.imageAlt || ""} loading="lazy" />
                      </div>
                    )}
                    <div className="ff-why-body">
                      <span className="ff-why-num">{String(i + 1).padStart(2, "0")}</span>
                      <h3 className="ff-why-h">{wm.heading}</h3>
                      <p>{wm.body}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Bottom CTA */}
        {p.bottomCta && (
          <section className="ff-petition-bottom-cta">
            <div className="ff-wrap ff-petition-bottom-cta-inner">
              <h2 className="ff-h2 ff-h2--light">{p.bottomCta.heading}</h2>
              <p>{p.bottomCta.body}</p>
              <div className="ff-petition-bottom-actions">
                <a href={p.bottomCta.primaryAnchor || "#sign"} className="ff-btn ff-btn--red ff-btn--lg">{p.bottomCta.primaryLabel}</a>
                <a href={p.bottomCta.secondaryHref || "/#donate"} className="ff-btn ff-btn--ghost ff-btn--lg">{p.bottomCta.secondaryLabel}</a>
              </div>
              <div className="ff-petition-bottom-share">
                <span className="ff-petition-bottom-share-l">Share the petition</span>
                <div className="ff-share-row">
                  {[
                    { platform: "facebook", label: "Facebook" },
                    { platform: "x",        label: "X" },
                    { platform: "whatsapp", label: "WhatsApp" },
                    { platform: "email",    label: "Email" },
                  ].map((s, i) => {
                    return <a key={i} href={shareUrlFor(s.platform, p.shareText, "https://farmersfightback.com")} target="_blank" rel="noopener noreferrer" className={`ff-share-btn ff-share-btn--${s.platform}`}>{s.label}</a>;
                  })}
                </div>
              </div>
            </div>
          </section>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <section className={`ff-section ff-petition-page ff-petition-page--${p.tone || "navy"}`}>
        <div className="ff-wrap ff-petition-page-inner">
          <div className="ff-petition-page-copy">
            <a href={p.ctaHrefBack || "/take-action"} className="ff-back-link">← All campaigns</a>
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {p.eyebrow}</span>
            <h1 className="ff-h2">{p.heading}</h1>
            <p className="ff-lede">{p.lede}</p>
            {p.demands && p.demands.length > 0 && (
              <div className="ff-demands">
                {p.demandsIntro && <p className="ff-demands-intro">{p.demandsIntro}</p>}
                <ol className="ff-demands-list">
                  {p.demands.map((d, i) => (
                    <li key={i} className="ff-demand">
                      <span className="ff-demand-numeral">{d.numeral}</span>
                      <span className="ff-demand-text">{d.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
          <form className="ff-action-form" onSubmit={submit} noValidate>
            <div className="ff-form-header">
              <div>
                <div className="ff-form-count">{(p.currentCount || 0).toLocaleString()}</div>
                <div className="ff-form-count-l">have signed — {remaining.toLocaleString()} to {(((p.nextMilestone || 0) / 1000) | 0) + "k"}</div>
              </div>
              <div className="ff-form-bar"><div style={{ width: milestonePct.toFixed(1) + "%" }} /></div>
            </div>
            <div className="ff-form-row">
              <Field label="First name" error={errors.first}><input value={form.first} onChange={update("first")} autoComplete="given-name" /></Field>
              <Field label="Last name" error={errors.last}><input value={form.last} onChange={update("last")} autoComplete="family-name" /></Field>
            </div>
            <Field label="Email" error={errors.email}><input type="email" value={form.email} onChange={update("email")} autoComplete="email" /></Field>
            <div className="ff-form-row">
              <Field label="Country">
                <select value={form.country} onChange={update("country")} autoComplete="country">
                  <option value="AU">Australia</option><option value="NZ">New Zealand</option><option value="GB">United Kingdom</option>
                  <option value="US">United States</option><option value="CA">Canada</option><option value="OTHER">Other</option>
                </select>
              </Field>
              <Field label="Postcode" error={errors.postcode}>
                <input value={form.postcode} onChange={update("postcode")} inputMode={form.country === "AU" ? "numeric" : "text"} maxLength={form.country === "AU" ? 4 : 10} autoComplete="postal-code" />
              </Field>
            </div>
            <Field label="Phone (optional)"><input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel" placeholder="0400 000 000" /></Field>
            <label className={`ff-consent ${errors.consent ? "has-error" : ""}`}>
              <input type="checkbox" checked={form.consent} onChange={update("consent")} />
              <span>I agree to receive campaign updates from Farmers Fightback. I can unsubscribe at any time.</span>
            </label>
            <button className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" disabled={state === "submitting"}>
              {state === "submitting" ? p.submittingLabel : p.submitLabel}
            </button>
            {state === "error" && <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>Something went wrong. Please try again.</p>}
            <p className="ff-form-fine">Authorised by Ben Duxson, Farmers Fightback.</p>
          </form>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- App (router) ----------
// ---------- The Fight page ----------
function TheFightPage() {
  const c = useContent().theFight;
  return (
    <PageShell>
      <section className={`ff-section ff-thefight-hero ${c.heroImage ? "ff-imghero" : ""}`} style={c.heroImage ? { backgroundImage: `url(${c.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
        {c.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
        <div className="ff-wrap ff-thefight-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-thefight-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      <section className="ff-section ff-thefight-grid-wrap">
        <div className="ff-wrap">
          <div className="ff-thefight-grid">
            {(c.panels || []).map((p, i) => {
              const href = p.href || (i === (c.panels.length - 1) ? "/take-action/baldwins#sign" : "/take-action/hold-the-gate#sign");
              return (
                <a key={i} href={href} className={`ff-thefight-panel ff-thefight-panel--${p.tone || "navy"}`}>
                  {p.image && (
                    <div className="ff-thefight-panel-media">
                      <img src={p.image} alt={p.imageAlt || ""} loading="lazy" />
                    </div>
                  )}
                  <div className="ff-thefight-panel-body">
                    <span className="ff-card-kicker">{p.kicker}</span>
                    <h3 className="ff-thefight-panel-title">{p.title}</h3>
                    <p>{p.body}</p>
                    <span className="ff-thefight-panel-cta">Sign the petition <span aria-hidden="true">→</span></span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      </section>
      <section className="ff-section ff-thefight-cta">
        <div className="ff-wrap ff-thefight-cta-inner">
          <h2 className="ff-h2 ff-h2--light">{c.ctaHeading}</h2>
          <p>{c.ctaBody}</p>
          <div className="ff-thefight-cta-buttons">
            {(c.ctaButtons || []).map((b, i) => (
              <a key={i} href={b.href} className={`ff-btn ff-btn--lg ${b.primary ? "ff-btn--red" : "ff-btn--ghost"}`}>{b.label}</a>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Contact page ----------
function ContactPage() {
  const c = useContent().contact;
  const receiverUrl = c.receiverUrl || useContent().petition?.receiverUrl;
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", message: "" });
  const [state, setState] = useState("idle");
  const [errors, setErrors] = useState({});
  const update = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = async (ev) => {
    ev.preventDefault();
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (!form.message.trim()) e.message = "Tell us what's going on";
    setErrors(e);
    if (Object.keys(e).length) return;
    setState("submitting");
    const body = new URLSearchParams({
      first_name: form.first.trim(),
      last_name: form.last.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      message: form.message.trim(),
      ...getAttribution(),
    });
    try {
      if (receiverUrl) await fetch(receiverUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      sendCAPI("CompleteRegistration", { em: form.email, fn: form.first, ln: form.last, ph: form.phone }, { content_name: "Contact Form" });
      setState("done");
    } catch { setState("error"); }
  };
  return (
    <PageShell>
      <section className={`ff-section ff-contact-hero ${c.heroImage ? "ff-imghero" : ""}`} style={c.heroImage ? { backgroundImage: `url(${c.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
        {c.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
        <div className="ff-wrap ff-contact-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-contact-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      <section className="ff-section ff-contact-body">
        <div className="ff-wrap ff-contact-body-inner ff-contact-body-inner--single">
          <form className="ff-action-form ff-contact-form" onSubmit={submit} noValidate>
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.form?.heading || "Send us a message"}</span>
            {c.form?.lede && <p className="ff-lede" style={{ margin: "12px 0 22px", fontSize: 15 }}>{c.form.lede}</p>}
            {state === "done" ? (
              <div style={{ background: "var(--ff-paper-2)", padding: 28, borderRadius: 6, textAlign: "center" }}>
                <strong style={{ fontSize: 20, color: "var(--ff-navy)" }}>{c.form?.doneHeading}</strong>
                <p style={{ margin: "10px 0 0", color: "var(--ff-ink-2)" }}>{c.form?.doneBody}</p>
              </div>
            ) : (
              <>
                <div className="ff-form-row">
                  <Field label="First name *" error={errors.first}><input value={form.first} onChange={update("first")} autoComplete="given-name" required /></Field>
                  <Field label="Last name *" error={errors.last}><input value={form.last} onChange={update("last")} autoComplete="family-name" required /></Field>
                </div>
                <Field label="Email *" error={errors.email}><input type="email" value={form.email} onChange={update("email")} autoComplete="email" required /></Field>
                <Field label="Phone"><input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel" inputMode="tel" placeholder="0400 000 000" /></Field>
                <Field label="Message *" error={errors.message}>
                  <textarea value={form.message} onChange={update("message")} rows={6} required style={{ width: "100%", padding: "12px 14px", fontFamily: "var(--ff-sans)", fontSize: 15, border: "1.5px solid var(--ff-rule-2)", background: "#fff", borderRadius: "var(--ff-radius)", resize: "vertical" }} />
                </Field>
                <button className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" type="submit" disabled={state === "submitting"}>
                  {state === "submitting" ? (c.form?.submittingLabel || "Sending…") : (c.form?.submitLabel || "Send message →")}
                </button>
                {state === "error" && <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>Something went wrong. Please try again.</p>}
              </>
            )}
          </form>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Media page ----------
function MediaPage() {
  const c = useContent().mediaPage;
  return (
    <PageShell>
      <section className={`ff-section ff-media-hero ${c.heroImage ? "ff-imghero" : ""}`} style={c.heroImage ? { backgroundImage: `url(${c.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
        {c.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
        <div className="ff-wrap ff-media-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-media-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      {c.primaryEmail && (
        <section className="ff-section ff-media-contact">
          <div className="ff-wrap ff-media-contact-inner">
            <div>
              <span className="ff-card-kicker">{c.primaryEmail.label}</span>
              <a href={`mailto:${c.primaryEmail.email}`} className="ff-media-email">{c.primaryEmail.email}</a>
              <p>{c.primaryEmail.blurb}</p>
            </div>
            <a href={`mailto:${c.primaryEmail.email}`} className="ff-btn ff-btn--red ff-btn--lg">Email the media team →</a>
          </div>
        </section>
      )}
      {c.spokespeople && c.spokespeople.length > 0 && (
        <section className="ff-section ff-media-spokes">
          <div className="ff-wrap">
            <h2 className="ff-h2" style={{ fontSize: "clamp(28px, 3.4vw, 42px)", marginBottom: 28 }}>Spokespeople.</h2>
            <ul className="ff-media-spokes-grid">
              {c.spokespeople.map((s, i) => (
                <li key={i} className="ff-media-spoke">
                  <h3>{s.name}</h3>
                  <span className="ff-card-kicker">{s.role}</span>
                  <p>{s.blurb}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {c.outlets && c.outlets.length > 0 && (
        <section className="ff-section ff-media-outlets">
          <div className="ff-wrap">
            <h2 className="ff-h2" style={{ fontSize: "clamp(28px, 3.4vw, 42px)" }}>{c.outletsHeading || "Recent coverage"}</h2>
            {c.outletsLede && <p className="ff-lede" style={{ margin: "12px 0 24px" }}>{c.outletsLede}</p>}
            <ul className="ff-media-outlets-list">
              {c.outlets.map((o, i) => (
                <li key={i} className="ff-media-outlet">
                  <span className="ff-media-outlet-name">{o.outlet}</span>
                  <a href={o.url || "#"} className="ff-media-outlet-headline">{o.headline}</a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {c.assets && c.assets.length > 0 && (
        <section className="ff-section ff-media-assets">
          <div className="ff-wrap">
            <h2 className="ff-h2" style={{ fontSize: "clamp(24px, 3vw, 36px)", marginBottom: 20 }}>Press kit & assets.</h2>
            <ul className="ff-media-assets-list">
              {c.assets.map((a, i) => (
                <li key={i}><a href={a.href} className="ff-link ff-link--red">{a.label}</a></li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {c.fineprint && <p className="ff-aboutus-authorised">{c.fineprint}</p>}
    </PageShell>
  );
}

// ---------- Donor page ("They have billions. We have you.") ----------
// Thank-you state for /donate?cs=<session_id> (WS2.3): one-off donors get
// the make-it-monthly upsell (email prefilled); monthly donors get sent to
// their share link. Falls back to the normal widget if the session isn't
// paid or can't be read.
// Full-screen post-donation monthly upsell (one-off donors only). Nav is
// hidden by the caller; on mobile this owns the whole viewport.
function MonthlyUpsellHero({ session }) {
  const [busy, setBusy] = useState(false);
  useBfcacheReset(() => setBusy(false));
  const paid = Math.round((session.amount_total || 0) / 100);
  const mo = monthlyFor(paid);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    sendCAPI("InitiateCheckout", {}, { value: mo, currency: "AUD", content_name: "Monthly Donation" });
    try {
      window.location.href = await createDonationCheckout({ amount: mo, frequency: "monthly", email: session.email });
    } catch { setBusy(false); }
  };
  return (
    <section className="ff-upsell-hero">
      <div className="ff-upsell-inner">
        <p className="ff-upsell-thanks">🙏 Thank you — ${paid.toLocaleString()} received. Your receipt is on its way.</p>
        <h1 className="ff-upsell-h1">${paid} helps today.<br /><span>${mo} a month wins this fight.</span></h1>
        <p className="ff-upsell-lede">
          One-off gifts keep the lights on. Monthly backing changes what we can do:
        </p>
        <ul className="ff-upsell-points">
          <li><strong>We can book ahead.</strong> Ads, lawyers and polling are committed months in advance — steady funding means we reserve them before the Government moves.</li>
          <li><strong>They can't wait us out.</strong> A predictable war chest is the one thing a delay-and-outlast strategy can't beat.</li>
          <li><strong>Small monthly beats big once.</strong> A year of ${mo}/month puts more fight on the ground than most one-off gifts — without you feeling it.</li>
        </ul>
        <button type="button" className="ff-btn ff-btn--red ff-upsell-cta" disabled={busy} onClick={go}>
          {busy ? "One moment…" : `Make it $${mo}/month`}
        </button>
        <p className="ff-upsell-fine">Cancel anytime with one email. Receipted monthly.</p>
        <a className="ff-upsell-skip" href="/share">No thanks — I'll share the fight with my mates instead →</a>
      </div>
    </section>
  );
}

function DonateThanksPanel({ session }) {
  const [busy, setBusy] = useState(false);
  useBfcacheReset(() => setBusy(false));
  const paidDollars = Math.round((session.amount_total || 0) / 100);
  const monthly = session.frequency === "monthly";
  const mo = monthlyFor(paidDollars);
  const upsell = async () => {
    if (busy) return;
    setBusy(true);
    sendCAPI("InitiateCheckout", {}, { value: mo, currency: "AUD", content_name: "Monthly Donation" });
    try {
      window.location.href = await createDonationCheckout({ amount: mo, frequency: "monthly", email: session.email });
    } catch { setBusy(false); }
  };
  return (
    <div id="donate" className="ff-give-widget">
      <div style={{ textAlign: "center", padding: "10px 4px" }}>
        <div style={{ fontSize: 44, lineHeight: 1 }}>🙏</div>
        <h2 className="ff-h3" style={{ margin: "12px 0 6px" }}>
          Thank you — ${paidDollars.toLocaleString()}{monthly ? " a month" : ""} received.
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.5, color: "#41505c", margin: "0 0 18px" }}>
          {monthly
            ? "You're now part of the fighting fund that lets us plan ahead. Your receipt is on its way."
            : "That's real fuel for the fight. Your receipt is on its way to your inbox."}
        </p>
        {monthly ? (
          <a href="/share" className="ff-btn ff-btn--red ff-btn--block ff-btn--lg">Get your share link →</a>
        ) : (
          <React.Fragment>
            <button type="button" className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" disabled={busy} onClick={upsell}>
              {busy ? "One moment…" : `Make it $${mo}/month`}
            </button>
            <p style={{ fontSize: 13.5, color: "#41505c", margin: "12px 0 0" }}>
              Monthly backing is what lets us book ads and lawyers ahead of time.
              {" "}<a href="/share" style={{ fontWeight: 700 }}>Or share the fight with your mates →</a>
            </p>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

function DonorPage() {
  const c = useContent().donorPage;
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const [monthly, setMonthly] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState(null); // paid session summary

  const oneOffTiers = c.amounts || [];
  // Monthly ladder is the brief's mapping of the one-off ladder — served by
  // /api/checkout price_data, so no pre-created Payment Links needed.
  const monthlyTiers = oneOffTiers.map(t => ({ amount: monthlyFor(t.amount) }));
  const tiers = monthly ? monthlyTiers : oneOffTiers;

  // WS5: ?ask=<tier> preselects the upgrade ask; default anchor is $65.
  const askParam = Number(params.get("ask")) || 0;
  const defaultPick = (
    oneOffTiers.find(t => Number(t.amount) === askParam) ||
    oneOffTiers.find(t => Number(t.amount) === 65) ||
    oneOffTiers.find(t => t.isDefault) ||
    oneOffTiers[Math.min(2, oneOffTiers.length - 1)] || {}
  ).amount;
  const [picked, setPicked] = useState(defaultPick);
  useEffect(() => {
    setPicked(monthly ? monthlyFor(defaultPick) : defaultPick);
    setCustom("");
  }, [monthly]);

  // Thank-you state: back from Stripe with ?cs=<session_id>.
  useEffect(() => {
    const cs = params.get("cs");
    if (!cs) return;
    fetch(`/api/checkout?session_id=${encodeURIComponent(cs)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (j && j.session && j.session.paid) {
          setThanks(j.session);
          sendCAPI("Purchase", { em: j.session.email }, {
            value: (j.session.amount_total || 0) / 100, currency: "AUD",
            content_name: j.session.frequency === "monthly" ? "Monthly Donation" : "One-off Donation",
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = document.getElementById("donate");
    if (!el) return;
    const t = setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    return () => clearTimeout(t);
  }, []);

  const isOther = picked === "other";
  const amount = isOther ? (Number(custom) || 0) : Number(picked) || 0;
  const selected = oneOffTiers.find(t => Number(t.amount) === amount);
  const fallbackUrl = (!monthly && selected && selected.url) || c.otherUrl;
  const ready = amount >= 2 && !busy;
  const ctaLabel = busy ? "One moment…" : `Donate $${amount || "—"}${monthly ? " / month" : ""} →`;

  useBfcacheReset(() => setBusy(false));

  // Hide the nav whenever the visitor has COMPLETED the petition this
  // session (ff_email is set only at petition success) — however they got
  // here — plus the explicit ?focus=1 handoff. Full-screen ask, no
  // distractions. Everyone else keeps the menu.
  let signedThisSession = false;
  try { signedThisSession = !!sessionStorage.getItem("ff_email"); } catch {}
  const focusMode = params.get("focus") === "1" || signedThisSession;

  // Both frequencies go STRAIGHT to Stripe — no pre-payment intercept; the
  // make-it-monthly ask happens post-payment on the thank-you panel. Never
  // risk the gift: API failure on a one-off falls back to the legacy
  // Payment Link.
  const onCta = async () => {
    if (!ready) return;
    setBusy(true);
    const frequency = monthly ? "monthly" : "oneoff";
    sendCAPI("InitiateCheckout", {}, { value: amount, currency: "AUD", content_name: monthly ? "Monthly Donation" : "One-off Donation" });
    try {
      window.location.href = await createDonationCheckout({ amount, frequency });
    } catch (e) {
      if (!monthly && fallbackUrl) {
        window.location.href = appendClientRef(fallbackUrl, currentPetitionSlug());
        return;
      }
      setBusy(false);
      alert("Sorry — that didn't go through. Please try again.");
    }
  };

  // One-click chips: tapping an amount goes straight to Stripe (no second
  // CTA press). The red button remains only for the custom "Other" amount,
  // which has to be typed before it can be sent.
  const goAmount = async (amt, tierUrl) => {
    if (busy) return;
    setPicked(amt);
    setCustom("");
    setBusy(true);
    const frequency = monthly ? "monthly" : "oneoff";
    sendCAPI("InitiateCheckout", {}, { value: amt, currency: "AUD", content_name: monthly ? "Monthly Donation" : "One-off Donation" });
    try {
      window.location.href = await createDonationCheckout({ amount: amt, frequency });
    } catch (e) {
      if (!monthly && tierUrl) {
        window.location.href = appendClientRef(tierUrl, currentPetitionSlug());
        return;
      }
      setBusy(false);
      alert("Sorry — that didn't go through. Please try again.");
    }
  };

  // A completed ONE-OFF gets the dedicated full-screen monthly upsell (no
  // nav, no competing content — the whole viewport on mobile).
  if (thanks && thanks.frequency !== "monthly") {
    return (
      <PageShell hideNav hideTopBanner>
        <MonthlyUpsellHero session={thanks} />
      </PageShell>
    );
  }

  return (
    <PageShell hideNav={focusMode}>
      <section className={`ff-section ff-give-hero ${c.heroImage ? "ff-imghero ff-imghero--dark" : ""}`} style={c.heroImage ? { backgroundImage: `url(${c.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
        {c.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
        <div className="ff-wrap ff-give-hero-inner">
          <div className="ff-give-hero-copy">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
            <h1 className="ff-h2 ff-give-h1">{c.heading}</h1>
            <p className="ff-give-lede">{c.lede}</p>
            <ul className="ff-give-trust">
              <li>SSL Secured</li><li>Stripe</li><li>All amounts in AUD</li>
            </ul>
          </div>
          {thanks ? (
            <DonateThanksPanel session={thanks} />
          ) : (
          <div id="donate" className="ff-give-widget">
            {/* The page auto-scrolls to this widget, which on mobile skips the
                hero headline — so the core message rides directly above the
                amount matrix (hidden on desktop, where the hero h1 sits
                alongside). */}
            <h2 className="ff-give-widget-h">{c.heading}</h2>
            <div className="ff-give-freq" role="tablist" aria-label="Donation frequency">
              <button type="button" role="tab" aria-selected={!monthly} className={!monthly ? "is-on" : ""} onClick={() => setMonthly(false)}>One-off</button>
              <button type="button" role="tab" aria-selected={monthly}  className={monthly  ? "is-on" : ""} onClick={() => setMonthly(true)}>Monthly</button>
            </div>
            <div className="ff-give-chips">
              {tiers.map(t => (
                <button key={t.amount} type="button" disabled={busy} className={`ff-give-chip ${Number(picked) === Number(t.amount) ? "is-on" : ""}`} onClick={() => goAmount(Number(t.amount), t.url)}>
                  <span className="ff-give-chip-amt">{busy && Number(picked) === Number(t.amount) ? "…" : <React.Fragment>${t.amount}{monthly && <small>/mo</small>}</React.Fragment>}</span>
                  {t.tag && <span className="ff-give-chip-tag">{busy && Number(picked) === Number(t.amount) ? "One moment" : t.tag}</span>}
                </button>
              ))}
              <button type="button" className={`ff-give-chip ff-give-chip--other ${isOther ? "is-on" : ""}`} onClick={() => setPicked("other")}>
                <span className="ff-give-chip-amt">Other</span>
                <span className="ff-give-chip-tag">Choose your own</span>
              </button>
            </div>
            {isOther && (
              <div style={{ position: "relative", margin: "12px 0 4px" }}>
                <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontWeight: 700 }}>$</span>
                <input
                  type="number" min="2" placeholder="Amount" value={custom} autoFocus
                  onChange={(e) => setCustom(e.target.value)}
                  style={{ width: "100%", padding: "12px 12px 12px 28px", fontSize: 16, border: "1.5px solid #d5dbe0", borderRadius: 10 }}
                />
              </div>
            )}
            {isOther && (
              <button type="button" className="ff-btn ff-btn--red ff-btn--block ff-btn--lg ff-give-cta" disabled={!ready} onClick={onCta}>{ctaLabel}</button>
            )}
            <p className="ff-give-fineprint">{c.fineprint}</p>
          </div>
          )}
        </div>
      </section>
      {c.amounts && c.amounts.some(a => a.tag) && (
        <section className="ff-section ff-give-where">
          <div className="ff-wrap">
            <h2 className="ff-h2 ff-give-where-h">Where it goes.</h2>
            <ul className="ff-give-where-list">
              {c.amounts.filter(a => a.tag).map(a => (
                <li key={a.amount} className="ff-give-where-row">
                  <span className="ff-give-where-amt">${a.amount}</span>
                  <span className="ff-give-where-tag">{a.tag}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {c.achievements && <DonorAchievements cfg={c.achievements} />}
    </PageShell>
  );
}

function DonorAchievements({ cfg }) {
  const [imgSrc, setImgSrc] = useState(cfg.image);
  const onErr = () => { if (cfg.imageFallback && imgSrc !== cfg.imageFallback) setImgSrc(cfg.imageFallback); };
  return (
    <section className="ff-section ff-give-wins">
      <div className="ff-wrap ff-give-wins-inner">
        <div className="ff-give-wins-media">
          <img src={imgSrc} alt={cfg.imageAlt || ""} onError={onErr} loading="lazy" />
        </div>
        <div className="ff-give-wins-copy">
          {cfg.heading && <h2 className="ff-h2 ff-give-wins-h">{cfg.heading}</h2>}
          <ul className="ff-give-wins-list">
            {(cfg.bullets || []).map((b, i) => (
              <li key={i}><span className="ff-give-wins-tick" aria-hidden="true">✓</span><span>{b}</span></li>
            ))}
          </ul>
          {cfg.kicker && <p className="ff-give-wins-kicker">{cfg.kicker}</p>}
        </div>
      </div>
    </section>
  );
}

// ---------- Volunteer page ----------
function VolunteerPage() {
  const c = useContent().volunteer;
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "", vType: "", roles: [] });
  const [state, setState] = useState("idle");
  const [errors, setErrors] = useState({});
  const receiverUrl = c.receiverUrl || useContent().petition?.receiverUrl;
  const toggleRole = (r) => setForm(f => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter(x => x !== r) : [...f.roles, r] }));
  const submit = async (ev) => {
    ev.preventDefault();
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (!form.phone.trim()) e.phone = "Required";
    if (!form.postcode.trim()) e.postcode = "Required";
    if (form.postcode.trim() && !/^\d{4}$/.test(form.postcode.trim())) e.postcode = "4-digit postcode";
    if (!form.vType) e.vType = "Required";
    setErrors(e);
    if (Object.keys(e).length) return;
    setState("submitting");
    const body = new URLSearchParams({
      first_name: form.first.trim(), last_name: form.last.trim(),
      email: form.email.trim(), phone: form.phone.trim(), postcode: form.postcode.trim(),
      volunteer_type: form.vType,
      roles: form.roles.join(", "), campaign: "Volunteer",
      ...getAttribution(),
    });
    try {
      if (receiverUrl) await fetch(receiverUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      sendCAPI("CompleteRegistration", { em: form.email, fn: form.first, ln: form.last, ph: form.phone, zp: form.postcode, country: "au" }, { content_name: "Volunteer Registration" });
      window.dispatchEvent(new CustomEvent("petition-signed", { detail: { first: form.first.trim() } }));
      window.location.assign("/donate");
    } catch { setState("error"); }
  };
  return (
    <PageShell>
      <section className={`ff-section ff-vol-hero ${c.heroImage ? "ff-imghero" : ""}`} style={c.heroImage ? { backgroundImage: `url(${c.heroImage})`, backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined}>
        {c.heroImage && <span className="ff-imghero-scrim" aria-hidden="true" />}
        <div className="ff-wrap ff-vol-hero-inner">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h1 className="ff-h2 ff-vol-h1">{c.heading}</h1>
          <p className="ff-lede">{c.lede}</p>
        </div>
      </section>
      <section className="ff-section ff-vol-roles">
        <div className="ff-wrap">
          <h2 className="ff-h2" style={{ fontSize: "clamp(28px, 3.4vw, 44px)", marginBottom: 8 }}>{c.rolesHeading}</h2>
          <p className="ff-lede" style={{ marginBottom: 28 }}>{c.rolesIntro}</p>
          <ul className="ff-vol-roles-grid">
            {(c.roles || []).map((r, i) => (
              <li key={i} className="ff-vol-role">
                <h3>{r.title}</h3>
                <p>{r.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="ff-section ff-vol-form-section">
        <div className="ff-wrap ff-vol-form-wrap">
          <div className="ff-vol-form-head">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.formHeading}</span>
            <h2 className="ff-h2" style={{ fontSize: "clamp(28px, 3.4vw, 44px)" }}>{c.formSubheading}</h2>
          </div>
          {state === "done" ? (
            <div className="ff-action-form" style={{ textAlign: "center" }}>
              <h3 className="ff-h3">{c.doneHeading}</h3>
              <p style={{ color: "var(--ff-ink-2)", marginTop: 8 }}>{c.doneBody}</p>
            </div>
          ) : (
            <form className="ff-action-form" onSubmit={submit} noValidate>
              <div className="ff-form-row">
                <Field label="First name *" error={errors.first}><input value={form.first} onChange={(e) => setForm(f => ({ ...f, first: e.target.value }))} autoComplete="given-name" required /></Field>
                <Field label="Last name *" error={errors.last}><input value={form.last} onChange={(e) => setForm(f => ({ ...f, last: e.target.value }))} autoComplete="family-name" required /></Field>
              </div>
              <Field label="Email *" error={errors.email}><input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} autoComplete="email" required /></Field>
              <div className="ff-form-row">
                <Field label="Mobile *" error={errors.phone}><input type="tel" value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} autoComplete="tel" required placeholder="0400 000 000" /></Field>
                <Field label="Postcode *" error={errors.postcode}><input value={form.postcode} onChange={(e) => setForm(f => ({ ...f, postcode: e.target.value }))} inputMode="numeric" maxLength={4} autoComplete="postal-code" required /></Field>
              </div>
              <Field label="How would you like to help? *" error={errors.vType}>
                <select value={form.vType} onChange={(e) => setForm(f => ({ ...f, vType: e.target.value }))} required>
                  <option value="">Select an option…</option>
                  <option value="farmgate">Farm gate presence (Hold the Gate)</option>
                  <option value="phone-banking">Phone banking</option>
                  <option value="field-canvassing">Community engagement</option>
                  <option value="digital-advocacy">Digital advocacy</option>
                  <option value="logistics">Logistics</option>
                  <option value="administration">Administration</option>
                </select>
              </Field>
              <div className={`ff-field ff-field--group`}>
                <span className="ff-field-label">{c.rolesFieldLabel || "Which roles interest you?"}</span>
                <div className="ff-vol-role-checks">
                  {(c.roles || []).map((r, i) => (
                    <label key={i} className={`ff-vol-role-check ${form.roles.includes(r.title) ? "is-on" : ""}`}>
                      <input type="checkbox" checked={form.roles.includes(r.title)} onChange={() => toggleRole(r.title)} />
                      <span className="ff-vol-role-check-l">{r.title}</span>
                    </label>
                  ))}
                </div>
              </div>
              <button className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" disabled={state === "submitting"}>
                {state === "submitting" ? c.submittingLabel : c.submitLabel}
              </button>
            </form>
          )}
        </div>
      </section>
      <section className="ff-section ff-vol-alt">
        <div className="ff-wrap ff-vol-alt-inner">
          <h2 className="ff-h3">{c.altHeading}</h2>
          <p>{c.altBody}</p>
          <div className="ff-vol-alt-links">
            {(c.altLinks || []).map((l, i) => <a key={i} href={l.href} className="ff-link ff-link--red">{l.label}</a>)}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Share thank-you page ----------
// Lives at /share. Two states it cares about:
//   - identifying  → trying to figure out who the donor is. Polls
//                    /api/share-context with session_id (from Stripe), or
//                    asks for email if there's no session_id and
//                    localStorage is empty.
//   - ready        → renders the thanks + 5-platform share grid, tokenised
//                    on the donor's referral_code so we can attribute every
//                    downstream signature back to them.
//
// Browser pixel fires "Donate" once per visit when arriving with
// ?session_id= (acts as the post-purchase thanks event from the user's
// own browser, complementing the server-side Purchase fired by the
// Stripe webhook).
function ShareThanksPage() {
  const c = useContent();
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const sessionId = params.get("session_id") || "";

  const stored = (() => {
    try {
      return {
        code: localStorage.getItem("ff_referral_code") || "",
        contactId: localStorage.getItem("ff_contact_id") || "",
        firstName: localStorage.getItem("ff_first_name") || "",
        shared: JSON.parse(localStorage.getItem("ff_shared_platforms") || "[]"),
      };
    } catch {
      return { code: "", contactId: "", firstName: "", shared: [] };
    }
  })();

  const [referralCode, setReferralCode] = useState(stored.code);
  const [firstName, setFirstName] = useState(stored.firstName);
  const [identity, setIdentity] = useState({ first: "", last: "", email: "", mobile: "", postcode: "" });
  const [identityError, setIdentityError] = useState("");
  const updateIdentity = (k) => (e) => setIdentity((f) => ({ ...f, [k]: e.target.value }));
  // Petition slug from the server (Stripe Checkout Session's
  // client_reference_id). Authoritative when present; otherwise the page
  // falls back to ff_last_petition_url in localStorage.
  const [serverPetitionSlug, setServerPetitionSlug] = useState("");
  const [shared, setShared] = useState(stored.shared);
  const [copied, setCopied] = useState(false);

  // status: "ready" | "polling" | "ask_email" | "looking_up"
  const initialStatus = stored.code ? "ready" : sessionId ? "polling" : "ask_email";
  const [status, setStatus] = useState(initialStatus);

  const persistCode = (code, fn, contactId) => {
    setReferralCode(code);
    if (fn) setFirstName(fn);
    try {
      localStorage.setItem("ff_referral_code", code);
      if (fn) localStorage.setItem("ff_first_name", fn);
      if (contactId) localStorage.setItem("ff_contact_id", contactId);
    } catch {}
  };

  // One-shot post-donation pixel. We only fire when arriving with
  // session_id (i.e. fresh from Stripe), not on every visit to /share.
  useEffect(() => {
    if (!sessionId) return;
    if (typeof window === "undefined" || !window.fbq) return;
    const key = `ff_donate_pixel_${sessionId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    window.fbq("track", "ViewContent", { content_name: "Post-Donation Share" });
  }, [sessionId]);

  // Poll by session_id while waiting for the Stripe webhook to land.
  useEffect(() => {
    if (status !== "polling" || !sessionId) return;
    let active = true;
    let attempts = 0;
    const tick = async () => {
      if (!active) return;
      attempts++;
      try {
        const r = await fetch(`/api/share-context?session_id=${encodeURIComponent(sessionId)}`);
        if (r.ok) {
          const j = await r.json();
          if (j.referral_code) {
            persistCode(j.referral_code, j.first_name, j.contact_id);
            if (j.petition_slug) setServerPetitionSlug(j.petition_slug);
            setStatus("ready");
            return;
          }
        }
      } catch {}
      if (attempts >= 15) {
        setStatus("ask_email");
        setIdentityError("Taking longer than expected — fill in your details and we'll set up your share link.");
      } else {
        setTimeout(tick, 2000);
      }
    };
    tick();
    return () => { active = false; };
  }, [status, sessionId]);

  // Identity submission: matches an existing contact by email (preferred),
  // mobile, or name+postcode; creates one if no match. Either way, the donor
  // gets a referral_code back and lands on the ready state.
  const submitIdentity = async (ev) => {
    ev && ev.preventDefault && ev.preventDefault();
    const first = identity.first.trim();
    const last = identity.last.trim();
    const email = identity.email.trim();
    if (!first) { setIdentityError("First name required"); return; }
    if (!last) { setIdentityError("Last name required"); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setIdentityError("Enter a valid email"); return; }
    setIdentityError("");
    setStatus("looking_up");
    try {
      const r = await fetch("/api/share-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          email,
          mobile: identity.mobile.trim() || undefined,
          postcode: identity.postcode.trim() || undefined,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j.referral_code) {
          persistCode(j.referral_code, j.first_name || first, j.contact_id);
          setStatus("ready");
          return;
        }
      }
    } catch {}
    setStatus("ask_email");
    setIdentityError("Couldn't save those details — give it another go.");
  };

  const PRODUCTION_ORIGIN = "https://www.farmersfightback.com";
  const lastPetitionPath = (() => {
    try { return localStorage.getItem("ff_last_petition_url") || ""; } catch { return ""; }
  })();
  const lastPetitionName = (() => {
    try { return localStorage.getItem("ff_last_petition_name") || ""; } catch { return ""; }
  })();
  // Path resolution order:
  //   1. serverPetitionSlug (Stripe client_reference_id) — set when the
  //      donor came through Checkout. Authoritative for cross-petition
  //      cases (signed Hold the Gate but donated from the Baldwin page).
  //   2. localStorage ff_last_petition_url — works when the donor signed
  //      then donated in the same browser session.
  //   3. Homepage as a final fallback.
  const sharePath = serverPetitionSlug
    ? `/take-action/${serverPetitionSlug}`
    : ((lastPetitionPath || "/").replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0] || "/");
  const shareUrl = referralCode
    ? `${PRODUCTION_ORIGIN}${sharePath}?ref=${referralCode}`
    : `${PRODUCTION_ORIGIN}${sharePath}`;

  // Resolve the petition the donor engaged with (server slug first, then
  // sharePath) so the page uses that petition's shareText + currentCount,
  // not the home defaults.
  const petitionDef = (() => {
    const slug = serverPetitionSlug || (sharePath.match(/^\/take-action\/([^/]+)/) || [])[1];
    if (slug && c.petitions && c.petitions[slug]) return c.petitions[slug];
    return (c.petition && c.petition.shareText) ? c.petition : null;
  })();
  const currentCount = (petitionDef && petitionDef.currentCount) || (c.petition && c.petition.currentCount) || 0;
  // {{count}} placeholders are replaced with the live count from
  // site.json — same number that the petition page itself displays, so
  // share copy never goes stale relative to what the visitor sees.
  const substituteCount = (text) => {
    if (!text || !currentCount) return (text || "").replace(/\s*\{\{count\}\}\+?\s*/g, " ").replace(/\s+/g, " ").trim();
    return String(text).replace(/\{\{count\}\}/g, Number(currentCount).toLocaleString());
  };
  const rawShareText = (c.share && c.share.shareText)
    || (petitionDef && petitionDef.shareText)
    || (c.petition && c.petition.shareText)
    || "I just backed Farmers Fightback — Aussie farming families are being pushed off their land. Sign the petition with me.";
  const shareText = substituteCount(rawShareText);
  const emailSubject = (c.share && c.share.emailSubject) || "Will you sign this petition with me?";

  const platforms = [
    { id: "facebook", label: "Facebook" },
    { id: "x",        label: "X" },
    { id: "linkedin", label: "LinkedIn" },
    { id: "whatsapp", label: "WhatsApp" },
    { id: "sms",      label: "Text message" },
    { id: "email",    label: "Email" },
    { id: "copy",     label: copied ? "Copied!" : "Copy link" },
  ];

  const markShared = (platform) => {
    if (shared.includes(platform)) return;
    const updated = [...shared, platform];
    setShared(updated);
    try { localStorage.setItem("ff_shared_platforms", JSON.stringify(updated)); } catch {}
  };

  const onShare = (platform) => {
    if (!referralCode) return;
    // Log Share Issued — fire-and-forget so the share window opens immediately.
    fetch("/api/share-issued", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referral_code: referralCode, platform, share_url: shareUrl }),
      keepalive: true,
    }).catch(() => {});
    markShared(platform);

    if (platform === "copy") {
      try {
        navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // Fallback for browsers without clipboard API: select an off-screen
        // textarea (synchronous + permission-free).
        const ta = document.createElement("textarea");
        ta.value = shareUrl;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
        document.body.removeChild(ta);
      }
      return;
    }
    const url = shareUrlFor(platform, shareText, shareUrl, emailSubject);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const sharedCount = Math.min(5, shared.length);
  const goal = 5;
  const pct = (sharedCount / goal) * 100;

  return (
    <PageShell hideNav hideTopBanner>
      <section className="ff-section ff-share">
        <div className="ff-wrap ff-share-inner">
          {(status === "polling" || status === "looking_up") && (
            <div className="ff-share-loading">
              <h1 className="ff-h2">Setting up your share link…</h1>
              <p className="ff-lede">One sec — we're matching your donation to your account so every signup you bring in counts on your tally.</p>
            </div>
          )}

          {status === "ask_email" && (
            <div className="ff-share-ask">
              <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Thank you</span>
              <h1 className="ff-h2">Thanks for backing the fight.</h1>
              <p className="ff-lede">Pop your details in below and we'll set up your share link — we'll match you to your existing record if we've heard from you before.</p>
              <form className="ff-action-form ff-share-identity-form" onSubmit={submitIdentity} noValidate>
                <div className="ff-form-row">
                  <Field label={<>First name <span className="ff-req">*</span></>}>
                    <input value={identity.first} onChange={updateIdentity("first")} autoComplete="given-name" required aria-required="true" />
                  </Field>
                  <Field label={<>Last name <span className="ff-req">*</span></>}>
                    <input value={identity.last} onChange={updateIdentity("last")} autoComplete="family-name" required aria-required="true" />
                  </Field>
                </div>
                <Field label={<>Email <span className="ff-req">*</span></>}>
                  <input type="email" value={identity.email} onChange={updateIdentity("email")} placeholder="you@example.com" autoComplete="email" required aria-required="true" />
                </Field>
                <div className="ff-form-row">
                  <Field label="Mobile">
                    <input type="tel" value={identity.mobile} onChange={updateIdentity("mobile")} placeholder="0400 000 000" autoComplete="tel" />
                  </Field>
                  <Field label="Postcode">
                    <input value={identity.postcode} onChange={updateIdentity("postcode")} placeholder="3000" inputMode="numeric" maxLength={4} autoComplete="postal-code" />
                  </Field>
                </div>
                <button className="ff-btn ff-btn--red ff-btn--block" type="submit">Get my share link</button>
              </form>
              {identityError && <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>{identityError}</p>}
            </div>
          )}

          {status === "ready" && (
            <div className="ff-share-ready">
              <div className="ff-share-thank">
                <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Thank you{firstName ? `, ${firstName}` : ""}</span>
                <h1 className="ff-h2">Thank you for standing with Aussie farmers.</h1>
                <p className="ff-lede">Your generosity makes a real difference, helping us let everyday Australians know how the Government is targeting Aussie farmers.</p>
              </div>

              <div className="ff-share-multiplier">
                <h2 className="ff-h3">1 minute is worth $100.</h2>
                <p>Sharing this message with 5 friends or family members helps multiply our message 100 times. Take 1 minute to share this on socials or directly, and multiply your impact!</p>
              </div>

              <div className="ff-share-progress">
                <div className="ff-share-progress-bar"><div style={{ width: pct.toFixed(0) + "%" }} /></div>
                <div className="ff-share-progress-label">{sharedCount} of {goal} shared</div>
              </div>

              <div className="ff-share-stack">
                {platforms.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`ff-share-btn ff-share-btn--brand ff-share-btn--${p.id} ${shared.includes(p.id) ? "is-shared" : ""}`}
                    onClick={() => onShare(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="ff-share-link">
                <label className="ff-field-label">Your share link</label>
                <div className="ff-share-link-row">
                  <input type="text" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                  <button type="button" className="ff-btn ff-btn--outline" onClick={() => onShare("copy")}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="ff-share-next">
                <a href="/" className="ff-link">← Back to home</a>
              </div>
            </div>
          )}
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Email the Liberal Party (direct-URL action page) ----------
// Reachable only via /askjess — intentionally NOT linked from any nav
// or take-action surface. Single scrolling flow: hero, 3-step explainer,
// details form (debounced partial capture), editable email, AI rewrite,
// send (mailto), success + fallback. Copy is approved verbatim (brief §13).
const FFB_SESSION_KEY = "ffb_session_id";

function ffbHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function ffbEmailValid(v) { return /^\S+@\S+\.\S+$/.test(String(v || "").trim()); }
// AU mobile: accept 04xxxxxxxx or +614xxxxxxxx → normalize to +614xxxxxxxx.
function ffbNormMobile(raw) {
  const t = String(raw || "").replace(/\s+/g, "");
  if (/^04\d{8}$/.test(t)) return "+61" + t.slice(1);
  if (/^\+614\d{8}$/.test(t)) return t;
  return null;
}

function SendEmailPage() {
  // BCC the campaign on every compose path so we see what supporters send.
  // Campaign copy goes in the To line (visible recipient), not BCC.
  const CAMPAIGN_COPY = "correspondence@mail.farmersfightback.com";
  const sessionId = React.useRef(null);
  if (!sessionId.current) {
    let s = "";
    try {
      s = sessionStorage.getItem(FFB_SESSION_KEY) || "";
      if (!s) {
        s = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(FFB_SESSION_KEY, s);
      }
    } catch { s = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    sessionId.current = s;
  }
  const variationIndex = ffbHash(sessionId.current) % 10;

  const [variations, setVariations] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [form, setForm] = useState({ first: "", last: "", email: "", mobile: "", honeypot: "" });
  const [errors, setErrors] = useState({});
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [rewriteState, setRewriteState] = useState("idle"); // idle|loading|session_limit|unavailable
  const [sent, setSent] = useState(false);
  const [sentData, setSentData] = useState({ subject: "", body: "", recipients: "" });
  const [toast, setToast] = useState("");
  // Post-send donation block: reuses DonorPage's amount ladder + checkout
  // helper. donateBusy holds the amount currently redirecting to Stripe so
  // only the tapped chip shows its busy state.
  const donor = useContent().donorPage || {};
  const [donateBusy, setDonateBusy] = useState(null);
  // Back from Stripe (bfcache restore) must clear the stuck chip.
  useBfcacheReset(() => setDonateBusy(null));

  const formRef = React.useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);
  const captureTimer = React.useRef(null);
  // Coalescing capture sender state. seqRef gives every dispatched capture a
  // monotonically increasing seq so the server can drop late-arriving older
  // snapshots. inFlightRef/dirtyRef ensure only one /api/capture request is in
  // flight per tab; a request raised while one is in flight is coalesced and
  // the latest snapshot is sent when the in-flight completes. lastSentSnapRef
  // holds the signature of the last successfully-sent snapshot so the abandon
  // beacon only fires when something actually changed.
  const seqRef = React.useRef(0);
  const captureInFlight = React.useRef(false);
  const captureDirty = React.useRef(false);
  const pendingExtraRef = React.useRef({});
  const pendingKeepaliveRef = React.useRef(false);
  const lastSentSnapRef = React.useRef("");
  const toastTimer = React.useRef(null);
  const pageViewFired = React.useRef(false);
  const formStartedFired = React.useRef(false);
  const formCompletedFired = React.useRef(false);

  const track = (name) => {
    try { if (window.clarity) window.clarity("event", name); } catch {}
    try { if (window.fbq) window.fbq("trackCustom", name); } catch {}
  };

  // Load content + fire page_view once.
  useEffect(() => {
    if (!pageViewFired.current) { pageViewFired.current = true; track("page_view"); }
    fetch("content/variations.json", { cache: "no-cache" })
      .then(r => r.json())
      .then(list => {
        setVariations(list);
        const v = (Array.isArray(list) && list[variationIndex]) || (list && list[0]) || null;
        if (v) { setSubject(v.subject || ""); setBodyText(v.body || ""); }
      })
      .catch(() => setVariations([]));
    fetch("content/recipients.json", { cache: "no-cache" })
      .then(r => r.json())
      .then(list => setRecipients(Array.isArray(list) ? list : []))
      .catch(() => setRecipients([]));
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  };

  const update = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [k]: v }));
    // Debounced capture on every field change — "typing then moving on means
    // done". The debounce reads the freshly-committed formRef.
    scheduleCapture();
  };

  const recipientEmails = () => recipients.map(r => r.email).filter(Boolean).concat(CAMPAIGN_COPY).join(",");

  // Build a FULL snapshot of the current form (no seq). Invalid/partial values
  // are OMITTED entirely: email only when it passes ffbEmailValid, mobile only
  // when ffbNormMobile yields a value (sent normalized), names only when
  // non-empty. A half-typed email therefore never reaches the server.
  function captureSnapshot(extra) {
    const f = formRef.current;
    const utm = new URLSearchParams(window.location.search);
    const p = {
      session_id: sessionId.current,
      variation_shown: variationIndex + 1,
      user_agent: navigator.userAgent,
      consent: true,
      honeypot: f.honeypot || "",
    };
    if (f.first.trim()) p.first_name = f.first.trim();
    if (f.last.trim()) p.last_name = f.last.trim();
    if (ffbEmailValid(f.email)) p.email = f.email.trim();
    const nm = ffbNormMobile(f.mobile);
    if (nm) p.mobile = nm;
    ["utm_source", "utm_medium", "utm_campaign"].forEach(k => {
      const v = utm.get(k); if (v) p[k] = v;
    });
    return { ...p, ...(extra || {}) };
  }

  // The single coalescing sender. Never runs two /api/capture fetches at once:
  // if one is in flight, mark dirty (and remember keepalive) and re-fire with
  // the latest snapshot when it completes. Every dispatched capture carries a
  // fresh monotonic seq.
  function runCapture(keepalive) {
    if (captureInFlight.current) {
      captureDirty.current = true;
      if (keepalive) pendingKeepaliveRef.current = true;
      return;
    }
    captureInFlight.current = true;
    captureDirty.current = false;
    const useKeepalive = keepalive || pendingKeepaliveRef.current;
    pendingKeepaliveRef.current = false;
    const extra = pendingExtraRef.current;
    pendingExtraRef.current = {};
    const snap = captureSnapshot(extra);
    const sig = JSON.stringify(snap);
    const payload = { ...snap, seq: ++seqRef.current };
    fetch("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: !!useKeepalive,
    })
      .then(async (r) => {
        lastSentSnapRef.current = sig;
        const j = await r.json().catch(() => null);
        if (j && j.status === "complete" && !formCompletedFired.current) {
          formCompletedFired.current = true;
          track("form_completed");
        }
      })
      .catch(() => {})
      .finally(() => {
        captureInFlight.current = false;
        if (captureDirty.current) runCapture(false);
      });
  }

  // Debounced capture — used on field CHANGE. ~800ms after typing stops.
  function scheduleCapture() {
    if (captureTimer.current) clearTimeout(captureTimer.current);
    captureTimer.current = setTimeout(() => {
      captureTimer.current = null;
      flushCapture();
    }, 800);
  }

  // Immediate capture — cancels any pending debounce and sends now. Optional
  // extra fields (e.g. send_clicked) and keepalive for unload-time sends.
  function flushCapture(extra, opts) {
    if (captureTimer.current) { clearTimeout(captureTimer.current); captureTimer.current = null; }
    if (extra) pendingExtraRef.current = { ...pendingExtraRef.current, ...extra };
    runCapture(!!(opts && opts.keepalive));
  }

  // Abandon safety net: on tab close / hide, beacon the full snapshot so a
  // half-filled form is still captured. Guarded so it only fires when there's
  // any non-empty field AND the snapshot changed since the last good send.
  function sendAbandonBeacon() {
    try {
      const f = formRef.current;
      const hasAny = !!(f.first.trim() || f.last.trim() || f.email.trim() || f.mobile.trim());
      if (!hasAny) return;
      const snap = captureSnapshot();
      const sig = JSON.stringify(snap);
      if (sig === lastSentSnapRef.current) return;
      const payload = { ...snap, seq: ++seqRef.current };
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        if (navigator.sendBeacon("/api/capture", blob)) lastSentSnapRef.current = sig;
      }
    } catch {}
  }

  useEffect(() => {
    const onHide = () => sendAbandonBeacon();
    const onVis = () => { if (document.visibilityState === "hidden") sendAbandonBeacon(); };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  function onFieldBlur() {
    const f = formRef.current;
    if ((f.first || f.last || f.email || f.mobile) && !formStartedFired.current) {
      formStartedFired.current = true;
      track("form_started");
    }
    flushCapture();
  }

  async function onRewrite() {
    if (rewriteState === "loading") return;
    // Moving on from the details form to reword — flush what they've typed.
    flushCapture();
    track("rewrite_clicked");
    setRewriteState("loading");
    try {
      const r = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId.current,
          subject,
          body: bodyText,
          first_name: formRef.current.first.trim(),
        }),
      });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        setRewriteState(j.reason === "session_limit" ? "session_limit" : "unavailable");
        return;
      }
      if (!r.ok) { setRewriteState("idle"); showToast("Rewrite didn't work — try again"); return; }
      const j = await r.json();
      if (typeof j.subject === "string") setSubject(j.subject);
      if (typeof j.body === "string") setBodyText(j.body);
      setRewriteState("idle");
    } catch { setRewriteState("idle"); showToast("Rewrite didn't work — try again"); }
  }

  function composeBody() {
    // Always sign off with the sender's name AND email so the MP's office
    // can see and reply to a real constituent, even if they edited the body.
    const f = formRef.current;
    const first = f.first.trim(), last = f.last.trim(), em = f.email.trim();
    const name = (first + (last ? " " + last : "")).trim();
    let fb = bodyText.replace(/\s+$/, "");
    if (name && fb.slice(-120).indexOf(first) === -1) fb += `\n\n${name}`;
    if (em && fb.slice(-160).toLowerCase().indexOf(em.toLowerCase()) === -1) fb += `\n${em}`;
    return fb;
  }

  function onSend() {
    const f = formRef.current;
    const e = {};
    if (!f.first.trim()) e.first = "Required";
    if (!f.last.trim()) e.last = "Required";
    if (!ffbEmailValid(f.email)) e.email = "Please check that email address";
    if (!ffbNormMobile(f.mobile)) e.mobile = "Please enter an Australian mobile, e.g. 04XX XXX XXX";
    setErrors(e);
    if (Object.keys(e).length) {
      const el = document.getElementById("ff-email-form");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const fb = composeBody();
    const emails = recipientEmails();
    const mailto = `mailto:${emails}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fb)}`;

    // Fire-and-forget: flag the send without blocking the mail client. Full
    // snapshot + seq via the coalescing sender, keepalive so it survives the
    // mailto navigation.
    flushCapture({ send_clicked: true, sent_subject: subject, sent_body: fb }, { keepalive: true });
    track("send_clicked");

    setSentData({ subject, body: fb, recipients: emails });
    setSent(true);
    try { window.location.href = mailto; } catch {}
  }

  const encodedLen = encodeURIComponent(subject).length
    + encodeURIComponent(bodyText).length
    + recipientEmails().length;
  const counterState = encodedLen > 1900 ? "over" : (encodedLen > 1700 ? "warn" : "ok");

  const copyPiece = (text, msg) => {
    try { navigator.clipboard.writeText(text); } catch {}
    track("fallback_used");
    showToast(msg);
  };

  const pageUrl = (typeof window !== "undefined")
    ? `${window.location.origin}${window.location.pathname}` : "";
  const gmailUrl = () => `https://mail.google.com/mail/?view=cm&fs=1&to=${sentData.recipients}&su=${encodeURIComponent(sentData.subject)}&body=${encodeURIComponent(sentData.body)}`;
  const outlookUrl = () => `https://outlook.office.com/mail/deeplink/compose?to=${sentData.recipients}&subject=${encodeURIComponent(sentData.subject)}&body=${encodeURIComponent(sentData.body)}`;
  const fbShareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`;

  const recipientCount = recipients.length;

  const toastEl = toast ? <div className="ff-email-toast" role="status">{toast}</div> : null;

  // One-click donation from the success screen: straight to Stripe via the
  // shared checkout helper, passing the supporter's email so Stripe prefills
  // and an abandon stays identity-recoverable. Falls back to the tier's
  // Payment Link if the API call fails — never lose the gift.
  const donorTiers = donor.amounts || [];
  const goDonate = async (amt) => {
    if (donateBusy != null) return;
    track("donate_block_click");
    setDonateBusy(amt);
    const email = (formRef.current.email || "").trim();
    if (email) { try { sessionStorage.setItem("ff_email", email); } catch {} }
    try {
      window.location.href = await createDonationCheckout({ amount: amt, frequency: "oneoff", email: email || undefined });
    } catch (e) {
      const tier = donorTiers.find(t => Number(t.amount) === Number(amt));
      const fallbackUrl = (tier && tier.url) || donor.otherUrl;
      if (fallbackUrl) { window.location.href = appendClientRef(fallbackUrl, currentPetitionSlug()); return; }
      setDonateBusy(null);
      alert("Sorry — that didn't go through. Please try again.");
    }
  };

  if (sent) {
    return (
      <PageShell hideTopBanner hideNav={sent}>
        {toastEl}
        <section className="ff-section ff-email-success">
          <div className="ff-wrap ff-email-narrow">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Sent</span>
            <h1 className="ff-h2">Thank you. That one counts.</h1>
            <p className="ff-lede ff-email-lede-wide">You've just done something most people never do: asked politely, in person, for better. If every supporter sends one email and passes this page to a mate, the Liberal Party will hear rural Australia loud and clear before they make their call.</p>

            {donorTiers.length > 0 && (
              <div className="ff-email-donate ff-email-donate--lg">
                <h2 className="ff-email-donate-h">Back your email with a few dollars</h2>
                <p className="ff-email-donate-lede">Emails open the door. Funding keeps the fight alive.</p>
                <div className="ff-email-donate-chips">
                  {donorTiers.map(t => (
                    <button
                      key={t.amount}
                      type="button"
                      className="ff-email-donate-chip"
                      disabled={donateBusy != null}
                      aria-busy={donateBusy === t.amount}
                      onClick={() => goDonate(Number(t.amount))}
                    >
                      {donateBusy === t.amount ? "One moment…" : `$${t.amount}`}
                    </button>
                  ))}
                </div>
                <a className="ff-email-donate-other" href="/donate">Other amount</a>
              </div>
            )}

            <div className="ff-email-share">
              <a className="ff-btn ff-btn--red" href={fbShareUrl} target="_blank" rel="noopener noreferrer" onClick={() => track("fallback_used")}>Share on Facebook</a>
              <button type="button" className="ff-btn ff-btn--outline" onClick={() => copyPiece(pageUrl, "Link copied")}>Copy link</button>
            </div>

            <div className="ff-email-fallback">
              <h3 className="ff-h3">Prefer Gmail or Outlook?</h3>
              <p>No worries. Copy everything below or open a ready-made draft in Gmail or Outlook.</p>
              <div className="ff-email-fallback-btns">
                <button type="button" className="ff-btn ff-btn--outline" onClick={() => copyPiece(sentData.recipients, "Copied")}>Copy recipients</button>
                <button type="button" className="ff-btn ff-btn--outline" onClick={() => copyPiece(sentData.subject, "Copied")}>Copy subject</button>
                <button type="button" className="ff-btn ff-btn--outline" onClick={() => copyPiece(sentData.body, "Copied")}>Copy email</button>
                <a className="ff-btn ff-btn--outline" href={gmailUrl()} target="_blank" rel="noopener noreferrer" onClick={() => track("fallback_used")}>Open in Gmail</a>
                <a className="ff-btn ff-btn--outline" href={outlookUrl()} target="_blank" rel="noopener noreferrer" onClick={() => track("fallback_used")}>Open in Outlook</a>
              </div>
            </div>
          </div>
        </section>
      </PageShell>
    );
  }

  const rewriteBlock = (() => {
    if (rewriteState === "session_limit") {
      return <p className="ff-email-rewrite-note">That's the limit of rewrites for now. You can still edit every word yourself above.</p>;
    }
    if (rewriteState === "unavailable") {
      return <p className="ff-email-rewrite-note">The rewrite tool is having a breather. You can still edit every word yourself above.</p>;
    }
    return (
      <div className="ff-email-rewrite">
        <button type="button" className="ff-btn ff-btn--outline" onClick={onRewrite} disabled={rewriteState === "loading"}>
          {rewriteState === "loading" ? "Rewording your email..." : "Say it my way"}
        </button>
        <span className="ff-email-rewrite-help">Keeps the message, changes the wording so no two emails read the same.</span>
      </div>
    );
  })();

  return (
    <PageShell hideTopBanner>
      {toastEl}

      {/* Hero */}
      <section className="ff-section ff-email-hero">
        <div className="ff-wrap ff-email-narrow">
          <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> AN EARNEST REQUEST FROM RURAL AUSTRALIA</span>
          <h1 className="ff-h2 ff-h2--light">Tell the Victorian Coalition: There's still time to do the right thing.</h1>
          <p className="ff-lede ff-email-lede-light">The Liberal &amp; National Party hasn't locked in its position yet. It's imperative they know rural Australia will not accept the VNI West or Western Renewables Link. Take a moment to tell them!</p>
          <p className="ff-email-hero-nudge">It only takes 10 seconds to tell the Coalition to do the right thing.</p>
          <button type="button" className="ff-btn ff-btn--red ff-btn--lg" onClick={() => { const el = document.getElementById("ff-email-form"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Send your email</button>
        </div>
      </section>

      {/* How it works — compact strip */}
      <section className="ff-section ff-email-steps">
        <div className="ff-wrap ff-email-narrow">
          <div className="ff-email-step">
            <span className="ff-email-step-num">1</span>
            <h3 className="ff-email-step-h">Tell them who you are</h3>
          </div>
          <div className="ff-email-step">
            <span className="ff-email-step-num">2</span>
            <h3 className="ff-email-step-h">Write your message</h3>
          </div>
          <div className="ff-email-step">
            <span className="ff-email-step-num">3</span>
            <h3 className="ff-email-step-h">Send it.</h3>
          </div>
        </div>
      </section>

      {/* Details form */}
      <section className="ff-section ff-email-form-sec" id="ff-email-form">
        <div className="ff-wrap ff-email-narrow">
          <h2 className="ff-h2">Your details</h2>
          <p className="ff-lede">Just enough so the email is genuinely from you. Nothing more.</p>
          <form className="ff-action-form" onSubmit={(e) => e.preventDefault()} noValidate>
            {/* Honeypot — visually hidden, bots fill it */}
            <div className="ff-email-hp" aria-hidden="true">
              <label>Leave this field empty
                <input tabIndex={-1} autoComplete="off" value={form.honeypot} onChange={update("honeypot")} />
              </label>
            </div>
            <div className="ff-form-row">
              <Field label={<>First name <span className="ff-req">*</span></>} error={errors.first}>
                <input value={form.first} onChange={update("first")} onBlur={onFieldBlur} autoComplete="given-name" placeholder="First name" />
              </Field>
              <Field label={<>Last name <span className="ff-req">*</span></>} error={errors.last}>
                <input value={form.last} onChange={update("last")} onBlur={onFieldBlur} autoComplete="family-name" placeholder="Last name" />
              </Field>
            </div>
            <Field label={<>Email <span className="ff-req">*</span></>} error={errors.email}>
              <input type="email" value={form.email} onChange={update("email")} onBlur={onFieldBlur} autoComplete="email" placeholder="Your email address" />
            </Field>
            <Field label={<>Mobile <span className="ff-req">*</span></>} error={errors.mobile}>
              <input type="tel" value={form.mobile} onChange={update("mobile")} onBlur={onFieldBlur} autoComplete="tel" placeholder="Your mobile" />
            </Field>
          </form>
        </div>
      </section>

      {/* Email editor */}
      <section className="ff-section ff-email-editor">
        <div className="ff-wrap ff-email-narrow">
          <h2 className="ff-h2">Prepare your email below</h2>
          <p className="ff-lede ff-email-lede-wide">Firm, fair and polite: take a moment to review your email. You can generate a new email by clicking 'Say it my way'</p>

          <div className="ff-field">
            <span className="ff-field-label">Subject</span>
            <input className="ff-email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => flushCapture()} />
          </div>
          <div className="ff-field">
            <span className="ff-field-label">Email</span>
            <textarea className="ff-email-body" rows={14} value={bodyText} onChange={(e) => setBodyText(e.target.value)} onFocus={() => flushCapture()} />
          </div>

          {rewriteBlock}

          <div className={`ff-email-counter ff-email-counter--${counterState}`}>
            <span className="ff-email-counter-num">{encodedLen} / ~1900</span>
          </div>
        </div>
      </section>

      {/* Send */}
      <section className="ff-section ff-email-send">
        <div className="ff-wrap ff-email-narrow">
          {recipients.length > 0 && (
            <div className="ff-email-recipients">
              <div className="ff-email-recipients-h">This email goes to {recipientCount} Liberal {recipientCount === 1 ? "leader" : "leaders"}:</div>
              <ul>
                {recipients.map((r, i) => (
                  <li key={i}><strong>{r.name}</strong>{r.role ? <span> — {r.role}</span> : null}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="ff-btn ff-btn--red ff-btn--block ff-btn--lg" onClick={onSend}>Send your email to the Libs/Nationals now <span aria-hidden="true">→</span></button>
          <p className="ff-email-reassure">Your email app opens with everything ready. It sends from your address, in your name. Personal emails get read. Form letters get filed.</p>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- Donor webinar (private, token-gated) ----------
// Reachable only via /webinar/<session>?t=TOKEN — intentionally NOT linked
// from any nav or take-action surface. The signed token in the invite email
// is the access gate; no token (or a bad one) shows the private-invite state.
// Times render in the visitor's own timezone, with the event's Melbourne
// time alongside when the two differ (spec §8).

function webinarFmtTime(iso, zone) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}
function webinarFmtDay(iso, zone) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

// AU timezones the visitor can switch between, and the derived city label.
const WEBINAR_AU_ZONES = [
  "Australia/Perth", "Australia/Adelaide", "Australia/Darwin",
  "Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Hobart",
];
function webinarCityFromZone(zone) {
  // City = the part of the IANA zone after "/", "_" → " ", uppercased.
  const part = (zone || "").split("/")[1] || zone || "";
  return part.replace(/_/g, " ").toUpperCase();
}

function WebinarWhen({ event }) {
  if (!event || !event.starts_at_utc) return null;
  let browserZone = "";
  try { browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  const [zone, setZone] = useState(browserZone || event.timezone);
  const [picking, setPicking] = useState(false);
  const city = webinarCityFromZone(zone);
  const localDay = webinarFmtDay(event.starts_at_utc, zone);
  const localTime = webinarFmtTime(event.starts_at_utc, zone);
  // The event's own (Melbourne) clock time, shown alongside so a visitor in
  // Perth never reads their local "5:00 PM" as the Melbourne start time.
  const eventTime = webinarFmtTime(event.starts_at_utc, event.timezone);
  // Zone options: always offer the AU set, plus the visitor's detected zone
  // if it isn't already one of them.
  const zoneOpts = WEBINAR_AU_ZONES.includes(zone) ? WEBINAR_AU_ZONES : [zone, ...WEBINAR_AU_ZONES];
  return (
    <div className="ffw-when-wrap">
      <div className="ffw-when">
        <div className="ffw-when-top">
          <div className="ffw-when-main">
            <div className="ffw-when-label">In your time · {city}</div>
            <div className="ffw-when-time">{localTime}</div>
          </div>
          <div className="ffw-when-rule" />
          <div className="ffw-when-meta">
            <span className="ffw-when-date">{localDay}</span>
            <br /><span className="ffw-when-mel">Live from Melbourne · {eventTime}</span>
          </div>
        </div>
        <div className="ffw-when-online">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>
          Online webinar
        </div>
      </div>
      {picking ? (
        <select
          className="ffw-when-select"
          value={zone}
          onChange={(e) => { setZone(e.target.value); }}
          aria-label="Choose your timezone"
        >
          {zoneOpts.map((z) => (
            <option key={z} value={z}>{webinarCityFromZone(z)}</option>
          ))}
        </select>
      ) : (
        <button type="button" className="ffw-when-change" onClick={() => setPicking(true)}>
          Not in {city}? Change timezone →
        </button>
      )}
      <p className="ffw-when-help">Online briefing · we'll show the time in your own city when you open the page.</p>
    </div>
  );
}

// Attendance options: [POST value (strict), button label shown to the user].
const WEBINAR_INTENTS = [
  ["Attending", "I'll be there"],
  ["Maybe", "Maybe"],
  ["Can't attend", "Can't make it"],
];

// Confirmation-screen donation matrix. Reuses the site donorPage amount ladder
// and the shared /api/checkout helper (with a webinar slug + the registrant's
// email), plus the Payment-Link fallback for one-off gifts.
function WebinarDonate({ email }) {
  const donor = useContent().donorPage || {};
  const tiers = donor.amounts || [];
  const [monthly, setMonthly] = useState(false);
  const [picked, setPicked] = useState(65);
  const [busy, setBusy] = useState(false);
  useBfcacheReset(() => setBusy(false));
  const base = tiers.find((t) => Number(t.amount) === picked) ? picked : (tiers[1] && tiers[1].amount) || (tiers[0] && tiers[0].amount) || 65;
  const amount = monthly ? monthlyFor(base) : base;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    const frequency = monthly ? "monthly" : "oneoff";
    try {
      window.location.href = await createDonationCheckout({ amount, frequency, email, slug: "webinar" });
    } catch (e) {
      const selected = tiers.find((t) => Number(t.amount) === base);
      const fallbackUrl = (!monthly && selected && selected.url) || donor.otherUrl;
      if (!monthly && fallbackUrl) { window.location.href = fallbackUrl; return; }
      setBusy(false);
      alert("Sorry — that didn't go through. Please try again.");
    }
  };
  return (
    <div className="ffw-donate">
      <div className="ffw-kicker ffw-kicker--red"><span className="ffw-star">★</span> Chip in while you're here</div>
      <h2 className="ffw-donate-title">Donate to the farmers fighting back</h2>
      <p className="ffw-card-sub">We're a citizen-funded movement. Every dollar keeps us at the gate.</p>
      <div className="ffw-donate-toggle" role="group" aria-label="Donation frequency">
        <button type="button" className={`ffw-donate-tab ${!monthly ? "is-on" : ""}`} aria-pressed={!monthly} onClick={() => setMonthly(false)}>Give once</button>
        <button type="button" className={`ffw-donate-tab ${monthly ? "is-on" : ""}`} aria-pressed={monthly} onClick={() => setMonthly(true)}>Monthly</button>
      </div>
      <div className="ffw-donate-chips">
        {tiers.map((t) => {
          const shown = monthly ? monthlyFor(t.amount) : t.amount;
          return (
            <button
              key={t.amount}
              type="button"
              className={`ffw-donate-chip ${base === t.amount ? "is-on" : ""}`}
              aria-pressed={base === t.amount}
              onClick={() => setPicked(t.amount)}
            >${shown}{monthly ? "/mo" : ""}</button>
          );
        })}
      </div>
      <button type="button" className="ff-btn ff-btn--red ff-btn--block ffw-submit ffw-donate-btn" disabled={busy} onClick={go}>
        {busy ? "One moment…" : `Donate $${amount}${monthly ? " / month" : ""} →`}
      </button>
      <p className="ffw-fine ffw-donate-fine">Secure payment · you can cancel a monthly gift any time.</p>
    </div>
  );
}

function WebinarPage() {
  // Slug is the last path segment: /supporters210726 (new, no /webinar/
  // prefix) or a legacy /webinar/<slug>. Either way take the final segment.
  const session = (window.location.pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
  const token = new URLSearchParams(window.location.search).get("t") || "";
  // Open mode = no token in the URL. The server decides whether the event is
  // actually open (200 → form) or private (403 → notice); the client just
  // sends the email along so open registrations/questions can be linked.
  const openMode = !token;

  const [phase, setPhase] = useState("loading"); // loading | private | form | confirmed
  const [event, setEvent] = useState(null);
  const [joinUrl, setJoinUrl] = useState(null);
  const [form, setForm] = useState({ first_name: "", last_name: "", email: "", mobile: "", postcode: "" });
  // Personalisation mode is driven by whether the context returned a prefilled
  // first name: a valid token → non-empty name → the personalised "invite"
  // hero; an open/no-token visit → empty prefill → the public hero variant.
  const [invited, setInvited] = useState(false);
  const [heroName, setHeroName] = useState("");
  const [intent, setIntent] = useState("Attending");
  const [sendBriefing, setSendBriefing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // Q&A state (confirmation screen).
  const [question, setQuestion] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [qThanks, setQThanks] = useState(false);
  const [qError, setQError] = useState("");

  useEffect(() => {
    // Always ask the server — it decides open (200) vs private (403). Send an
    // empty t when there's no token; open events render the form to everyone.
    fetch(`/api/webinar-context?session=${encodeURIComponent(session)}&t=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        setEvent(d.event || null);
        setJoinUrl((d.event && d.event.join_url) || null);
        const prefillName = ((d.prefill && d.prefill.first_name) || "").trim();
        setInvited(Boolean(prefillName));
        setHeroName(prefillName);
        setForm((f) => ({
          first_name: (d.prefill && d.prefill.first_name) || f.first_name,
          last_name: (d.prefill && d.prefill.last_name) || f.last_name,
          email: (d.prefill && d.prefill.email) || f.email,
          mobile: (d.prefill && d.prefill.mobile) || f.mobile,
          postcode: (d.prefill && d.prefill.postcode) || f.postcode,
        }));
        setPhase("form");
      })
      .catch(() => setPhase("private"));
  }, []);

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submitRegistration = async (e) => {
    e.preventDefault();
    setFormError("");
    if (!form.first_name.trim()) { setFormError("Please add your first name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setFormError("Please enter a valid email address."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/webinar-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          t: token,
          session,
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          mobile: form.mobile.trim(),
          postcode: form.postcode.trim(),
          attendance_intent: intent,
          send_briefing: sendBriefing,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 403) { setPhase("private"); return; }
        setFormError(d.error || "Something went wrong. Please try again.");
        return;
      }
      setJoinUrl(d.join_url || null);
      setPhase("confirmed");
      window.scrollTo(0, 0);
    } catch {
      setFormError("Something went wrong. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitQuestion = async (e) => {
    e.preventDefault();
    setQError("");
    setQThanks(false);
    if (!question.trim()) { setQError("Write your question or comment first."); return; }
    setQBusy(true);
    try {
      const r = await fetch("/api/webinar-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, session, body: question.trim().slice(0, 2000), ...(openMode ? { email: form.email.trim() } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setQError(d.error || "Couldn't send that. Please try again.");
        return;
      }
      setQuestion("");
      setQThanks(true);
    } catch {
      setQError("Couldn't send that. Please check your connection and try again.");
    } finally {
      setQBusy(false);
    }
  };

  // Per-mode copy: personalised "invite" hero for a valid token, public
  // "supporter" hero for an open/no-token visit. Same layout either way —
  // only the top bar, kicker, headline and subhead swap.
  const copy = invited
    ? {
        topbar: "Private donor briefing · by invitation only",
        badge: `Your invite · ${heroName}`,
        kicker: "Into the inner circle",
        headline: `Come inside the campaign, ${heroName}.`,
        sub: "You've done more than sign — you've backed this fight. We're bringing our closest supporters into the room for a private briefing on where the campaign goes next. Confirm your seat below.",
        cardTitle: "Confirm your seat",
        cardSub: "We've filled in what we know — please check it's right.",
        submit: "Confirm my webinar ticket",
        submitNote: "This link is yours alone — unregistered or shared links will not be allowed.",
      }
    : {
        topbar: "Supporter briefing",
        badge: "",
        kicker: "Come inside the campaign",
        headline: "Come inside the campaign.",
        sub: "A private briefing for our closest supporters. Confirm your seat below.",
        cardTitle: "Grab your seat",
        cardSub: "Tell us where to send your join link.",
        submit: "Reserve my seat",
        submitNote: "We'll email your private join link before the briefing.",
      };

  const agenda = [
    ["Campaign update", "Ben walks you through where the fight stands and what's coming next."],
    ["Q&A of your questions", "A live Q&A answering the questions you send in when you register."],
  ];

  const confirmName = form.first_name.trim();

  return (
    <div className="ffw">
      <header className="ffw-header ffw-header--center">
        <a href="/" className="ffw-logo" aria-label="Farmers Fightback — back to homepage">
          <img src="/assets/uploads/ff-logo-white.png" alt="Farmers Fightback" />
        </a>
        {copy.badge && <span className="ffw-badge">{copy.badge}</span>}
      </header>

      {(phase === "loading" || phase === "private") ? (
        <div className="ffw-notice-wrap">
          <div className="ffw-notice">
            <div className="ffw-kicker ffw-kicker--red"><span className="ffw-star">★</span> Donor briefing</div>
            {phase === "loading" ? (
              <>
                <h1 className="ffw-notice-title">One moment…</h1>
                <p className="ffw-notice-text">Checking your invitation.</p>
              </>
            ) : (
              <>
                <h1 className="ffw-notice-title">This invitation is private.</h1>
                <p className="ffw-notice-text">This briefing is invite-only. If you're a Farmers Fightback supporter, use the personal link from your invite email.</p>
                <p className="ffw-notice-fine">Not sure? Reply to your invite email and we'll sort it.</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="ffw-hero">
            <img className="ffw-hero-bg" src="/assets/uploads/webinar-hero-fire.jpg" alt="" aria-hidden="true" />
            <div className="ffw-hero-scrim" />
            <div className="ffw-hero-inner">
              <div className="ffw-kicker ffw-kicker--ondark"><span className="ffw-star">★</span> {copy.kicker}</div>
              <h1 className="ffw-hero-title">{copy.headline}</h1>
              <p className="ffw-hero-sub">{copy.sub}</p>
              {event && <WebinarWhen event={event} />}
            </div>
          </div>

          <div className="ffw-body">
            <div className="ffw-agenda">
              <div className="ffw-kicker ffw-kicker--red"><span className="ffw-star">★</span> What we'll cover</div>
              <h2 className="ffw-agenda-title">An intimate 30 minutes with Ben from Farmers Fightback.</h2>
              <ol className="ffw-agenda-list">
                {agenda.map(([t, d]) => (
                  <li className="ffw-agenda-item" key={t}>
                    <span className="ffw-agenda-badge">15 min</span>
                    <div className="ffw-agenda-copy">
                      <div className="ffw-agenda-name">{t}</div>
                      <p className="ffw-agenda-desc">{d}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="ffw-agenda-note">
                <svg className="ffw-agenda-note-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>
                <span>Full session details will be released closer to the webinar date — please keep tuned.</span>
              </div>
              <p className="ffw-host">Hosted by <strong>Ben Duxson</strong> and the Farmers Fightback campaign team.</p>
            </div>

            <div className="ffw-card">
              {phase === "form" ? (
                <>
                  <div className="ffw-card-head">
                    <div className="ffw-card-title">{copy.cardTitle}</div>
                    <p className="ffw-card-sub">{copy.cardSub}</p>
                  </div>
                  <form className="ffw-form ff-webinar-form" onSubmit={submitRegistration} noValidate>
                    <div className="ff-form-row">
                      <Field label={<>First name <span className="ff-req">*</span></>}>
                        <input value={form.first_name} onChange={update("first_name")} autoComplete="given-name" required aria-required="true" />
                      </Field>
                      <Field label="Last name">
                        <input value={form.last_name} onChange={update("last_name")} autoComplete="family-name" />
                      </Field>
                    </div>
                    <Field label={<>Email <span className="ff-req">*</span></>}>
                      <input type="email" value={form.email} onChange={update("email")} placeholder="you@example.com" autoComplete="email" required aria-required="true" />
                    </Field>
                    <div className="ff-form-row ff-form-row--split">
                      <Field label="Mobile">
                        <input type="tel" value={form.mobile} onChange={update("mobile")} placeholder="0400 000 000" autoComplete="tel" />
                      </Field>
                      <Field label="Postcode">
                        <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4} placeholder="3000" autoComplete="postal-code" />
                      </Field>
                    </div>
                    <div className="ff-field">
                      <span className="ff-field-label">Will you be joining us?</span>
                      <div className="ff-webinar-intent" role="radiogroup" aria-label="Attendance">
                        {WEBINAR_INTENTS.map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={intent === value}
                            className={`ff-webinar-intent-btn ${intent === value ? "is-on" : ""}`}
                            onClick={() => setIntent(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="ffw-briefing">
                      <input type="checkbox" checked={sendBriefing} onChange={(e) => setSendBriefing(e.target.checked)} />
                      <span>Send me a briefing if I can't make it.</span>
                    </label>
                    <button className="ff-btn ff-btn--red ff-btn--block ffw-submit" type="submit" disabled={busy}>
                      {busy ? "Confirming…" : `${copy.submit} →`}
                    </button>
                    {formError && <p className="ffw-fine" style={{ color: "var(--ff-red)" }}>{formError}</p>}
                    <p className="ffw-fine">{copy.submitNote}</p>
                  </form>
                </>
              ) : (
                <div className="ffw-confirmed">
                  <div className="ffw-confirmed-head">
                    <div className="ffw-check" aria-hidden="true">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FBF7EE" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 6.5" /></svg>
                    </div>
                    <div className="ffw-card-title">{confirmName ? `You're confirmed, ${confirmName}.` : "You're confirmed."}</div>
                    <p className="ffw-card-sub">You're on the list. We'll email your private join link before the day begins.</p>
                    {joinUrl && <a href={joinUrl} className="ff-btn ff-btn--red ff-btn--block ffw-submit ffw-join" target="_blank" rel="noopener noreferrer">Join the briefing →</a>}
                  </div>
                  {/* Donation matrix sits ABOVE the Q&A per the approved flow. */}
                  <WebinarDonate email={form.email.trim()} />
                  <div className="ffw-qa">
                    <div className="ffw-kicker ffw-kicker--red"><span className="ffw-star">★</span> Ask the panel</div>
                    <h2 className="ffw-qa-title">Got a question for the briefing?</h2>
                    <form onSubmit={submitQuestion} noValidate>
                      <textarea
                        className="ffw-qa-input"
                        value={question}
                        onChange={(e) => { setQuestion(e.target.value); if (qThanks) setQThanks(false); }}
                        maxLength={2000}
                        rows={3}
                        placeholder="What would you like the campaign to cover?"
                        aria-label="Your question or comment"
                      />
                      <div className="ffw-qa-row">
                        <span className="ffw-qa-note">Read and curated before the night — we see every one.</span>
                        <button className="ff-btn ff-btn--red ffw-qa-btn" type="submit" disabled={qBusy}>
                          {qBusy ? "Sending…" : "Send question"}
                        </button>
                      </div>
                      {qThanks && <p className="ffw-qa-thanks">Thanks — we've got it.</p>}
                      {qError && <p className="ffw-fine" style={{ color: "var(--ff-red)" }}>{qError}</p>}
                    </form>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <footer className="ffw-footer">
        <img src="/assets/uploads/ff-logo-white.png" alt="Farmers Fightback" className="ffw-footer-logo" />
        <p className="ffw-footer-text">Fighting for farmers, food &amp; our future · Kanya, VIC<br />A private invitation for supporters of Farmers Fightback.</p>
      </footer>
    </div>
  );
}

function App() {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const attr = captureAttribution();
    // Share Click beacon: when a visitor lands with ?ref=CODE, log a load
    // event on the referrer's contact. Once per ref code per session so
    // back/forward nav and same-tab re-loads don't double-log.
    if (attr && attr.ref) {
      try {
        const code = String(attr.ref).toUpperCase();
        const key = `ff_ref_click_fired_${code}`;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          fetch("/api/share-click", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ref: code,
              source_url: attr.landing_url || window.location.href,
              fbclid: attr.fbclid || undefined,
            }),
            keepalive: true,
          }).catch(() => {});
        }
      } catch {}
    }
    fetch(CONTENT_URL, { cache: "no-cache" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((c) => {
        setContent(c);
        // Live signature counter (WS3): render static content immediately,
        // then patch every master-derived count once the live number lands.
        fetch("/api/signature-count")
          .then(r => (r.ok ? r.json() : null))
          .then(live => { if (live) setContent(cur => applyLiveSignatureCount(cur || c, live)); })
          .catch(() => {});
      })
      .catch(e => setError(e.message || "Failed to load content"));
  }, []);

  if (error) {
    return (
      <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: "system-ui" }}>
        <h2>Couldn't load site content</h2>
        <p style={{ color: "#666" }}>Could not fetch <code>{CONTENT_URL}</code> ({error}).</p>
      </div>
    );
  }
  if (!content) return null;

  const root = document.getElementById("root");
  const page = (root && root.dataset && root.dataset.page) || "home";
  const slug = (root && root.dataset && root.dataset.petition) || "";

  let view;
  if (page === "news") view = <NewsPage />;
  else if (page === "take-action") view = <TakeActionIndex />;
  else if (page === "petition") view = <PetitionPage slug={slug} />;
  else if (page === "the-fight") view = <TheFightPage />;
  else if (page === "contact") view = <ContactPage />;
  else if (page === "media") view = <MediaPage />;
  else if (page === "donate") view = <DonorPage />;
  else if (page === "volunteer") view = <VolunteerPage />;
  else if (page === "share") view = <ShareThanksPage />;
  else if (page === "send-email") view = <SendEmailPage />;
  else if (page === "webinar") view = <WebinarPage />;
  else view = <HomePage />;

  return <ContentContext.Provider value={content}>{view}</ContentContext.Provider>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
