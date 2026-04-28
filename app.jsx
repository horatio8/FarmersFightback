/* global React, ReactDOM */
const { useState, useEffect, useRef } = React;

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

// ---------- Navigation ----------
function TopBanner() {
  return (
    <div className="ff-topbanner">
      <div className="ff-wrap ff-topbanner-inner">
        <span className="ff-topbanner-pulse" />
        <span>
          <strong>23,418 Australians</strong> have signed the petition — add your name.
        </span>
        <a href="#petition" className="ff-topbanner-link">Sign now →</a>
      </div>
    </div>
  );
}

function Nav({ onDonate }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const items = [
    { label: "Home", href: "#home", active: true },
    { label: "The Evidence", href: "#evidence" },
    { label: "News", href: "#news" },
    { label: "Know Your Rights", href: "#rights" },
    { label: "Hold the Gate", href: "#gate" },
    { label: "About", href: "#about" },
  ];
  return (
    <nav className={`ff-nav ${scrolled ? "is-scrolled" : ""}`}>
      <div className="ff-wrap ff-nav-inner">
        <a href="#home" className="ff-logo" aria-label="Farmers Fightback home">
          <img src="assets/logo.png" alt="Farmers Fightback" />
        </a>
        <ul className="ff-nav-list">
          {items.map(i => (
            <li key={i.label}>
              <a href={i.href} className={i.active ? "is-active" : ""}>{i.label}</a>
            </li>
          ))}
        </ul>
        <div className="ff-nav-actions">
          <button className="ff-btn ff-btn--red" onClick={onDonate}>Donate</button>
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
          {items.map(i => (
            <a key={i.label} href={i.href} onClick={() => setOpen(false)}>{i.label}</a>
          ))}
        </div>
      )}
    </nav>
  );
}

// ---------- Hero (cinematic) ----------
function Hero({ onWatch }) {
  return (
    <section id="home" className="ff-hero ff-hero--cinematic">
      <Placeholder
        label="HERO · PROTEST CONVOY AT PARLIAMENT"
        ratio="auto"
        tone="dust"
        className="ff-hero-bg"
      />
      <div className="ff-hero-scrim" />
      <div className="ff-wrap ff-hero-content">
        <span className="ff-eyebrow ff-eyebrow--light">
          <span className="ff-eyebrow-dot" /> Wallaloo &amp; Gre Gre · Western Victoria
        </span>
        <h1 className="ff-hero-title">
          Fighting for <em>farmers</em>,<br/>
          food &amp; <em>our future</em>.
        </h1>
        <p className="ff-hero-sub">
          23,000+ Australians standing against the $11.4B VNI West transmission line —
          and the corporate thugs sent to bully farmers off their own land.
        </p>
        <div className="ff-hero-cta">
          <a href="#petition" className="ff-btn ff-btn--red ff-btn--lg">Sign the petition</a>
          <button className="ff-btn ff-btn--ghost ff-btn--lg" onClick={onWatch}>
            <span className="ff-play">▶</span> Watch the evidence
          </button>
        </div>
        <div className="ff-hero-meta">
          <span>4 videos released</span>
          <span className="ff-dot">•</span>
          <span>3 media statements</span>
          <span className="ff-dot">•</span>
          <span>As seen on ABC, 7News &amp; The Weekly Times</span>
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
  const stats = [
    { value: 23418, label: "Signatures", suffix: "", grow: "+1,204 this week" },
    { value: 4,     label: "Videos released", suffix: "", grow: "Evidence archive" },
    { value: 3,     label: "Media statements", suffix: "", grow: "ABC · 7News · WTimes" },
    { value: 187,   label: "Farms affected", suffix: "", grow: "Across 3 LGAs" },
  ];
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
  return (
    <section className="ff-section ff-intro">
      <div className="ff-wrap ff-intro-inner">
        <div className="ff-intro-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Who we are</span>
          <h2 className="ff-h2">A farmer-led fight for the food bowl of Victoria.</h2>
          <p className="ff-lede">
            We're the families, neighbours and tradies of Wallaloo &amp; Gre Gre —
            and the 23,000+ Australians standing with us. Here's the story in a couple of minutes.
          </p>
        </div>
        <div className="ff-intro-player">
          <video controls playsInline muted loop autoPlay preload="metadata">
            <source
              src="https://loyyrnblwqdxflobrbms.supabase.co/storage/v1/object/public/Public%20Assets/Farmers%20Fightback%20Video.mp4"
              type="video/mp4"
            />
            Your browser doesn't support embedded video.
          </video>
        </div>
      </div>
    </section>
  );
}

// ---------- Latest video ----------
function LatestVideo({ onOpen }) {
  const [playing, setPlaying] = useState(false);
  return (
    <section id="evidence" className="ff-section ff-video">
      <div className="ff-wrap ff-video-inner">
        <div className="ff-video-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Latest evidence · Video 4</span>
          <h2 className="ff-h2">
            "This'll be used as <em>evidence against you.</em>"
          </h2>
          <p className="ff-lede">
            Filmed at dawn during lambing. Maiden ewes scattered across the paddock.
            A contractor reads from a script, threatens a half-million-dollar fine,
            and demands access the landholder never agreed to.
          </p>
          <ul className="ff-video-meta">
            <li><strong>Filmed</strong> April 2026</li>
            <li><strong>Location</strong> Western Victoria</li>
            <li><strong>Runtime</strong> 3:42</li>
          </ul>
          <div className="ff-video-actions">
            <a href="#evidence" className="ff-link ff-link--red">See all 4 videos →</a>
            <a href="#rights" className="ff-link">Read your legal rights →</a>
          </div>
        </div>
        <button
          className={`ff-video-player ${playing ? "is-playing" : ""}`}
          onClick={() => { setPlaying(true); onOpen?.(); }}
          aria-label="Play Video 4"
        >
          <Placeholder label="VIDEO 4 · LAMBING SEASON · 3:42" ratio="16/9" tone="paddock" />
          <div className="ff-video-overlay">
            <div className="ff-video-play">▶</div>
            <div className="ff-video-timecode">03:42</div>
            <div className="ff-video-caption">
              <span className="ff-video-badge">NEW</span>
              Video 4 — "Corporate thugs threaten $500K fine"
            </div>
          </div>
        </button>
      </div>
    </section>
  );
}

// ---------- Campaign summary + map ----------
function Summary() {
  return (
    <section className="ff-section ff-summary">
      <div className="ff-wrap ff-summary-inner">
        <div className="ff-summary-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> What's at stake</span>
          <h2 className="ff-h2">The $11.4 billion line they're bulldozing through our food bowl.</h2>
          <p>
            <strong>VNI West</strong> is a 400-kilometre high-voltage transmission line
            proposed to cut through some of Victoria's most productive cropping and grazing country.
            Farmers were never meaningfully consulted. Alternative routes were never seriously considered.
          </p>
          <p>
            Behind it sits AEMO, AusNet, and <strong>Iberdrola</strong> — an €80-billion Spanish
            multinational now sending contractors onto family farms, unannounced,
            with threats and clipboards.
          </p>
          <p>
            We're a farmer-led coalition from the Wallaloo &amp; Gre Gre district.
            We're not anti-renewables. We're anti being walked over.
          </p>
          <div className="ff-summary-stats">
            <div><div className="ff-stat-n">400<span>km</span></div><div className="ff-stat-l">Transmission corridor</div></div>
            <div><div className="ff-stat-n">$11.4<span>B</span></div><div className="ff-stat-l">Project cost</div></div>
            <div><div className="ff-stat-n">€80<span>B</span></div><div className="ff-stat-l">Iberdrola market cap</div></div>
          </div>
        </div>
        <div className="ff-summary-map">
          <div className="ff-map-frame">
            <Placeholder label="" ratio="4/5" tone="paddock" />
            <svg className="ff-map-overlay" viewBox="0 0 400 500" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="8" height="8" fill="rgba(198,40,40,0.18)"/>
                  <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(198,40,40,0.55)" strokeWidth="2"/>
                </pattern>
              </defs>
              <path d="M40,80 Q120,60 180,120 T300,200 Q340,260 320,340 T240,440 Q160,460 100,400 T40,280 Z" fill="url(#hatch)" stroke="#C62828" strokeWidth="2"/>
              <path d="M20,40 C120,140 220,240 380,460" stroke="#C62828" strokeWidth="3" strokeDasharray="6 6" fill="none"/>
              <circle cx="90" cy="130" r="5" fill="#C62828"/>
              <circle cx="180" cy="220" r="5" fill="#C62828"/>
              <circle cx="260" cy="310" r="5" fill="#C62828"/>
              <circle cx="330" cy="400" r="5" fill="#C62828"/>
            </svg>
            <div className="ff-map-legend">
              <div><span className="ff-legend-sw ff-legend-sw--hatch"/> Affected farmland</div>
              <div><span className="ff-legend-sw ff-legend-sw--line"/> VNI West corridor</div>
              <div><span className="ff-legend-sw ff-legend-sw--dot"/> Documented incidents</div>
            </div>
            <div className="ff-map-compass">N</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Petition form ----------
const PETITION_RECEIVER = "https://teller.campaignnucleus.com/forms/receiver/de602723-dce3-4a83-ab0b-b8156faf01e2";

function Petition() {
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "", affected: "" });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle"); // idle | submitting | done | error
  const update = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (form.postcode && !/^\d{4}$/.test(form.postcode)) e.postcode = "4-digit postcode";
    if (!form.affected) e.affected = "Please choose";
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setState("submitting");
    const body = new URLSearchParams({
      first_name: form.first.trim(),
      last_name: form.last.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      postcode: form.postcode.trim(),
    });
    try {
      await fetch(PETITION_RECEIVER, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      setState("done");
    } catch (err) {
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <section id="petition" className="ff-section ff-petition">
        <div className="ff-wrap ff-petition-inner ff-petition-done">
          <div className="ff-petition-copy">
            <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Signed · Thank you</span>
            <h2 className="ff-h2">You just became number <em>{(23419).toLocaleString()}</em>.</h2>
            <p className="ff-lede">
              Welcome to the fight, {form.first}. We'll email you when the next video drops
              and when farmers need backup at the gate.
            </p>
            <div className="ff-petition-next">
              <a href="#donate" className="ff-btn ff-btn--red">Chip in to the fight</a>
              <button className="ff-btn ff-btn--outline" onClick={() => {
                const text = "I just signed the Farmers Fightback petition. Join 23,000+ Australians: farmersfightback.com";
                navigator.clipboard?.writeText(text);
                alert("Share link copied — paste it anywhere.");
              }}>Share with your mates</button>
            </div>
          </div>
          <div className="ff-petition-thanks">
            <div className="ff-petition-tally">
              <div className="ff-tally-num">23,419</div>
              <div className="ff-tally-label">Signatures and counting</div>
              <div className="ff-tally-bar"><div className="ff-tally-fill" style={{ width: "46.8%" }}/></div>
              <div className="ff-tally-goal">46.8% toward our 50,000 goal</div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="petition" className="ff-section ff-petition">
      <div className="ff-wrap ff-petition-inner">
        <div className="ff-petition-copy">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> Sign the petition</span>
          <h2 className="ff-h2">Add your name. Draw the line.</h2>
          <p className="ff-lede">
            Every signature is a letter to Spring Street and Canberra.
            It tells them Victorian farmers aren't a speed bump —
            and it tells the next farmer facing a contractor at the gate that they're not alone.
          </p>
          <div className="ff-petition-bullets">
            <div><span className="ff-check">✓</span> Your details stay on-shore and are never sold</div>
            <div><span className="ff-check">✓</span> Weekly campaign updates — unsubscribe any time</div>
            <div><span className="ff-check">✓</span> Authorised by Ben Duxson, Wallaloo VIC</div>
          </div>
        </div>
        <form className="ff-petition-form" onSubmit={submit} noValidate>
          <div className="ff-form-header">
            <div>
              <div className="ff-form-count">23,418</div>
              <div className="ff-form-count-l">have already signed — 1,582 to 25k</div>
            </div>
            <div className="ff-form-bar"><div style={{ width: "93.7%" }}/></div>
          </div>
          <div className="ff-form-row">
            <Field label="First name" error={errors.first}>
              <input value={form.first} onChange={update("first")} autoComplete="given-name"/>
            </Field>
            <Field label="Last name" error={errors.last}>
              <input value={form.last} onChange={update("last")} autoComplete="family-name"/>
            </Field>
          </div>
          <Field label="Email" error={errors.email}>
            <input type="email" value={form.email} onChange={update("email")} autoComplete="email"/>
          </Field>
          <div className="ff-form-row">
            <Field label="Phone (optional)">
              <input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel"/>
            </Field>
            <Field label="Postcode" error={errors.postcode}>
              <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4}/>
            </Field>
          </div>
          <Field label="Are you a directly affected landowner?" error={errors.affected}>
            <div className="ff-radio-row">
              {["Yes, on the corridor", "Yes, neighbouring", "No, standing with them"].map(opt => (
                <label key={opt} className={`ff-radio ${form.affected === opt ? "is-on" : ""}`}>
                  <input type="radio" name="affected" value={opt} checked={form.affected===opt} onChange={update("affected")}/>
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          </Field>
          <button className="ff-btn ff-btn--red ff-btn--block" disabled={state==="submitting"}>
            {state === "submitting" ? "Signing..." : "Sign the petition"}
          </button>
          {state === "error" && (
            <p className="ff-form-fine" style={{ color: "var(--ff-red)" }}>
              Something went wrong sending that. Please check your connection and try again.
            </p>
          )}
          <p className="ff-form-fine">
            By signing, you agree to receive campaign updates. Authorised by Ben Duxson,
            Wallaloo &amp; Gre Gre District Association.
          </p>
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
  const cards = [
    {
      kicker: "01 / Evidence",
      title: "Watch what's happening on our farms",
      body: "Four videos. Four confrontations. Zero filter. Start with Video 4 — the lambing-season threat.",
      cta: "See all four videos",
      href: "#evidence",
      tone: "paddock",
      label: "VIDEO THUMB · VIDEO 4",
    },
    {
      kicker: "02 / Rights",
      title: "Know your rights before they knock",
      body: "Section 93 notices, the Land Access Code, your right to record. Plain English. Free template letters.",
      cta: "Read the guide",
      href: "#rights",
      tone: "dust",
      label: "PHOTO · GATE + PADLOCK",
    },
    {
      kicker: "03 / Gate",
      title: "Join Hold the Gate",
      body: "A statewide network of farmers, neighbours and witnesses. When the contractors come, we come too.",
      cta: "Find your local group",
      href: "#gate",
      tone: "red",
      label: "PHOTO · COMMUNITY HALL",
    },
  ];
  return (
    <section className="ff-section ff-actions">
      <div className="ff-wrap">
        <div className="ff-actions-head">
          <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> How you can help</span>
          <h2 className="ff-h2">Three ways to hold the line.</h2>
        </div>
        <div className="ff-actions-grid">
          {cards.map((c, i) => <ActionCard key={i} {...c} />)}
        </div>
      </div>
    </section>
  );
}

function ActionCard({ kicker, title, body, cta, href, tone, label }) {
  return (
    <a href={href} className="ff-card">
      <div className="ff-card-media">
        <Placeholder label={label} ratio="4/3" tone={tone} />
      </div>
      <div className="ff-card-body">
        <span className="ff-card-kicker">{kicker}</span>
        <h3 className="ff-card-title">{title}</h3>
        <p className="ff-card-copy">{body}</p>
        <span className="ff-card-cta">{cta} <span>→</span></span>
      </div>
    </a>
  );
}

// ---------- Quote / farmer voice ----------
function Quote() {
  return (
    <section className="ff-section ff-quote">
      <div className="ff-wrap ff-quote-inner">
        <div className="ff-quote-mark">"</div>
        <blockquote>
          They came back <em>two days later.</em> Mid-lambing. Reading from a script.
          Telling me I'd cop a five-hundred-thousand-dollar fine if I didn't let them through
          <span className="ff-quote-strong"> my own front gate.</span>
        </blockquote>
        <figcaption>
          <div className="ff-quote-name">— Rob, fourth-generation farmer</div>
          <div className="ff-quote-place">Western Victoria · filmed April 2026</div>
        </figcaption>
      </div>
    </section>
  );
}

// ---------- Donate band ----------
function DonateBand() {
  const tiers = [25, 50, 100, 250];
  const [pick, setPick] = useState(50);
  const [monthly, setMonthly] = useState(false);
  return (
    <section id="donate" className="ff-section ff-donate">
      <div className="ff-wrap ff-donate-inner">
        <div className="ff-donate-copy">
          <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> Chip in</span>
          <h2 className="ff-h2 ff-h2--light">Every dollar fights for a farm.</h2>
          <p>
            Legal advice for farmers on the corridor. Camera gear for the next confrontation.
            Printing, fuel, hall hire, ads that won't air on commercial radio.
            We run lean. You keep us in the paddock.
          </p>
          <ul className="ff-donate-where">
            <li><span>42%</span> Legal &amp; ombudsman costs</li>
            <li><span>28%</span> Video production &amp; distribution</li>
            <li><span>20%</span> Community organising</li>
            <li><span>10%</span> Campaign materials</li>
          </ul>
        </div>
        <div className="ff-donate-form">
          <div className="ff-donate-toggle">
            <button className={!monthly ? "is-on" : ""} onClick={() => setMonthly(false)}>One-off</button>
            <button className={monthly ? "is-on" : ""} onClick={() => setMonthly(true)}>Monthly</button>
          </div>
          <div className="ff-donate-tiers">
            {tiers.map(t => (
              <button key={t} className={`ff-donate-tier ${pick===t ? "is-on" : ""}`} onClick={() => setPick(t)}>
                <span className="ff-donate-tier-n">${t}</span>
                <span className="ff-donate-tier-l">
                  {t===25 && "Prints 100 flyers"}
                  {t===50 && "An hour of legal advice"}
                  {t===100 && "Fills a ute for a week"}
                  {t===250 && "Camera kit for a farmer"}
                </span>
              </button>
            ))}
          </div>
          <label className="ff-donate-other">
            <span>Other amount</span>
            <div className="ff-donate-other-in">
              <em>$</em>
              <input type="number" placeholder="Custom" value={pick} onChange={e => setPick(Number(e.target.value)||0)}/>
            </div>
          </label>
          <button className="ff-btn ff-btn--red ff-btn--block ff-btn--lg">
            Donate ${pick} {monthly ? "/month" : "now"}
          </button>
          <p className="ff-donate-fine">Secure processing via Campaign Nucleus. Not tax-deductible.</p>
        </div>
      </div>
    </section>
  );
}

// ---------- Newsletter ----------
function Newsletter() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  return (
    <section className="ff-section ff-news">
      <div className="ff-wrap ff-news-inner">
        <div>
          <h3 className="ff-h3">Get the next video before the nightly news does.</h3>
          <p>Weekly dispatches from the corridor. No spam, no corporate chaff.</p>
        </div>
        <form className="ff-news-form" onSubmit={(e) => { e.preventDefault(); if(email) setDone(true); }}>
          {done ? (
            <div className="ff-news-done">✓ You're on the list. Keep an eye on your inbox.</div>
          ) : (
            <>
              <input type="email" required placeholder="you@farm.com.au" value={email} onChange={e=>setEmail(e.target.value)}/>
              <button className="ff-btn ff-btn--red">Subscribe</button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}

// ---------- Footer ----------
function Footer() {
  return (
    <footer className="ff-footer">
      <div className="ff-wrap ff-footer-inner">
        <div className="ff-footer-brand">
          <img src="assets/logo.png" alt="Farmers Fightback" />
          <p>
            A farmer-led coalition from the Wallaloo &amp; Gre Gre District Association —
            fighting the VNI West transmission line and defending the food bowl of Victoria.
          </p>
          <div className="ff-footer-social">
            <a href="#" aria-label="TikTok">TikTok</a>
            <a href="#" aria-label="Facebook">Facebook</a>
            <a href="#" aria-label="Instagram">Instagram</a>
          </div>
        </div>
        <div className="ff-footer-cols">
          <div>
            <h4>Campaign</h4>
            <a href="#evidence">The Evidence</a>
            <a href="#news">News &amp; media</a>
            <a href="#rights">Know your rights</a>
            <a href="#gate">Hold the Gate</a>
          </div>
          <div>
            <h4>Take action</h4>
            <a href="#petition">Sign the petition</a>
            <a href="#donate">Donate</a>
            <a href="#">Volunteer</a>
            <a href="#">Submit evidence</a>
          </div>
          <div>
            <h4>Contact</h4>
            <a href="mailto:hello@farmersfightback.com">hello@farmersfightback.com</a>
            <a href="#">Media enquiries</a>
            <a href="#">Press kit</a>
          </div>
        </div>
      </div>
      <div className="ff-footer-base">
        <div className="ff-wrap ff-footer-base-inner">
          <span>Authorised by Ben Duxson, Wallaloo VIC · © 2026 Farmers Fightback</span>
          <span>Built on Campaign Nucleus</span>
        </div>
      </div>
    </footer>
  );
}

// ---------- Video modal ----------
function VideoModal({ open, onClose }) {
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
          <strong>Video 4 — Lambing Season · 3:42</strong>
          <span>Western Victoria · April 2026 · Filmed under the Surveillance Devices Act 1999 (Vic)</span>
        </div>
      </div>
    </div>
  );
}

// ---------- App ----------
function App() {
  const [modal, setModal] = useState(false);
  return (
    <>
      <TopBanner />
      <Nav onDonate={() => document.getElementById("donate")?.scrollIntoView({ behavior: "smooth" })}/>
      <main>
        <Hero onWatch={() => setModal(true)} />
        <ImpactBar />
        <IntroVideo />
        <LatestVideo onOpen={() => setModal(true)} />
        <Summary />
        <Petition />
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

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
