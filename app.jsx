/* global React, ReactDOM */
const { useState, useEffect, createContext, useContext } = React;

const CONTENT_URL = "content/site.json";
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
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <nav className={`ff-nav ${scrolled ? "is-scrolled" : ""}`}>
      <div className="ff-wrap ff-nav-inner">
        <a href="#home" className="ff-logo" aria-label="Farmers Fightback home">
          <img src="assets/logo.png" alt="Farmers Fightback" />
        </a>
        <ul className="ff-nav-list">
          {c.items.map((i) => (
            <li key={i.label}>
              <a href={i.href} className={i.active ? "is-active" : ""}>{i.label}</a>
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
          {c.items.map((i) => (
            <a key={i.label} href={i.href} onClick={() => setOpen(false)}>{i.label}</a>
          ))}
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

// ---------- YouTube lite embed (click to load) ----------
function YouTubeEmbed({ youtubeId, ratio = "16/9", title }) {
  const [play, setPlay] = useState(false);
  if (play) {
    return (
      <div className="ff-yt" style={{ aspectRatio: ratio }}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0&modestbranding=1`}
          title={title}
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ff-yt ff-yt-thumb"
      style={{ aspectRatio: ratio }}
      onClick={() => setPlay(true)}
      aria-label={`Play: ${title}`}
    >
      <img
        src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
        alt=""
        loading="lazy"
        aria-hidden="true"
      />
      <span className="ff-yt-play" aria-hidden="true">▶</span>
    </button>
  );
}

// ---------- Evidence ----------
function Evidence() {
  const c = useContent().evidence;

  const shareEvidence = () => {
    const url = (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "") + "#evidence";
    const data = { title: c.shareTitle, text: c.shareText, url };
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share(data).catch(() => {});
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(`${c.shareText} ${url}`);
      alert("Link copied — paste it anywhere.");
    }
  };

  return (
    <section id="evidence" className="ff-section ff-evidence">
      <div className="ff-wrap ff-evidence-intro">
        <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.eyebrow}</span>
        <h2 className="ff-h2 ff-evidence-h2">{c.heading}</h2>
        <p className="ff-lede ff-evidence-lede">{c.intro}</p>
        {c.paragraphsHtml.map((p, i) => (
          <p key={i} className="ff-evidence-p" dangerouslySetInnerHTML={html(p)} />
        ))}
        <p className="ff-evidence-callout">{c.callout}</p>
        <ul className="ff-evidence-stats">
          {c.stats.map((s, i) => (
            <li key={i}>
              <span className="ff-evidence-stat-n">{s.value}</span>
              <span className="ff-evidence-stat-l">{s.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="ff-wrap ff-evidence-band">
        <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.shortsHeading}</span>
        <p className="ff-evidence-band-lede">{c.shortsLede}</p>
      </div>

      <div className="ff-wrap ff-shorts-grid">
        {c.shorts.map((s, i) => (
          <article key={i} className="ff-short-card">
            <div className="ff-short-media">
              <YouTubeEmbed youtubeId={s.youtubeId} ratio="9/16" title={s.title} />
            </div>
            <div className="ff-short-body">
              <span className="ff-card-kicker">{s.kicker}</span>
              <h3 className="ff-short-title">{s.title}</h3>
              <blockquote className="ff-short-quote">"{s.quote}"</blockquote>
              <ul className="ff-short-meta">
                <li><strong>{s.views}</strong> views</li>
                <li>{s.location}</li>
                <li>Filmed {s.filmed}</li>
              </ul>
              <p className="ff-short-body-p">{s.body}</p>
              <div className="ff-short-proves">
                <span className="ff-short-proves-l">What this proves</span>
                <p>{s.proves}</p>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="ff-wrap ff-evidence-band">
        <span className="ff-eyebrow"><span className="ff-eyebrow-dot" /> {c.longsHeading}</span>
        <p className="ff-evidence-band-lede">{c.longsLede}</p>
      </div>

      <div className="ff-wrap ff-longs-stack">
        {c.longs.map((l, i) => (
          <article key={i} className="ff-long-card">
            <div className="ff-long-media">
              <YouTubeEmbed youtubeId={l.youtubeId} ratio="16/9" title={l.title} />
            </div>
            <div className="ff-long-body">
              <span className="ff-card-kicker">{l.kicker}</span>
              <h3 className="ff-long-title">{l.title}</h3>
              <blockquote className="ff-short-quote">"{l.quote}"</blockquote>
              <ul className="ff-short-meta">
                <li><strong>{l.views}</strong> views</li>
                <li>Runtime {l.runtime}</li>
                <li>{l.location}</li>
                <li>Filmed {l.filmed}</li>
              </ul>
              <p className="ff-short-body-p">{l.body}</p>
              <div className="ff-short-proves">
                <span className="ff-short-proves-l">What this proves</span>
                <p>{l.proves}</p>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="ff-wrap ff-evidence-cta">
        <span className="ff-eyebrow ff-eyebrow--light"><span className="ff-eyebrow-dot" /> {c.ctaEyebrow}</span>
        <h3 className="ff-evidence-cta-h">{c.ctaHeading}</h3>
        {c.ctaParagraphsHtml.map((p, i) => (
          <p key={i} dangerouslySetInnerHTML={html(p)} />
        ))}
        <ol className="ff-evidence-steps">
          {c.ctaSteps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
        <p className="ff-evidence-closer">{c.ctaCloser}</p>
        <div className="ff-evidence-cta-actions">
          {c.ctaButtons.map((b, i) => {
            const cls = `ff-btn ${b.primary ? "ff-btn--red" : "ff-btn--ghost"}`;
            if (b.action === "share") {
              return <button key={i} type="button" className={cls} onClick={shareEvidence}>{b.label}</button>;
            }
            return <a key={i} href={b.href} className={cls}>{b.label}</a>;
          })}
        </div>
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

// ---------- App ----------
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

  const scrollTo = (id) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  return (
    <ContentContext.Provider value={content}>
      <TopBanner />
      <Nav onDonate={scrollTo("donate")}/>
      <main>
        <Hero onWatch={scrollTo("evidence")} />
        <ImpactBar />
        <IntroVideo />
        <Evidence />
        <Summary />
        <Petition />
        <ActionCards />
        <Quote />
        <DonateBand />
        <Newsletter />
      </main>
      <Footer />
    </ContentContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
