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
                        <a href={c2.href} role="menuitem">{c2.label}</a>
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
                  <a key={i.label + c2.label} href={c2.href} className="is-child" onClick={() => setOpen(false)}>↳ {c2.label}</a>
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
      <video
        className="ff-hero-bg"
        autoPlay muted loop playsInline preload="metadata" aria-hidden="true"
        key={c.videoUrl}
      >
        <source src={c.videoUrl} type="video/mp4" />
      </video>
      <div className="ff-hero-scrim" />
      <div className="ff-wrap ff-hero-content">
        <h1 className="ff-hero-title" dangerouslySetInnerHTML={html(c.titleHtml)} />
        <p className="ff-hero-sub">{c.subtitle}</p>
        <div className="ff-hero-cta">
          <a href={c.primaryCtaHref} className="ff-btn ff-btn--red ff-btn--lg">{c.primaryCtaLabel}</a>
          <button className="ff-btn ff-btn--ghost ff-btn--lg" onClick={onWatch}>
            <span className="ff-play">▶</span> {c.secondaryCtaLabel}
          </button>
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
function Petition() {
  const c = useContent().petition;
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "", affected: "" });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle");
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
      await fetch(c.receiverUrl, {
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
              <a href="#donate" className="ff-btn ff-btn--red">Chip in to the fight</a>
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
          <div className="ff-petition-bullets">
            {c.bullets.map((b, i) => (
              <div key={i}><span className="ff-check">✓</span> {b}</div>
            ))}
          </div>
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
  const currency = c.currency || "AUD";
  const sym = c.currencySymbol || "$";
  const [pick, setPick] = useState(c.defaultPick);
  const [monthly, setMonthly] = useState(false);

  const matchedTier = c.tiers.find(t => Number(t.amount) === Number(pick));
  const isCustom = !matchedTier;
  const stripeUrl = isCustom
    ? (monthly ? c.customMonthlyUrl : c.customOneOffUrl)
    : (monthly ? matchedTier.monthlyUrl : matchedTier.oneOffUrl);
  const ready = !!stripeUrl;
  const validAmount = Number(pick) > 0;
  const canDonate = ready && validAmount;

  const onDonate = () => {
    if (!canDonate) return;
    window.location.href = stripeUrl;
  };

  let helpMsg = c.fineprint;
  if (!validAmount) {
    helpMsg = "Choose an amount above to continue.";
  } else if (!ready) {
    helpMsg = isCustom
      ? `Custom ${monthly ? "monthly" : "one-off"} donations aren't set up yet — pick a fixed amount or check back soon.`
      : `${monthly ? "Monthly" : "One-off"} donations of ${sym}${pick} ${currency} aren't set up yet — try a different amount or frequency.`;
  }

  return (
    <section id="donate" className="ff-section ff-donate">
      <div className="ff-wrap ff-donate-inner">
        <div className="ff-donate-copy">
          <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
          <h2 className="ff-h2 ff-h2--light">{c.heading}</h2>
          <p>{c.body}</p>
          <ul className="ff-donate-where">
            {c.where.map((w, i) => (
              <li key={i}><span>{w.percent}</span> {w.label}</li>
            ))}
          </ul>
        </div>
        <div className="ff-donate-form">
          <div className="ff-donate-toggle">
            <button type="button" className={!monthly ? "is-on" : ""} onClick={() => setMonthly(false)}>One-off</button>
            <button type="button" className={monthly ? "is-on" : ""} onClick={() => setMonthly(true)}>Monthly</button>
          </div>
          <div className="ff-donate-tiers">
            {c.tiers.map(t => (
              <button
                key={t.amount}
                type="button"
                className={`ff-donate-tier ${Number(pick)===Number(t.amount) ? "is-on" : ""}`}
                onClick={() => setPick(t.amount)}
              >
                <span className="ff-donate-tier-n">{sym}{t.amount}</span>
                <span className="ff-donate-tier-l">{t.label}</span>
              </button>
            ))}
          </div>
          <label className="ff-donate-other">
            <span>Other amount ({currency})</span>
            <div className="ff-donate-other-in">
              <em>{sym}</em>
              <input
                type="number"
                min="1"
                placeholder="Custom"
                value={pick}
                onChange={e => setPick(Number(e.target.value)||0)}
              />
            </div>
          </label>
          <button
            type="button"
            className="ff-btn ff-btn--red ff-btn--block ff-btn--lg"
            disabled={!canDonate}
            onClick={onDonate}
            aria-disabled={!canDonate}
          >
            Donate {sym}{pick} {currency} {monthly ? "/month" : "now"}
          </button>
          <p className="ff-donate-fine">{helpMsg}</p>
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
          <img src="assets/logo.png" alt="Farmers Fightback" />
          <p>{c.blurb}</p>
          <div className="ff-footer-social">
            {c.social.map((s, i) => (
              <a key={i} href={s.href} aria-label={s.label}>{s.label}</a>
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
          <span>{c.platform}</span>
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
function PageShell({ children, hideTopBanner }) {
  const onDonate = () => {
    if (window.location.pathname === "/" || window.location.pathname === "/index.html") {
      document.getElementById("donate")?.scrollIntoView({ behavior: "smooth" });
    } else {
      window.location.href = "/#donate";
    }
  };
  return (
    <>
      {!hideTopBanner && <TopBanner />}
      <Nav onDonate={onDonate} />
      <main>{children}</main>
      <Footer />
    </>
  );
}

// ---------- HomePage (the original homepage layout) ----------
function HomePage() {
  const [modal, setModal] = useState(false);
  return (
    <>
      <TopBanner />
      <Nav onDonate={() => document.getElementById("donate")?.scrollIntoView({ behavior: "smooth" })} />
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
      {c.youtube && <YouTubeFeed cfg={c.youtube} />}
      {c.newsletter && <NewsletterSection cfg={c.newsletter} />}
      {c.socials && <SocialFeeds cfg={c.socials} />}
      {c.press && <PressList cfg={c.press} />}
    </PageShell>
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
              <article key={i} className="ff-yt-card">
                <a href={v.link} target="_blank" rel="noopener noreferrer" className="ff-yt-card-media" aria-label={`Watch: ${v.title}`}>
                  <img src={v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`} alt="" loading="lazy" />
                  <span className="ff-yt-play" aria-hidden="true">▶</span>
                </a>
                <div className="ff-yt-card-body">
                  <span className="ff-card-kicker">{formatDate(v.published)}</span>
                  <h3 className="ff-yt-card-title">{v.title}</h3>
                </div>
              </article>
            ))}
          </div>
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
function shareUrlFor(platform, text, url) {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  switch (platform) {
    case "facebook": return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case "x":        return `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
    case "whatsapp": return `https://wa.me/?text=${t}%20${u}`;
    case "telegram": return `https://t.me/share/url?url=${u}&text=${t}`;
    case "email":    return `mailto:?subject=${encodeURIComponent("Sign the petition")}&body=${t}%0A%0A${u}`;
    default: return null;
  }
}

function PetitionPage({ slug }) {
  const all = useContent().petitions || {};
  const p = all[slug];
  const receiverUrl = useContent().petition?.receiverUrl;
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
    if (!form.consent) e.consent = "Tick to continue";
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
      country: form.country,
      campaign: p.campaign || p.slug,
    });
    try {
      if (receiverUrl) {
        await fetch(receiverUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      }
      setState("done");
    } catch { setState("error"); }
  };

  if (state === "done") {
    const newCount = (p.currentCount || 0) + 1;
    const pct = Math.min(100, (newCount / (p.goal || 1)) * 100);
    const headingHtml = (p.thanksHeadingHtml || "").replace("{{first}}", form.first);
    const lede = (p.thanksLede || "").replace("{{first}}", form.first).replace("{{count}}", newCount.toLocaleString());
    const pageUrl = (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
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
              <a href="/#donate" className="ff-btn ff-btn--red">Chip in to the fight</a>
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
      <p className="ff-form-fine">Authorised by Ben Duxson, Wallaloo & Gre Gre District Association.</p>
    </form>
  );

  if (p.layout === "long-form") {
    return (
      <PageShell>
        {/* Hero — full-width navy */}
        <section className={`ff-petition-hero ff-petition-hero--${p.tone || "navy"}`}>
          <div className="ff-wrap">
            <a href={p.ctaHrefBack || "/take-action"} className="ff-back-link ff-back-link--light">← All campaigns</a>
            {p.heroEyebrow && <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> {p.heroEyebrow}</span>}
            <h1 className="ff-petition-hero-title" dangerouslySetInnerHTML={html(p.headingHtml || p.heading || "")} />
            {p.subheading && <p className="ff-petition-hero-sub">{p.subheading}</p>}
          </div>
        </section>

        {/* Context paragraphs */}
        {p.context && p.context.length > 0 && (
          <section className="ff-section ff-petition-context">
            <div className="ff-wrap ff-petition-context-inner">
              {p.context.map((para, i) => <p key={i}>{para}</p>)}
            </div>
          </section>
        )}

        {/* Petition statement card + form */}
        <section className="ff-section ff-petition-form-section">
          <div className="ff-wrap ff-petition-form-grid">
            <div className="ff-petition-statement">
              {p.petitionStatementHeading && <h2 className="ff-petition-statement-h">{p.petitionStatementHeading}</h2>}
              <ol className="ff-petition-statement-list">
                {(p.petitionStatement || []).map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              {p.trustBadges && p.trustBadges.length > 0 && (
                <ul className="ff-trust-row ff-trust-row--stacked">
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
              )}
            </div>
            <div>{formBlock}</div>
          </div>
        </section>

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
                    <span className="ff-why-num">{String(i + 1).padStart(2, "0")}</span>
                    <h3 className="ff-why-h">{wm.heading}</h3>
                    <p>{wm.body}</p>
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
                    const pageUrl = (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
                    return <a key={i} href={shareUrlFor(s.platform, p.shareText, pageUrl)} target="_blank" rel="noopener noreferrer" className={`ff-share-btn ff-share-btn--${s.platform}`}>{s.label}</a>;
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
            <p className="ff-form-fine">Authorised by Ben Duxson, Wallaloo & Gre Gre District Association.</p>
          </form>
        </div>
      </section>
    </PageShell>
  );
}

// ---------- App (router) ----------
function App() {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(CONTENT_URL, { cache: "no-cache" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(setContent)
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
  else view = <HomePage />;

  return <ContentContext.Provider value={content}>{view}</ContentContext.Provider>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
