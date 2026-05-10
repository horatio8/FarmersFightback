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

  // Live-ish counter
  const [count, setCount] = useState(p.currentCount || 51427);
  useEffect(() => {
    const t = setInterval(() => setCount(x => x + Math.floor(Math.random() * 3)), 2500);
    return () => clearInterval(t);
  }, []);

  // Form state — wires the SIGN action below the action grid
  const [form, setForm] = useState({ first: "", last: "", email: "", postcode: "", consent: false });
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
    if (form.postcode && !/^\d{4}$/.test(form.postcode)) e.postcode = "4-digit postcode";
    if (!form.consent) e.consent = "Tick to continue";
    setErrors(e);
    if (Object.keys(e).length) return;
    setState("submitting");
    const body = new URLSearchParams({
      first_name: form.first.trim(), last_name: form.last.trim(),
      email: form.email.trim(), postcode: form.postcode.trim(),
      campaign: "Baldwin Defence — Resign Minister",
    });
    try {
      if (receiverUrl) await fetch(receiverUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      setState("done");
    } catch { setState("error"); }
  };

  // Locked copy
  const acts = [
    { n: "01", date: "13 NOV 2025", tag: "TRESPASS",
      title: "Greg called triple zero on his own farm.",
      body: "VicGrid contractors entered the Baldwin property in western Victoria. They had been served previous refusals, written notice, and a 48-hour access notice the family had not consented to. Greg called 000. Bill — Greg's brother and a CFA volunteer — arrived to support him. Neighbours arrived. The contractors left." },
    { n: "02", date: "NOV 2025 — MAR 2026", tag: "THE CHARGES",
      title: "Police did not charge the trespassers. They charged the farmers.",
      body: "Greg with unlawful imprisonment. Bill with unlawful imprisonment AND assault. Both Baldwins were arrested at Rupanyup Police Station and fingerprinted. Bill was first ordered to attend the station while he was actively fighting a fire on a neighbour's property as a CFA volunteer." },
    { n: "03", date: "27 APR 2026", tag: "DPP WITHDRAWS", highlight: true,
      title: "The DPP withdrew every charge. There was no case.",
      body: "In the Magistrates' Court, the Director of Public Prosecutions withdrew every charge against Greg and Bill Baldwin. No conviction. No trial. No basis. The Crown said in plain language what the family had said all along: there was no case to answer." },
    { n: "04", date: "16 MAR 2026", tag: "FORCED ACCESS",
      title: "The same Minister. A new law. The same farms. 30 days.",
      body: "The same week the family was in court, VicGrid posted letters to multiple western Victorian properties advising they would use new powers under amended Victorian energy legislation to FORCE access in 30 days. Same project. Same villains. Different vehicle." },
  ];
  const pillars = [
    "A farmer rang triple zero. They charged the farmer.",
    "The court agreed. The DPP withdrew. There was no case.",
    "Same Minister. New law. Same farms. 30 days.",
    "We are not victims. We are landholders. Resign.",
  ];
  const actions = [
    { n: "01", t: "Sign the petition",   d: "Add your name to the call for the Minister to resign. Farmers Fightback-endorsed. Delivered to Spring St.", cta: "SIGN",   primary: true,  href: "#sign" },
    { n: "02", t: "Email the Minister",  d: "Pre-written letter, your name on it. Sent to the Minister's office and your local MP in two clicks.",       cta: "EMAIL",  href: "mailto:lily.dambrosio@parliament.vic.gov.au?subject=Resign%2C%20Minister&body=Dear%20Minister%20D%27Ambrosio%2C%0A%0AThe%20DPP%20has%20withdrawn%20every%20charge%20against%20Greg%20and%20Bill%20Baldwin.%20There%20was%20no%20case.%20I%20am%20writing%20to%20demand%20your%20resignation%2C%20a%20review%20of%20Vic%20Police%20and%20OPP%20conduct%2C%20and%20suspension%20of%20forced-access%20powers%20under%20the%20amended%20energy%20legislation.%0A%0AYours%2C%0A" },
    { n: "03", t: "Share Greg's address", d: "One-tap share to X, Facebook, Instagram. Use #ResignMinister and #ChargesDropped.",                          cta: "SHARE",  href: "#share" },
    { n: "04", t: "Donate to defence",   d: "Recovery of legal costs and prep for civil action. Every dollar receipted by the Baldwin family solicitor.", cta: "DONATE", href: "/#donate" },
  ];

  // Inline keyframes + responsive collapse, scoped via class names
  const css = `
    @keyframes v1pan { 0%{background-position:0 0,0 0} 100%{background-position:0 0,200px 0} }
    @keyframes v1blink { 50%{opacity:.4} }
    .fl-root { background: ${C.navy}; color: ${C.bone}; font-family: ${fonts.sans}; min-height: 100vh; }
    .fl-root a { color: inherit; text-decoration: none; }
    .fl-root *, .fl-root *::before, .fl-root *::after { box-sizing: border-box; }
    .fl-pad { padding-left: 56px; padding-right: 56px; }
    .fl-h1 { font: 900 124px/0.92 ${fonts.display}; letter-spacing: -0.015em; text-transform: uppercase; margin: 24px 0 0; }
    .fl-h2 { font: 900 80px/0.95 ${fonts.display}; letter-spacing: -0.01em; text-transform: uppercase; margin: 0; }
    .fl-h2--sm { font-size: 60px; line-height: 1; }
    .fl-grid-hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 56px; align-items: end; }
    .fl-grid-demand { display: grid; grid-template-columns: 0.6fr 1fr; gap: 56px; }
    .fl-grid-counter { display: grid; grid-template-columns: 1fr 0.8fr; gap: 64px; align-items: end; }
    .fl-grid-timeline { display: grid; grid-template-columns: 180px 1fr; column-gap: 48px; position: relative; }
    .fl-grid-pillars { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0; border: 1px solid ${C.rule}; }
    .fl-grid-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 1px solid ${C.rule}; }
    .fl-grid-footer { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 32px; }
    @media (max-width: 1199px) {
      .fl-grid-hero, .fl-grid-demand, .fl-grid-counter { grid-template-columns: 1fr; gap: 32px; }
      .fl-h1 { font-size: 88px; }
    }
    @media (max-width: 899px) {
      .fl-grid-actions { grid-template-columns: repeat(2, 1fr); }
      .fl-grid-pillars { grid-template-columns: 1fr; }
      .fl-grid-footer { grid-template-columns: 1fr 1fr; }
      .fl-grid-timeline { grid-template-columns: 1fr; }
      .fl-rail { display: none !important; }
      .fl-date-col { text-align: left !important; padding-bottom: 8px !important; padding-right: 0 !important; }
    }
    @media (max-width: 599px) {
      .fl-pad { padding-left: 20px; padding-right: 20px; }
      .fl-h1 { font-size: 64px; }
      .fl-h2 { font-size: 56px; }
      .fl-h2--sm { font-size: 44px; }
      .fl-grid-actions, .fl-grid-footer { grid-template-columns: 1fr; }
      .fl-kicker { flex-direction: column; gap: 6px; align-items: flex-start; }
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
      <p style={{ margin: 0, font: `400 16px/1.55 ${fonts.sans}` }}>Now share Greg's address. Every signature past 50k strengthens the handover at Spring St.</p>
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
          { k: "first", label: "First name", auto: "given-name" },
          { k: "last",  label: "Last name",  auto: "family-name" },
        ].map(f => (
          <label key={f.k} style={{ display: "block" }}>
            <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>{f.label}{errors[f.k] && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors[f.k]}</em>}</span>
            <input value={form[f.k]} onChange={update(f.k)} autoComplete={f.auto} style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors[f.k] ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
          </label>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 12, marginTop: 12 }}>
        <label>
          <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Email{errors.email && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors.email}</em>}</span>
          <input type="email" value={form.email} onChange={update("email")} autoComplete="email" style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors.email ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
        </label>
        <label>
          <span style={{ display: "block", font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Postcode{errors.postcode && <em style={{ fontStyle: "normal", color: C.yellow, marginLeft: 6 }}>— {errors.postcode}</em>}</span>
          <input value={form.postcode} onChange={update("postcode")} inputMode="numeric" maxLength={4} autoComplete="postal-code" style={{ width: "100%", padding: "12px 14px", background: C.navy, border: `1.5px solid ${errors.postcode ? C.yellow : C.rule}`, color: C.bone, font: `400 15px/1 ${fonts.sans}` }} />
        </label>
      </div>
      <label style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 12, marginTop: 18, alignItems: "start", font: `400 13px/1.5 ${fonts.sans}`, color: C.mute, cursor: "pointer" }}>
        <input type="checkbox" checked={form.consent} onChange={update("consent")} style={{ width: 20, height: 20, marginTop: 1, accentColor: C.yellow }} />
        <span>I agree to receive campaign updates from Farmers Fightback. I can unsubscribe at any time. {errors.consent && <em style={{ fontStyle: "normal", color: C.yellow }}>— {errors.consent}</em>}</span>
      </label>
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
        <div className="fl-pad" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 56px", borderBottom: `1px solid ${C.rule}` }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 30, height: 30, background: C.yellow, clipPath: "polygon(50% 0,100% 38%,82% 100%,18% 100%,0 38%)" }} />
            <div style={{ font: `900 14px/1 ${fonts.display}`, letterSpacing: ".18em", textTransform: "uppercase" }}>Farmers Fightback</div>
          </a>
          <div style={{ display: "flex", gap: 28, font: `600 12px/1 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".14em", flexWrap: "wrap" }}>
            <a href="#story">The Story</a>
            <a href="#demand">The Demand</a>
            <a href="/news">Press</a>
            <a href="/#donate">Donate</a>
            <span style={{ color: C.yellow }}>● BALDWIN DEFENCE</span>
          </div>
        </div>

        {/* KICKER STRIP */}
        <div className="fl-kicker" style={{ background: C.yellow, color: C.navyDeep, padding: "10px 56px", display: "flex", justifyContent: "space-between", font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".18em", textTransform: "uppercase" }}>
          <span>● UPDATED 07 MAY 2026 · 18:42 AEST</span>
          <span>CHARGES DROPPED · THE MINISTER MUST RESIGN</span>
          <span>SHARE → #ResignMinister · #ChargesDropped</span>
        </div>

        {/* HERO */}
        <div className="fl-pad" style={{ padding: "64px 56px 48px" }}>
          <Eyebrow>Baldwin Defence · Phase 01 — Vindication</Eyebrow>
          <h1 className="fl-h1">
            Charges<br/>
            <span style={{ color: C.yellow }}>dropped.</span><br/>
            The Minister<br/>
            must resign.
          </h1>
          <p style={{ margin: "36px 0 0", maxWidth: 720, font: `400 19px/1.55 ${fonts.sans}`, color: C.bone }}>
            Greg Baldwin rang triple zero to report trespassers on his own farm. Vic Police charged the farmer. On <strong style={{ color: C.yellow }}>27 April 2026</strong>, the Director of Public Prosecutions withdrew every charge. Greg does not want sympathy. Greg wants the Victorian Energy Minister to resign.
          </p>
          <div style={{ marginTop: 40, maxWidth: 720 }}>
            {signFormBlock}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
            <Btn mono href={actions[1].href}>Email the Minister</Btn>
            <Btn mono href="#story">Read the case</Btn>
          </div>
        </div>

        <Rule />

        {/* DEMAND PANEL */}
        <div id="demand" className="fl-pad" style={{ padding: "64px 56px", background: C.navyDeep }}>
          <div className="fl-grid-demand">
            <div>
              <Eyebrow>The Demand</Eyebrow>
              <div style={{ font: `700 14px/1.5 ${fonts.mono}`, color: C.mute, marginTop: 22, textTransform: "uppercase", letterSpacing: ".1em" }}>
                To: The Hon. Lily D'Ambrosio MP<br/>Victorian Minister for Energy and Resources
              </div>
              <div style={{ marginTop: 28, padding: "14px 18px", border: `1.5px dashed ${C.yellow}`, color: C.yellow, font: `700 11px/1.5 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase", display: "inline-block" }}>
                ● ACTIVE PETITION · FARMERS FIGHTBACK-ENDORSED
              </div>
            </div>
            <div>
              <h2 className="fl-h2 fl-h2--sm">
                Resign. Explain. <span style={{ color: C.yellow }}>Repeal.</span>
              </h2>
              <ol style={{ margin: "32px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 22, font: `500 18px/1.55 ${fonts.sans}`, color: C.bone }}>
                {[
                  ["01.", "The Minister for Energy and Resources resigns."],
                  ["02.", "An independent review of Vic Police and OPP conduct in the Baldwin matter."],
                  ["03.", "Forced-access powers in the amended energy legislation suspended pending a parliamentary inquiry."],
                ].map(([n, t]) => (
                  <li key={n} style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, alignItems: "baseline" }}>
                    <span style={{ font: `800 22px/1 ${fonts.mono}`, color: C.yellow }}>{n}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>

        <Rule />

        {/* COUNTER STRIP */}
        <div className="fl-pad" style={{ padding: "56px 56px 64px" }}>
          <div className="fl-grid-counter">
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
              <div style={{ font: `900 96px/0.9 ${fonts.display}`, color: C.yellow, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{count.toLocaleString("en-AU")}</div>
              <div style={{ font: `600 14px/1.4 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".12em" }}>signatures<br/>demanding the Minister resign</div>
            </div>
            <div>
              <Eyebrow>Goal · 50,000</Eyebrow>
              <div style={{ position: "relative", height: 18, background: "rgba(245,241,232,0.08)", marginTop: 14 }}>
                <div style={{ position: "absolute", inset: 0, width: "100%", background: C.yellow }} />
                <div style={{ position: "absolute", right: -2, top: -10, bottom: -10, width: 2, background: C.bone }} />
              </div>
              <div style={{ font: `500 12px/1.5 ${fonts.mono}`, color: C.mute, marginTop: 12, textTransform: "uppercase", letterSpacing: ".12em" }}>
                Threshold met. Spring St handover scheduled — date TBC, next 60 days.
              </div>
            </div>
          </div>
        </div>

        <Rule />

        {/* STORY TIMELINE */}
        <div id="story" className="fl-pad" style={{ padding: "88px 56px 64px" }}>
          <Eyebrow>The Story · One Page</Eyebrow>
          <h2 className="fl-h2" style={{ marginTop: 20, maxWidth: 980 }}>From triple zero <span style={{ color: C.yellow }}>to no case to answer.</span></h2>
          <div className="fl-grid-timeline" style={{ marginTop: 64 }}>
            <div className="fl-rail" style={{ position: "absolute", left: 220, top: 0, bottom: 0, width: 2, background: C.rule }} />
            {acts.map((a, i) => (
              <React.Fragment key={a.n}>
                <div className="fl-date-col" style={{ paddingTop: 8, textAlign: "right", paddingRight: 24, font: `700 13px/1.4 ${fonts.mono}`, color: a.highlight ? C.yellow : C.bone, textTransform: "uppercase", letterSpacing: ".12em", paddingBottom: 64 }}>
                  <div>{a.date}</div>
                  <div style={{ marginTop: 8, color: C.mute, fontWeight: 500 }}>{a.tag}</div>
                </div>
                <div style={{ position: "relative", paddingBottom: 64, paddingLeft: 36 }}>
                  <div style={{ position: "absolute", left: -7, top: 14, width: 16, height: 16, borderRadius: 16, background: a.highlight ? C.yellow : C.navyDeep, boxShadow: a.highlight ? `0 0 0 4px ${C.navy}` : `inset 0 0 0 2px ${C.bone}` }} />
                  <div style={{ font: `900 22px/1 ${fonts.mono}`, color: a.highlight ? C.yellow : C.bone, letterSpacing: ".04em" }}>{a.n}</div>
                  <h3 style={{ margin: "14px 0 0", font: `700 32px/1.15 ${fonts.sans}`, letterSpacing: "-0.01em", color: a.highlight ? C.yellow : C.bone, maxWidth: 720 }}>{a.title}</h3>
                  <p style={{ margin: "14px 0 0", maxWidth: 680, font: `400 16px/1.65 ${fonts.sans}`, color: C.bone }}>{a.body}</p>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        <Rule />

        {/* PILLARS POSTER */}
        <div className="fl-pad" style={{ padding: "88px 56px", background: C.navyDeep }}>
          <Eyebrow>Messaging · The Public Record</Eyebrow>
          <div className="fl-grid-pillars" style={{ marginTop: 36 }}>
            {pillars.map((p2, i) => (
              <div key={i} style={{
                padding: "40px 36px",
                borderRight: i % 2 === 0 ? `1px solid ${C.rule}` : "none",
                borderBottom: i < 2 ? `1px solid ${C.rule}` : "none",
                minHeight: 180, display: "flex", flexDirection: "column", justifyContent: "space-between",
              }}>
                <div style={{ font: `700 12px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase" }}>Pillar 0{i + 1}</div>
                <div style={{ font: `800 28px/1.15 ${fonts.sans}`, letterSpacing: "-0.01em", marginTop: 16 }}>{p2}</div>
              </div>
            ))}
          </div>
        </div>

        <Rule />

        {/* ACTION GRID */}
        <div className="fl-pad" style={{ padding: "88px 56px 56px" }}>
          <Eyebrow>What you do today</Eyebrow>
          <h2 className="fl-h2" style={{ margin: "18px 0 48px" }}>Four moves. <span style={{ color: C.yellow }}>Pick one.</span></h2>
          <div className="fl-grid-actions">
            {actions.map((a, i) => (
              <a key={a.n} href={a.href} style={{
                padding: "36px 32px",
                background: a.primary ? C.yellow : "transparent",
                color: a.primary ? C.navyDeep : C.bone,
                borderRight: i < 3 ? `1px solid ${a.primary ? "rgba(14,41,64,.18)" : C.rule}` : "none",
                display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 320,
              }}>
                <div>
                  <div style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase", opacity: .7 }}>Action {a.n}</div>
                  <div style={{ font: `800 32px/1.1 ${fonts.sans}`, marginTop: 18, letterSpacing: "-0.01em" }}>{a.t}</div>
                  <div style={{ font: `400 14px/1.55 ${fonts.sans}`, marginTop: 14, color: a.primary ? "rgba(8,24,38,.78)" : C.bone, opacity: a.primary ? 1 : .82 }}>{a.d}</div>
                </div>
                <div style={{ marginTop: 24, display: "inline-flex", alignItems: "center", gap: 10, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>{a.cta} <span style={{ fontSize: 18 }}>→</span></div>
              </a>
            ))}
          </div>
        </div>

        {/* WATCH GREG — full-width video block (was the form's old slot) */}
        <div id="watch" className="fl-pad" style={{ padding: "0 56px 88px" }}>
          <div style={{ marginBottom: 24, display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
            <Eyebrow>Watch Greg · On the record</Eyebrow>
            <span style={{ font: `500 12px/1.4 ${fonts.mono}`, color: C.mute, letterSpacing: ".12em", textTransform: "uppercase" }}>Address to camera · 03:42 · Recorded May 2026</span>
          </div>
          <VideoSlot />
        </div>

        <Rule />

        {/* SHARE ROW */}
        <div id="share" className="fl-pad" style={{ padding: "56px 56px" }}>
          <Eyebrow>Share · Greg's Address</Eyebrow>
          <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
            {[
              { p: "facebook", l: "Facebook" },
              { p: "x",        l: "X" },
              { p: "whatsapp", l: "WhatsApp" },
              { p: "telegram", l: "Telegram" },
              { p: "email",    l: "Email" },
            ].map(s => {
              const pageUrl = (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
              return (
                <a key={s.p} href={shareUrlFor(s.p, p.shareText || "Charges dropped. The Minister must resign. #ResignMinister #ChargesDropped", pageUrl)} target="_blank" rel="noopener noreferrer"
                   style={{ padding: "14px 18px", background: "transparent", boxShadow: `inset 0 0 0 1.5px ${C.bone}`, color: C.bone, font: `800 13px/1 ${fonts.mono}`, letterSpacing: ".16em", textTransform: "uppercase" }}>
                  {s.l} →
                </a>
              );
            })}
          </div>
        </div>

        {/* PHOTO BAND */}
        <div className="fl-pad" style={{ padding: "0 56px 88px" }}>
          <PhotoSlot label="GREG ON HIS LAND · WIDE · LOOKING AT CAMERA · WORKING CLOTHES" h={420} />
        </div>

        <Rule />

        {/* FOOTER */}
        <div className="fl-pad" style={{ padding: "56px 56px 64px", background: C.navyDeep }}>
          <div className="fl-grid-footer">
            <div>
              <div style={{ font: `900 16px/1 ${fonts.display}`, letterSpacing: ".2em", textTransform: "uppercase" }}>Farmers<br/>Fightback</div>
              <p style={{ font: `400 13px/1.6 ${fonts.sans}`, color: C.mute, marginTop: 18, maxWidth: 280 }}>Fighting for farmers, food &amp; our future. 35,000+ strong across regional Australia.</p>
            </div>
            {[
              ["The Campaign", [["Baldwin Defence", "/take-action/baldwins"], ["VNI West", "/#evidence"], ["Resign Minister", "#sign"], ["Forced Access", "/take-action/remove-us-from-the-rez"]]],
              ["Take Action",  [["Sign petition", "#sign"], ["Email Minister", actions[1].href], ["Share Greg's video", "#share"], ["Donate", "/#donate"]]],
              ["Press",        [["News", "/news"], ["Contact", "mailto:hello@farmersfightback.com"]]],
            ].map(([h, items]) => (
              <div key={h}>
                <div style={{ font: `700 11px/1 ${fonts.mono}`, color: C.yellow, letterSpacing: ".18em", textTransform: "uppercase" }}>{h}</div>
                <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
                  {items.map(([label, href]) => <a key={label} href={href} style={{ font: `500 14px/1.4 ${fonts.sans}`, color: C.bone }}>{label}</a>)}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 56, paddingTop: 24, borderTop: `1px solid ${C.rule}`, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, font: `500 11px/1.5 ${fonts.mono}`, color: C.mute, textTransform: "uppercase", letterSpacing: ".12em" }}>
            <span>© Farmers Fightback 2026 · Authorised by Ben Duxson, Farmers Fightback</span>
            <span>farmersfightback.com/take-action/baldwins</span>
          </div>
        </div>
      </div>
    </>
  );
}

function PetitionPage({ slug }) {
  const all = useContent().petitions || {};
  const p = all[slug];
  const receiverUrl = useContent().petition?.receiverUrl;

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
      <p className="ff-form-fine">Authorised by Ben Duxson, Farmers Fightback.</p>
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
            <p className="ff-form-fine">Authorised by Ben Duxson, Farmers Fightback.</p>
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
