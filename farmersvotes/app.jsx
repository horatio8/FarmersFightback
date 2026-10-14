/* global React, ReactDOM */
// Farmers Fightback Votes front end. One bundle, routed on pathname, built
// from the Claude Design handoff (Home, Find, Result, HTV card, Issues,
// Donate, About). Reads /config/jurisdictions.json for dates and the
// authorisation line, /content/*.json for copy, and /api for the lookup,
// the seat, the boundary, capture and donations.
const { useState, useEffect, useRef, createContext, useContext } = React;

// ---------- attribution (same keys FF uses) ----------
const ATTR_KEY = "fv_attribution";
const ATTR_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ttclid", "ref"];
function captureAttribution() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ATTR_KEY) || "{}");
    const url = new URL(window.location.href);
    const fresh = {};
    ATTR_PARAMS.forEach((k) => { const v = url.searchParams.get(k); if (v) fresh[k] = v; });
    if (Object.keys(fresh).length) { fresh.landing_url = url.href; fresh.landing_at = new Date().toISOString(); sessionStorage.setItem(ATTR_KEY, JSON.stringify({ ...stored, ...fresh })); return { ...stored, ...fresh }; }
    return stored;
  } catch { return {}; }
}
const getAttribution = () => { try { return JSON.parse(sessionStorage.getItem(ATTR_KEY) || "{}"); } catch { return {}; } };
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const track = (name, data) => { try { if (window.fbq) window.fbq("track", name, data || {}); } catch {} };

const Config = createContext(null);
const useConfig = () => useContext(Config);
const nav = (to, replace) => { window.history[replace ? "replaceState" : "pushState"]({}, "", to); window.dispatchEvent(new PopStateEvent("popstate")); window.scrollTo(0, 0); };
const Link = ({ to, className, children, onClick, ...rest }) => (
  <a href={to} className={className} {...rest} onClick={(e) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || rest.target || to.startsWith("#") || /^[a-z]+:/i.test(to)) return;
    e.preventDefault(); nav(to);
  }}>{children}</a>
);

function useFetch(url, deps = []) {
  const [s, set] = useState({ loading: !!url, data: null, error: null });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    set({ loading: true, data: null, error: null });
    fetch(url).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((d) => alive && set({ loading: false, data: d, error: null }))
      .catch((e) => alive && set({ loading: false, data: null, error: e.message }));
    return () => { alive = false; };
  }, deps);
  return s;
}
function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => { const r = () => setW(window.innerWidth); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  return w;
}
const useTitle = (t) => useEffect(() => { document.title = t ? `${t} · Farmers Fightback Votes` : "Farmers Fightback Votes · Save our farmers. Put Labor Last."; }, [t]);

// ---------- dates ----------
const TZ = "Australia/Melbourne";
const dayOf = (iso) => new Date(String(iso).slice(0, 10) + "T12:00:00");
const fmt = (d, o) => d.toLocaleDateString("en-AU", { timeZone: TZ, ...o });
function useElection() {
  const cfg = useConfig();
  return ((cfg.states || {})[cfg.site.default_jurisdiction] || {}).election || {};
}
const dayMonth = (iso) => fmt(dayOf(iso), { day: "numeric", month: "long" });

// ---------- shared bits ----------
const ICON = {
  farmers: "M4 20h16v-2H4v2zm1-9 2.3-6.9c.2-.6.8-1.1 1.4-1.1h6.6c.6 0 1.2.4 1.4 1.1L19 11h1v2h-1.2l-.6 4H5.8l-.6-4H4v-2h1zm2.1 0h9.8l-1.6-5H8.7L7.1 11zM9 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm6 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  cities: "M3 21V9l5-3 5 3v3h3V7l5 2v12H3zm2-2h3v-3H5v3zm0-5h3v-3H5v3zm5 5h3v-3h-3v3zm0-5h3v-3h-3v3zm6 5h3v-3h-3v3zm0-5h3v-3h-3v3z",
  tick: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
  swap: "M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z",
  photo: "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z",
};
const Ico = ({ d, size = 24 }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;

// Platform share links with brand colours and marks (share-links.js in the design).
function shareLinks(url, msg, subject) {
  const e = encodeURIComponent;
  return [
    { label: "Facebook", bg: "#1877F2", href: `https://www.facebook.com/sharer/sharer.php?u=${e(url)}`,
      icon: "M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.32l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07" },
    { label: "Messenger", bg: "#0084FF", href: `fb-messenger://share/?link=${e(url)}`,
      icon: "M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 00-.64.05l-2.39 1.05a.96.96 0 01-1.35-.85l-.07-2.14a.97.97 0 00-.32-.68A11.39 11.389 0 01.002 11.64zm8.32-2.19l-3.52 5.6c-.35.53.32 1.139.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 00-2.61.48z" },
    { label: "WhatsApp", bg: "#25D366", href: `https://wa.me/?text=${e(msg)}`,
      icon: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" },
    { label: "X", bg: "#000000", href: `https://twitter.com/intent/tweet?text=${e(msg)}`,
      icon: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" },
    { label: "Email", bg: "#5B574E", href: `mailto:?subject=${e(subject)}&body=${e(msg)}`,
      icon: "M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 4.24l-8 5-8-5V6.5l8 5 8-5z" },
    { label: "Text", bg: "#2E7D32", href: `sms:?&body=${e(msg)}`,
      icon: "M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zM7 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" },
  ];
}
function ShareGrid({ url, msg, subject, label }) {
  return (
    <div className="v-share">
      {shareLinks(url, msg, subject).map((s) => (
        <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={`Share on ${s.label}`} style={{ background: s.bg }} onClick={() => track("Share", { content_name: label || "", method: s.label })}>
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d={s.icon} fill="#fff" /></svg>
          <span>{s.label}</span>
        </a>
      ))}
    </div>
  );
}
const seatPath = (state, name) => `/seat/${state}/${encodeURIComponent(name)}`;
const seatShare = (state, name) => {
  const r = store.get("fv_reminder");
  return `${window.location.origin}${seatPath(state, name)}${r && r.referral_code ? `?ref=${r.referral_code}` : ""}`;
};
const seatMsg = (name, url) => `Save our farmers: Put Labor Last. Here's how to vote in ${name}: ${url}`;

// Postcode → seat. Answers one of: invalid, unknown, outside, multi, one.
async function findSeat(pc) {
  if (!/^\d{4}$/.test(pc)) return { kind: "invalid" };
  const r = await fetch(`/api/lookup?postcode=${pc}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { kind: "error", message: j.error || "Lookup failed. Try again." };
  try { sessionStorage.setItem("fv_last_seat", JSON.stringify({ postcode: pc })); } catch {}
  track("Search", { search_string: "postcode", content_category: "lookup" });
  if (!j.supported) return j.reason === "Unknown postcode" ? { kind: "unknown" } : { kind: "outside" };
  const region = (j.options.council || [])[0] || "";
  if (j.resolved === false) return { kind: "multi", state: j.state, postcode: pc, region, options: j.options.assembly };
  return { kind: "one", state: j.state, postcode: pc, region, name: j.options.assembly[0].name };
}
const LOOKUP_MSG = {
  invalid: "Enter the four digits of your postcode.",
  unknown: "We can't find that postcode. Check the four digits.",
};

function SeatOptions({ result, places }) {
  const split = (((places || {}).split_postcodes) || {})[result.postcode] || {};
  return (
    <div className="v-multi">
      <p className="v-multi-q">Postcode {result.postcode} covers more than one electorate. Tap yours.</p>
      <div className="v-multi-grid">
        {result.options.map((o) => (
          <Link key={o.code} to={seatPath(result.state, o.name)} className="v-multi-opt">
            <span className="v-multi-name">{o.name}</span>
            <span className="v-multi-places">{(split[o.name] || []).join(", ") || `${Math.round(o.share * 100)}% of the postcode`}</span>
            <span className="v-multi-go">This is mine →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
function OutsideBox() {
  return (
    <div className="v-notice">
      <p className="v-notice-h">That postcode is outside Victoria.</p>
      <p>Only Victorians vote on 28 November, but you can still read why Labor goes last and pass it on.</p>
      <Link to="/issues" className="v-osw-link">Read the issues →</Link>
    </div>
  );
}
function PostcodeForm({ onSubmit, busy, value, onChange, buttonClass = "v-btn v-btn--navy" }) {
  return (
    <form className="v-pc-form" onSubmit={onSubmit}>
      <input className="v-pc-input" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" pattern="[0-9]*" maxLength={4} placeholder="Your postcode" aria-label="Your postcode" autoComplete="postal-code" />
      <button type="submit" className={buttonClass} disabled={busy}>{busy ? "Looking up…" : "Find my candidates"}</button>
    </form>
  );
}

// ---------- chrome ----------
function VotesHeader({ donateTo = "/donate" }) {
  const el = useElection();
  const width = useWidth();
  const [open, setOpen] = useState(false);
  const now = new Date();
  const early = el.early_voting_from ? dayOf(el.early_voting_from) : null;
  const day = el.date ? dayOf(el.date) : null;
  let strip = "Put Labor Last.";
  if (early && day && now >= early && now < day) strip = "Early voting is open. Put Labor Last.";
  else if (day && now >= day) strip = "Vote today. Put Labor Last.";
  else if (early) strip = `${Math.max(1, Math.ceil((early - now) / 86400000))} days until early voting opens`;
  const dayLabel = day ? fmt(day, { weekday: "long", day: "numeric", month: "long" }) : "";
  const isMobile = width < 860;
  const links = [["/seat", "Who to vote for"], ["/issues", "Issues"], ["/about", "About"]];
  return (
    <>
      <div className="iss-strip"><span>{strip}</span><span className="dot">·</span><span className="day">Election day {dayLabel}</span></div>
      <header className="iss-header">
        <div className="iss-header-inner">
          <Link to="/" className="iss-logo"><img src="/assets/logo-votes.png" alt="Farmers Fightback Votes" /></Link>
          {!isMobile && <nav className="iss-nav">{links.map(([to, l]) => <Link key={to} to={to}>{l}</Link>)}</nav>}
          <div className="iss-header-cta">
            <Link to={donateTo} className="iss-donate-gold">Donate</Link>
            {isMobile && <button type="button" className="iss-burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>☰</button>}
          </div>
        </div>
        {isMobile && open && <nav className="iss-menu">{links.map(([to, l]) => <Link key={to} to={to} onClick={() => setOpen(false)}>{l}</Link>)}</nav>}
      </header>
    </>
  );
}
function VotesFooter() {
  const cfg = useConfig();
  return (
    <footer className="iss-footer">
      <div className="iss-wrap">
        <div className="iss-footer-grid">
          <div className="iss-footer-brand">
            <img src="/assets/logo-votes-white.png" alt="Farmers Fightback Votes" />
            <p>Save our farmers.<br />Put Labor Last.</p>
          </div>
          <nav className="iss-footer-nav" aria-label="Footer">
            <Link to="/seat">Who to vote for</Link>
            <Link to="/issues">Why put Labor last</Link>
            <Link to="/donate" className="gold">Donate</Link>
            <Link to="/about">About us</Link>
          </nav>
        </div>
        <p className="iss-auth">{cfg.site.authorisation}</p>
      </div>
    </footer>
  );
}
function Page({ children, donateTo, footer }) {
  return <div className="fv"><VotesHeader donateTo={donateTo} /><main className="v-main">{children}</main>{footer || <VotesFooter />}</div>;
}

function WhenWhere() {
  const el = useElection();
  const early = el.early_voting_from ? dayOf(el.early_voting_from) : null;
  const lastEarly = el.date ? new Date(dayOf(el.date).getTime() - 86400000) : null;
  const enrol = el.enrolment_close ? new Date(el.enrolment_close) : null;
  const vec = el.commission_url || "https://www.vec.vic.gov.au";
  return (
    <section className="v-sec v-sec--paper">
      <div className="v-wrap v-pad">
        <h2 className="v-h2">When and where to vote</h2>
        <div className="v-tiles">
          <div className="v-tile v-tile--red"><p className="v-tile-h">Election day</p><p className="v-tile-big">{el.date ? fmt(dayOf(el.date), { weekday: "long", day: "numeric", month: "long" }) : ""}</p><p>8am to 6pm</p></div>
          <div className="v-tile"><p className="v-tile-h">Early voting</p><p className="v-tile-big">{early && lastEarly ? `${fmt(early, { weekday: "short", day: "numeric" })} to ${fmt(lastEarly, { weekday: "short", day: "numeric", month: "long" })}` : ""}</p><p>9am to 8pm. Closed Sunday. Closes 6pm on the last Friday.</p></div>
          <div className="v-tile"><p className="v-tile-h">Enrolment closes</p><p className="v-tile-big">{enrol ? `${enrol.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric" }).replace(" ", "")}, ${fmt(enrol, { weekday: "long", day: "numeric", month: "long" })}` : ""}</p><p><a href="https://www.vec.vic.gov.au/enrolment" target="_blank" rel="noopener noreferrer">Check or update your enrolment</a></p></div>
        </div>
        <div className="v-row">
          <a href={vec} target="_blank" rel="noopener noreferrer" className="v-btn v-btn--outline">Find a voting centre (VEC)</a>
          <a href={vec} target="_blank" rel="noopener noreferrer" className="v-btn v-btn--outline">Apply for a postal vote</a>
        </div>
      </div>
    </section>
  );
}

// ---------- home ----------
const PRESETS = [35, 65, 135, 265, 550, 1500];
const CAP = 5190;
const money = (n) => "$" + Number(n).toLocaleString("en-AU");

// The yellow band: postcode in, straight on to the lookup page, which offers
// a pick list for split postcodes or goes on to the electorate.
function HomeLookup() {
  const [pc, setPc] = useState("");
  const [err, setErr] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(pc)) return setErr(LOOKUP_MSG.invalid);
    nav(`/seat?postcode=${pc}`);
  };
  return (
    <section id="find" className="v-sec v-find">
      <div className="v-wrap v-narrow v-pad">
        <h2 className="v-h2 v-h2--find">How to Vote Labor Out:</h2>
        <p className="v-find-lede">Enter your postcode to see who's running in your electorate and how to number your ballot.</p>
        <PostcodeForm value={pc} onChange={(v) => { setPc(v); setErr(""); }} onSubmit={submit} />
        {err && <p className="v-err">{err}</p>}
      </div>
    </section>
  );
}
function DonateMatrix() {
  const [amount, setAmount] = useState(135);
  const [other, setOther] = useState("");
  const [showOther, setShowOther] = useState(false);
  const value = showOther ? (parseInt(other, 10) || 0) : amount;
  return (
    <section id="donate" className="v-sec v-matrix">
      <div className="v-wrap v-narrow v-pad v-pad--lg">
        <p className="v-kicker v-kicker--pink">★ Every dollar goes on the ground</p>
        <h2 className="v-h2 v-h2--light">Back the farmers. Chip in.</h2>
        <p className="v-gold-line">Every $100 helps reach 100 voters.</p>
        <p className="v-matrix-lede">No party money. No corporate money. Just Australians standing up for farming families.</p>
        <div className="v-matrix-grid">
          {PRESETS.map((v, i) => (
            <button type="button" key={v} aria-pressed={!showOther && amount === v} style={{ gridColumn: (i % 3) + 1, gridRow: i < 3 ? 1 : 2 }} onClick={() => { setAmount(v); setShowOther(false); }}>{money(v)}</button>
          ))}
          <button type="button" aria-pressed={showOther} style={{ gridColumn: 4, gridRow: "1 / 3" }} onClick={() => setShowOther(true)}>Other amount</button>
        </div>
        {showOther && (
          <div className="v-other v-other--light">
            <span>$</span>
            <input value={other} onChange={(e) => setOther(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Other amount" aria-label="Other amount" autoFocus />
          </div>
        )}
        <Link to={`/donate?amount=${value || ""}`} className="v-btn v-btn--red v-btn--xl v-btn--block">{value ? `Give ${money(value)} now` : "Enter an amount"}</Link>
        <p className="v-matrix-fine">Victorian law caps gifts at {money(CAP)} per donor for this election. Donations are not tax deductible.</p>
      </div>
    </section>
  );
}
function HomeFooter() {
  const cfg = useConfig();
  return (
    <footer className="iss-footer">
      <div className="iss-wrap v-home-foot">
        <img src="/assets/logo-votes-white.png" alt="Farmers Fightback Votes" />
        <p>Farmers Fightback Votes is a special election vehicle set up for this campaign. It is separate from Farmers Fightback and from the Wallaloo and Gre Gre District Association.</p>
        <p className="v-home-foot-auth">{cfg.site.authorisation}</p>
        <p>Contact: <a href={`mailto:${cfg.site.support_email}`}>{cfg.site.support_email}</a></p>
      </div>
    </footer>
  );
}
function HomePage() {
  useTitle("");
  const el = useElection();
  const width = useWidth();
  const issues = useFetch("/content/issues.json", []);
  const city = new URLSearchParams(window.location.search).get("a") === "city";
  return (
    <Page donateTo="#donate" footer={<HomeFooter />}>
      <section id="top" className="v-hero">
        <div className="v-hero-shade" />
        <div className="v-wrap v-hero-inner">
          <h1 className="v-hero-h1"><span>{city ? "Save your power bill." : "Save our farmers."}</span><span className="v-hero-serif">Vote Labor Out.</span></h1>
          <p className="v-hero-lede">{el.date ? dayMonth(el.date) : "Election day"} is the only chance we get to stop them. Make it count.</p>
          <div className="v-row v-row--hero">
            <a href="#donate" className="v-btn v-btn--red v-btn--lg">Chip in now</a>
            <a href="#find" className="v-btn v-btn--ghost v-btn--lg">Find my candidates</a>
          </div>
        </div>
      </section>
      <HomeLookup />
      <section className="v-sec v-sec--paper">
        <div className="v-wrap v-pad-top">
          <h2 className="v-h2 v-h2--story"><span className="v-red">Labor has devastated Aussie farmers.</span> <span className="v-story-sub">This is our only chance to stop them.</span></h2>
        </div>
        <div className="v-wrap v-story">
          <div className="v-story-img"><img src="/assets/issues/mary-colin.jpg" alt="Mary and Colin at their farm gate" /></div>
          <div>
            <p className="v-kicker">★ Fined at their own gate</p>
            <h2 className="v-h2 v-h2--mc">Labor fined 12 farmers nearly $1000 for defending their own farm.</h2>
            <p className="v-story-p">Mary and Colin, both 80, were fined $814 at their own gate. Labor handed the line to a Spanish multinational to build, own and operate.</p>
            <Link to="/issues#issue-3" className="v-underline">Read their story →</Link>
          </div>
        </div>
      </section>
      <section className="v-sec v-redband">
        <div className="v-wrap v-band">
          <p>Help get rid of Labor.</p>
          <a href="#donate" className="v-btn v-btn--gold v-btn--band">Donate</a>
        </div>
      </section>
      <section id="issues" className="v-sec v-sec--paper">
        <div className="v-wrap v-pad v-pad--issues">
          <h2 className="v-h2 v-h2--issues">Why Labor goes last</h2>
          {issues.data && issues.data.groups.map((g) => (
            <div className="v-issue-row" key={g.key}>
              <p className="v-rule"><span>★ {g.home_label}</span><span className="v-rule-line" /></p>
              <div className="v-cards">
                {g.issues.map((it) => (
                  <Link key={it.id} to={`/issues#${it.id}`} className="v-card">
                    <IssueSlot it={it} />
                    <span className="v-card-t">{it.title}</span>
                    <span className="v-card-s">{it.teaser}</span>
                    <span className="v-card-more">Read more →</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <DonateMatrix />
      {width < 860 && (
        <div className="v-sticky"><a href="#donate" className="v-btn v-btn--red v-btn--block v-btn--sticky">Donate</a></div>
      )}
    </Page>
  );
}

// ---------- find ----------
function FindPage() {
  useTitle("Find your candidates");
  const given = (new URLSearchParams(window.location.search).get("postcode") || "").replace(/\D/g, "").slice(0, 4);
  const [pc, setPc] = useState(given);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const places = useFetch("/content/places.json", []);
  const run = async (code) => {
    setRes(null); setBusy(true);
    try {
      const r = await findSeat(code);
      // One electorate: go straight there, replacing this step so Back
      // returns to where they typed the postcode.
      if (r.kind === "one") return nav(seatPath(r.state, r.name), !!given);
      setRes(r);
    } catch { setRes({ kind: "error", message: "Lookup failed. Try again." }); } finally { setBusy(false); }
  };
  useEffect(() => { if (given) run(given); }, []);
  const submit = (e) => { e.preventDefault(); run(pc); };
  const msg = res && (LOOKUP_MSG[res.kind] || res.message);
  return (
    <Page>
      <section className="v-sec v-find-page">
        <div className="v-wrap v-narrow v-pad">
          <p className="v-kicker">★ Find your candidates</p>
          <h1 className="v-h1 v-h1--navy">How to Vote Labor Out</h1>
          <PostcodeForm value={pc} onChange={(v) => { setPc(v); setRes(null); }} onSubmit={submit} busy={busy} />
          <p className="v-hint">Just the four digits. We never ask for or store your street address.</p>
          {msg && <p className="v-err">{msg}</p>}
          {res && res.kind === "outside" && <OutsideBox />}
          {res && res.kind === "multi" && <SeatOptions result={res} places={places.data} />}
        </div>
      </section>
      <WhenWhere />
    </Page>
  );
}

// ---------- result ----------
const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 3).join("").toUpperCase();
const isLabor = (p) => /labor/i.test(p || "");
const isOneNation = (p) => (/one nation/i.test(p || "") ? 1 : 0);
function profileLine(c, seatName) {
  if (c.retiring) return `Sitting ${c.party} member for ${seatName}. Retiring at this election.`;
  if (c.incumbent) return `Sitting ${c.party} member for ${seatName}.`;
  return `Declared ${c.party} candidate.`;
}
function HTVCard({ electorate, rows, drawDate }) {
  const cfg = useConfig();
  const live = rows && rows.length > 0;
  return (
    <div className="v-htv-wrap">
      <div className="v-htv">
        <div className="v-htv-top"><img src="/assets/logo-votes.png" alt="Farmers Fightback Votes" /><span>{electorate}</span></div>
        <h2 className="v-htv-h">Save our farmers:<br /><span>Put Labor Last</span></h2>
        <p className="v-htv-k">How to vote in {electorate} · Lower house</p>
        {live ? (
          <>
            <div className="v-htv-ballot">
              {rows.map((r, i) => (
                <div className="v-htv-row" key={r.name}>
                  <span className={"v-htv-box" + (isLabor(r.party) ? " is-labor" : "")}>{i + 1}</span>
                  <span className="v-htv-who"><span className="v-htv-name">{r.name}</span><span className="v-htv-party">{r.party}</span></span>
                </div>
              ))}
            </div>
            <p className="v-htv-every">Number every box</p>
          </>
        ) : (
          <div className="v-htv-pending"><p>Your how-to-vote card goes live on {drawDate ? dayMonth(drawDate) : "the ballot draw"}</p></div>
        )}
        <p className="v-htv-auth">{cfg.site.authorisation}. {window.location.host}</p>
      </div>
    </div>
  );
}
// Party colours, close to each party's own.
const PARTY_COLOURS = [
  [/labor/i, "#E13A3A"], [/liberal|coalition/i, "#1C4F9C"], [/national/i, "#006644"], [/greens/i, "#10A34A"],
  [/one nation/i, "#F36C21"], [/socialist/i, "#B0122A"], [/family first/i, "#6B2C91"], [/animal justice/i, "#0B7F8A"],
  [/sustainable/i, "#2E7D32"], [/western victoria/i, "#C99700"], [/libertarian/i, "#D4A20B"], [/shooters|farmers/i, "#8B5A2B"],
  [/cannabis/i, "#3E8E41"],
];
const partyColour = (p) => (PARTY_COLOURS.find(([re]) => re.test(p || "")) || [null, "#5B574E"])[1];

// Real maps: Leaflet with the seat's boundary from /api/boundary on top.
// Tiles come from MapTiler (key in config site.maptiler_key, locked to our
// domains in the MapTiler dashboard), or CARTO's free OpenStreetMap tiles
// when no key is set. "hero" is a fixed, tinted backdrop; "full" is the
// interactive map lower down the page.
const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const tileSource = (key) => key
  ? { url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`, opts: { tileSize: 512, zoomOffset: -1, attribution: `&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ${OSM}`, maxZoom: 18, crossOrigin: true } }
  : { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", opts: { subdomains: "abcd", attribution: `${OSM} &copy; <a href="https://carto.com/attributions">CARTO</a>`, maxZoom: 18, detectRetina: true } };
function SeatLeaflet({ boundary, variant, label }) {
  const el = useRef(null);
  const key = useConfig().site.maptiler_key || "";
  useEffect(() => {
    if (!boundary || !el.current || !window.L) return;
    const L = window.L, hero = variant === "hero";
    const map = L.map(el.current, {
      zoomControl: !hero, attributionControl: !hero, dragging: !hero && !L.Browser.mobile, touchZoom: !hero,
      scrollWheelZoom: false, doubleClickZoom: !hero, boxZoom: false, keyboard: !hero, tap: false, zoomSnap: 0.25,
    });
    const src = tileSource(key);
    L.tileLayer(src.url, src.opts).addTo(map);
    const shape = L.polygon(boundary.rings.map((r) => r.map(([x, y]) => [y, x])), hero
      ? { color: "#fff", weight: 3, fillColor: "#5FA8FF", fillOpacity: 0.28, interactive: false }
      : { color: "#143E65", weight: 3, fillColor: "#143E65", fillOpacity: 0.16 }).addTo(map);
    // On wide screens the hero shape sits in the right half, clear of the headline.
    const fit = () => {
      map.invalidateSize();
      const wide = el.current.clientWidth >= 860;
      // Narrow screens: the shape sits in the top part, above the headline.
      map.fitBounds(shape.getBounds(), !hero ? { padding: [24, 24] } : wide ? { paddingTopLeft: [Math.round(el.current.clientWidth * 0.5), 30], paddingBottomRight: [40, 30] } : { paddingTopLeft: [24, 20], paddingBottomRight: [24, Math.round(el.current.clientHeight * 0.56)] });
    };
    fit();
    const again = setTimeout(fit, 250);
    window.addEventListener("resize", fit);
    return () => { clearTimeout(again); window.removeEventListener("resize", fit); map.remove(); };
  }, [boundary, variant, key]);
  return <div ref={el} className={`v-leaflet v-leaflet--${variant}`} role="img" aria-label={label} />;
}
// The page's main ask: first name and mobile for an election-day text.
// Postcode comes from the lookup; it is never asked for here.
function Reminder({ seat, state }) {
  const saved = store.get("fv_reminder");
  const last = (() => { try { return JSON.parse(sessionStorage.getItem("fv_last_seat") || "{}"); } catch { return {}; } })();
  const postcode = /^\d{4}$/.test(last.postcode || "") ? last.postcode : "";
  const [f, setF] = useState({ first_name: "", mobile: "" });
  const [done, setDone] = useState(saved && saved.mobile ? saved : null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const name = seat.seat.name;
  const up = (k, clean) => (e) => { setF((s) => ({ ...s, [k]: clean(e.target.value) })); setErr(""); };
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    const d = f.mobile.replace(/\s/g, "");
    if (!f.first_name.trim()) return setErr("Your first name, please.");
    if (!/^04\d{8}$/.test(d)) return setErr("Enter an Australian mobile number, like 0412 345 678.");
    setBusy(true);
    try {
      const attr = getAttribution();
      const r = await fetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ first_name: f.first_name.trim(), mobile: d, postcode, consent_sms: true, seat_state: name, seat_region: seat.region ? seat.region.name : "", jurisdiction: state, source: "Reminder", ref: attr.ref || "", utm: attr }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
      const rec = { first_name: f.first_name.trim(), mobile: f.mobile, referral_code: j.referral_code || null, at: Date.now() };
      store.set("fv_reminder", rec);
      track("Lead", { content_name: "Election day reminder" });
      setDone(rec);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const url = seatShare(state, name);
  return (
    <section className="v-sec v-remind" id="remind">
      <div className="v-wrap v-narrow v-pad-md">
        {!done ? (
          <>
            <h2 className="v-h2 v-h2--light v-h2--md">Don't miss out. We'll remind you on the day.</h2>
            <p className="v-remind-p">Tell us your first name and mobile and we'll text you on {dayMonth(seat.election.date)} with exactly how to vote Labor out in {name}.</p>
            <form className="v-remind-form" onSubmit={submit} noValidate>
              <input className="v-pc-input v-remind-in" value={f.first_name} onChange={up("first_name", (v) => v.slice(0, 60))} autoComplete="given-name" placeholder="First name" aria-label="First name" />
              <input className="v-pc-input v-remind-in" value={f.mobile} onChange={up("mobile", (v) => v.replace(/[^\d ]/g, "").slice(0, 12))} inputMode="tel" type="tel" autoComplete="tel" placeholder="Mobile number" aria-label="Mobile number" />
              <button type="submit" className="v-btn v-btn--navy v-remind-btn" disabled={busy}>{busy ? "One sec…" : "Remind me on election day"}</button>
            </form>
            {err && <p className="v-remind-err">{err}</p>}
            <p className="v-remind-fine">One text on election day with your how-to-vote card. Reply STOP to opt out.</p>
          </>
        ) : (
          <>
            <p className="v-kicker v-kicker--pink">★ You're on the list</p>
            <h2 className="v-h2 v-h2--light v-h2--md">Thanks{done.first_name ? `, ${done.first_name}` : ""}. We'll text {done.mobile} on {dayMonth(seat.election.date)}.</h2>
            <p className="v-remind-p">Now the bit that wins it. Most people in {name} haven't heard any of this. Send them this page.</p>
            <ShareGrid url={url} msg={seatMsg(name, url)} subject={`How to vote in ${name}`} label={name} />
          </>
        )}
      </div>
    </section>
  );
}
function SeatPage({ state, district }) {
  const { loading, data, error } = useFetch(state && district ? `/api/seat?state=${state}&district=${encodeURIComponent(district)}` : null, [state, district]);
  const boundary = useFetch(state && district ? `/api/boundary?state=${state}&district=${encodeURIComponent(district)}` : null, [state, district]).data;
  useTitle(data ? `How to vote in ${data.seat.name}` : "Your electorate");
  useEffect(() => { if (data) track("ViewContent", { content_name: `Seat ${data.seat.name}`, content_category: "how-to-vote" }); }, [data]);
  if (!state || !district) return <FindPage />;
  if (error) return <Page><section className="v-sec"><div className="v-wrap v-narrow v-pad"><h1 className="v-h1 v-h1--navy">We couldn't find that electorate.</h1><p className="v-lede-dark">{error}</p><Link to="/seat" className="v-btn v-btn--navy">Look up your postcode</Link></div></section></Page>;
  if (loading || !data) return <Page><section className="v-sec v-res-head"><div className="v-wrap v-pad"><div className="v-skel" /></div></section></Page>;

  const name = data.seat.name, region = data.region ? data.region.name : "";
  const ballot = data.copy.ballot || [];
  const after = ballot.length > 0;
  const stances = data.copy.stances || {};
  const byName = Object.fromEntries(data.lower.map((c) => [c.name, c]));
  const list = after
    ? ballot.map((b) => ({ ...(byName[b.name] || {}), ...b }))
    : [...data.lower].sort((a, b) => (isOneNation(b.party) - isOneNation(a.party)) || ((b.incumbent ? 1 : 0) - (a.incumbent ? 1 : 0)));
  return (
    <Page>
      <section className="v-sec v-res-head">
        <SeatLeaflet boundary={boundary} variant="hero" label={`Map of the ${name} electorate`} />
        <div className="v-res-tint" />
        <div className="v-wrap v-pad-head v-res-inner">
          <p className="v-res-k">Your electorate{region ? ` · ${region} Region` : ""}</p>
          <h1 className="v-res-name"><span className="v-res-pll">Put Labor Last in</span>{name}</h1>
          <p className="v-res-hook">{data.copy.hook}</p>
        </div>
      </section>
      <Reminder seat={data} state={state} />
      <section className="v-sec v-sec--white">
        <div className="v-wrap v-narrow v-pad">
          <h2 className="v-h2 v-h2--tight">{after ? `Candidates in ${name}` : `Who's standing in ${name} so far`}</h2>
          <p className="v-muted v-mb">{after ? "In how-to-vote order. Labor last." : `Sitting MP and declared candidates. The full list comes after the ballot draw${data.copy.ballot_draw ? ` on ${dayMonth(data.copy.ballot_draw)}` : ""}.`}</p>
          {list.length ? (
            <div className="v-cands">
              {list.map((c, i) => (
                <article key={c.name} className="v-cand" style={{ "--party": partyColour(c.party) }}>
                  <div className="v-cand-top">
                    <div className="v-cand-ini">{initials(c.name)}</div>
                    <div className="v-cand-id">
                      {after && <span className="v-cand-num">Vote {i + 1}</span>}
                      <p className="v-cand-name">{c.name}</p>
                      <p className="v-cand-party">{c.party}</p>
                    </div>
                  </div>
                  <p className="v-cand-prof">{profileLine(c, name)}</p>
                  {stances[c.name] && <p className="v-cand-stance"><strong>On the transmission lines:</strong> {stances[c.name]}</p>}
                </article>
              ))}
            </div>
          ) : <p className="v-p">No candidates announced yet for {name}.</p>}
        </div>
      </section>
      <section className="v-sec v-sec--paper">
        <div className="v-wrap v-pad v-map-grid">
          <div className="v-map-real">
            <SeatLeaflet boundary={boundary} variant="full" label={`Map of the ${name} electorate`} />
            <span className="v-map-credit">Boundary: ABS ASGS 2024, CC BY 4.0</span>
          </div>
          <div>
            <h2 className="v-h2 v-h2--tight">The {name} electorate</h2>
            {data.copy.places.length > 0 && <><p className="v-p">Main towns and suburbs:</p><p className="v-places">{data.copy.places.join(", ")}</p></>}
            <p className="v-muted v-mt"><Link to="/seat">Not your electorate? Look up another postcode.</Link></p>
          </div>
        </div>
      </section>
      <WhenWhere />
    </Page>
  );
}

// ---------- how-to-vote card on its own (save / print) ----------
function CardPage({ state, district }) {
  const { data, error } = useFetch(`/api/seat?state=${state}&district=${encodeURIComponent(district)}`, [state, district]);
  useTitle(data ? `How-to-vote card: ${data.seat.name}` : "How-to-vote card");
  const printing = new URLSearchParams(window.location.search).get("print") === "1";
  useEffect(() => { if (data && printing) setTimeout(() => window.print(), 400); }, [data]);
  if (error) return <Page><section className="v-sec"><div className="v-wrap v-narrow v-pad"><p className="v-p">{error}</p></div></section></Page>;
  if (!data) return null;
  const byName = Object.fromEntries(data.lower.map((c) => [c.name, c]));
  const rows = (data.copy.ballot || []).map((b) => ({ ...(byName[b.name] || {}), ...b }));
  return (
    <div className="fv v-card-page">
      <HTVCard electorate={data.seat.name} rows={rows} drawDate={data.copy.ballot_draw} />
      <div className="v-row v-card-actions">
        <button type="button" className="v-btn v-btn--navy" onClick={() => window.print()}>Print A5</button>
        <Link to={seatPath(state, data.seat.name)} className="v-btn v-btn--outline">Back to {data.seat.name}</Link>
      </div>
      <p className="v-hint v-card-tip">To save it to your phone, take a screenshot of the card.</p>
    </div>
  );
}

// ---------- issues: "Why put Labor last" ----------
// Copy, photos and source links live in /content/issues.json.
function IssueSlot({ it }) {
  if (it.image) return <div className="iss-slot"><img src={it.image} alt={it.caption || it.face || ""} loading="lazy" /></div>;
  return (
    <div className="iss-slot" role="img" aria-label={it.face}>
      <div className="iss-slot-empty"><Ico d={ICON.photo} size={28} /><span>{it.face}</span></div>
    </div>
  );
}
function IssuesPage() {
  useTitle("Why put Labor last");
  const { loading, data: c, error } = useFetch("/content/issues.json", []);
  const width = useWidth();
  const [trk, setTrk] = useState(null);
  const pending = useRef(null);
  useEffect(() => {
    const h = window.location.hash;
    if (window.innerWidth < 900) { if (/issue-[123]/.test(h)) setTrk("farmers"); if (/issue-[456]/.test(h)) setTrk("cities"); }
  }, []);
  useEffect(() => {
    if (!c) return;
    const id = pending.current; pending.current = null;
    if (id) { const el = document.getElementById(id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: "smooth" }); return; }
    const h = window.location.hash.slice(1);
    if (h) { const el = document.getElementById(h); if (el) el.scrollIntoView(); }
  }, [c, trk]);
  const narrow = width < 900;
  const cur = trk || (narrow ? "farmers" : "both");
  const focused = cur !== "both";
  const groups = c ? c.groups : [];
  const visible = focused ? groups.filter((g) => g.key === cur) : groups;
  const curG = groups.find((g) => g.key === cur) || groups[0];
  const other = curG ? groups.find((g) => g.key !== curG.key) : null;
  const go = (g) => {
    const id = g.issues[0].id;
    if (g.key === trk) { const el = document.getElementById(id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: "smooth" }); return; }
    pending.current = id; setTrk(g.key);
  };
  return (
    <Page>
      {error && <section className="iss-intro"><div className="iss-wrap"><h1 className="iss-h1">We couldn't load this page.</h1><p className="iss-lede">{error}</p></div></section>}
      {c && (
        <>
          <section className="iss-intro">
            <div className="iss-wrap">
              <h1 className="iss-h1">{c.title}</h1>
              <p className="iss-lede">{c.lede}</p>
              <p className="iss-eyebrow">{c.step_eyebrow}</p>
              <p className="iss-question">{c.step_question}</p>
              <div className="iss-picker">
                {[...groups].sort((a, b) => (a.tab_order || 0) - (b.tab_order || 0)).map((g) => {
                  const on = cur === g.key;
                  return (
                    <button type="button" key={g.key} className="iss-tab" aria-pressed={on} onClick={() => go(g)}>
                      <Ico d={ICON[g.key]} size={44} />
                      <span className="iss-tab-text"><span className="iss-tab-label">{g.tab_label || g.label}</span><span className="iss-tab-sub">{g.sub}</span></span>
                      <span className="iss-tab-check">{on && <Ico d={ICON.tick} size={22} />}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
          {focused && curG && other && (
            <div className="iss-switch">
              <div className="iss-wrap">
                <span className="iss-switch-cur"><Ico d={ICON[curG.key]} size={22} />{curG.tab_label || curG.label}</span>
                <button type="button" className="iss-switch-btn" onClick={() => go(other)}>Switch to {other.tab_label || other.key} <Ico d={ICON.swap} size={18} /></button>
              </div>
            </div>
          )}
          <section className="iss-tracks">
            <div className={"iss-wrap" + (visible.length > 1 ? " is-two" : "")}>
              {visible.map((g) => (
                <div className="iss-group" key={g.key}>
                  <h2 className="iss-h2">{g.label}</h2>
                  {g.issues.map((it) => {
                    const extra = it.extra_from ? String(c[it.extra_from] || "").trim() : "";
                    return (
                      <article id={it.id} className="iss-card" key={it.id}>
                        <IssueSlot it={it} />
                        <div className="iss-card-body">
                          <h3 className="iss-h3">{it.title}</h3>
                          {it.punch && <p className="iss-punch">{it.punch}</p>}
                          <p className="iss-body">{it.body}</p>
                          <ul className="iss-proofs">
                            {(it.proofs || []).map((p, i) => (
                              <li className="iss-proof" key={i}>
                                <span>{p.text}</span>
                                <a href={p.href} target="_blank" rel="noopener" onClick={p.href === "#" ? (e) => e.preventDefault() : undefined}>Source</a>
                              </li>
                            ))}
                          </ul>
                          {it.help && <p className="iss-help">{c.help_line}</p>}
                          {extra && <p className="iss-extra">{extra}</p>}
                          <div className="iss-ctas">
                            <Link to="/seat" className="iss-btn-red">{c.cta_find}</Link>
                            <Link to="/donate" className="iss-btn-navy">{c.cta_donate}</Link>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
          <section className="iss-band">
            <div className="iss-wrap">
              <p>{c.band_heading}</p>
              <Link to="/donate" className="iss-band-btn">{c.band_cta}</Link>
            </div>
          </section>
        </>
      )}
      {loading && <div style={{ minHeight: "60vh" }} />}
    </Page>
  );
}

// ---------- donate ----------
function DonateThanks({ amount, email }) {
  const [pc, setPc] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const places = useFetch("/content/places.json", []);
  const url = window.location.origin;
  const submit = async (e) => {
    e.preventDefault(); setRes(null); setBusy(true);
    try { const r = await findSeat(pc); if (r.kind === "one") return nav(seatPath(r.state, r.name)); setRes(r); }
    catch { setRes({ kind: "error", message: "Lookup failed. Try again." }); } finally { setBusy(false); }
  };
  const msg = res && (LOOKUP_MSG[res.kind] || res.message);
  return (
    <>
      <section className="v-sec v-navy">
        <div className="v-wrap v-narrow v-pad-thanks">
          <p className="v-kicker v-kicker--pink">★ Thank you</p>
          <h1 className="v-h1 v-h1--light">{amount ? `${money(amount)} on the ground.` : "That's on the ground."} You beauty.</h1>
          <p className="v-thanks-p">Your receipt is on its way to {email || "your inbox"}. Keep it for four years. Now do the thing that money can't: tell people.</p>
          <ShareGrid url={url} msg={`I just chipped in to Save our farmers: Put Labor Last. Find your candidates: ${url}`} subject="Put Labor Last" label="Donate thanks" />
        </div>
      </section>
      <section className="v-sec v-sec--white">
        <div className="v-wrap v-narrow v-pad-thanks2">
          <h2 className="v-h2 v-h2--md">Now find your candidates</h2>
          <PostcodeForm value={pc} onChange={(v) => { setPc(v); setRes(null); }} onSubmit={submit} busy={busy} />
          {msg && <p className="v-err">{msg}</p>}
          {res && res.kind === "outside" && <OutsideBox />}
          {res && res.kind === "multi" && <SeatOptions result={res} places={places.data} />}
        </div>
      </section>
    </>
  );
}
function DonatePage() {
  useTitle("Donate");
  const cfg = useConfig();
  const q = new URLSearchParams(window.location.search);
  const sessionId = q.get("session_id");
  const preset = parseInt(q.get("amount"), 10);
  const [amount, setAmount] = useState(PRESETS.includes(preset) ? preset : 135);
  const [showOther, setShowOther] = useState(preset > 0 && !PRESETS.includes(preset));
  const [other, setOther] = useState(preset > 0 && !PRESETS.includes(preset) ? String(preset) : "");
  const [f, setF] = useState({ name: "", address: "", email: "", mobile: "" });
  const [errors, setErrors] = useState({});
  const [declared, setDeclared] = useState(false);
  const [declError, setDeclError] = useState(false);
  const [amountError, setAmountError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const thanks = useFetch(sessionId ? `/api/donate?session_id=${encodeURIComponent(sessionId)}` : null, [sessionId]);
  useEffect(() => { if (thanks.data && thanks.data.paid) track("Purchase", { value: thanks.data.amount, currency: "AUD" }); }, [thanks.data]);

  if (sessionId) return <Page>{thanks.loading ? <section className="v-sec v-navy"><div className="v-wrap v-narrow v-pad-thanks"><div className="v-skel" /></div></section> : <DonateThanks amount={thanks.data && thanks.data.amount} email={thanks.data && thanks.data.email} />}</Page>;

  const value = showOther ? (parseInt(other, 10) || 0) : amount;
  const over = value > CAP;
  const fields = [
    ["name", "Full name", "text", "text", "name", "As it appears on the electoral roll"],
    ["address", "Residential address", "text", "text", "street-address", "Street, suburb, postcode"],
    ["email", "Email", "email", "email", "email", "For your receipt"],
    ["mobile", "Mobile", "tel", "tel", "tel", "04.."],
  ];
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    const er = {};
    if (!f.name.trim()) er.name = "We need your full name.";
    if (!f.address.trim()) er.address = "We need your residential address.";
    if (!/^\S+@\S+\.\S+$/.test(f.email)) er.email = "Enter a valid email for your receipt.";
    if (!/^04\d{8}$/.test(f.mobile.replace(/\s/g, ""))) er.mobile = "Enter an Australian mobile, like 0412 345 678.";
    setErrors(er); setAmountError(!value); setDeclError(!declared);
    if (!value || over || !declared || Object.keys(er).length) return;
    setBusy(true);
    const attr = getAttribution();
    const [first, ...rest] = f.name.trim().split(/\s+/);
    fetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ first_name: first, last_name: rest.join(" "), email: f.email, mobile: f.mobile.replace(/\s/g, ""), consent_email: true, source: "Donate", ref: attr.ref || "", utm: attr }) }).catch(() => {});
    try {
      const r = await fetch("/api/donate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: value, ...f, declared, attribution: attr }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || "Could not start checkout. Please try again.");
      track("InitiateCheckout", { value, currency: "AUD" });
      window.location.href = j.url;
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };
  return (
    <Page>
      <section className="v-sec v-sec--paper">
        <div className="v-wrap v-donate v-pad-donate">
          <p className="v-kicker">★ Paid for by farmers and the people who back them</p>
          <h1 className="v-h1 v-h1--navy">Back the farmers. Chip in.</h1>
          <p className="v-donate-lede">No party money. No corporate money. Every dollar goes on ads, texts and how-to-vote cards in the seats that decide it.</p>
          <form onSubmit={submit} noValidate className="v-donate-form">
            <fieldset className="v-fs">
              <legend>1. Your amount</legend>
              <div className="v-amounts">
                {PRESETS.map((v) => <button type="button" key={v} aria-pressed={!showOther && amount === v} onClick={() => { setAmount(v); setShowOther(false); setAmountError(false); }}>{money(v)}</button>)}
                <button type="button" aria-pressed={showOther} onClick={() => { setShowOther(true); setAmountError(false); }}>Other</button>
              </div>
              {showOther && (
                <div className="v-other">
                  <span>$</span>
                  <input value={other} onChange={(e) => { setOther(e.target.value.replace(/\D/g, "")); setAmountError(false); }} inputMode="numeric" placeholder="Other amount" aria-label="Other amount" />
                </div>
              )}
              {over && <div className="v-alert"><p className="v-alert-h">That's over the legal limit.</p><p>Victorian law caps donations at {money(CAP)} per donor in total between 15 April and 28 November 2026. We can't accept more than that, even in instalments. Pick {money(CAP)} or less.</p></div>}
              {amountError && <p className="v-err">Pick an amount or enter your own.</p>}
            </fieldset>
            <fieldset className="v-fs">
              <legend>2. Your details</legend>
              <p className="v-muted v-fs-note">The law requires them on every gift. No anonymous donations.</p>
              {fields.map(([k, label, type, im, auto, ph]) => (
                <label key={k} className="v-field">
                  <span>{label}</span>
                  <input className={errors[k] ? "is-err" : ""} value={f[k]} onChange={(e) => { setF((s) => ({ ...s, [k]: e.target.value })); setErrors((s) => ({ ...s, [k]: "" })); }} type={type} inputMode={im} autoComplete={auto} placeholder={ph} />
                  {errors[k] && <span className="v-field-err">{errors[k]}</span>}
                </label>
              ))}
            </fieldset>
            <fieldset className="v-fs">
              <legend>3. Payment</legend>
              <div className="v-pay"><p>You'll enter your card on Stripe's secure payment page next. Your card details never touch this site.</p></div>
            </fieldset>
            <div className="v-give">
              <button type="submit" className="v-btn v-btn--red v-btn--xl" disabled={busy}>{busy ? "One moment…" : value ? `Give ${money(value)}` : "Give"}</button>
              {err && <div className="v-alert"><p className="v-alert-h">{err}</p></div>}
              {declError && <div className="v-alert"><p className="v-alert-h">We can't take your gift without the declaration. Tick the box below to continue.</p></div>}
              <div className="v-terms">
                <label className={"v-decl" + (declError ? " is-err" : "")}>
                  <input type="checkbox" checked={declared} onChange={(e) => { setDeclared(e.target.checked); setDeclError(false); }} />
                  <span><strong>Donor declaration.</strong> I confirm I am an Australian citizen or resident, or I am giving for an organisation that has an ABN. This is my own money. Counting this gift, I have given Farmers Fightback Votes no more than {money(CAP)} since 15 April 2026.</span>
                </label>
                <p><strong>Donation terms.</strong> Your gift goes to [entity legal name], the election vehicle behind Farmers Fightback Votes. It is a third-party campaigner at the 2026 Victorian state election and is separate from Farmers Fightback and WAGGDA. Your gift pays for campaigning at that election.</p>
                <p>Victorian law caps donations at {money(CAP)} per donor between 15 April and 28 November 2026 and bans foreign donations. If your gifts to us reach $1,290 or more in a financial year, you must disclose them to the Victorian Electoral Commission within 21 days, and so must we.</p>
                <p>Donations are not tax deductible. Donations are final. If you gave by mistake, email {cfg.site.support_email} within 2 working days of your receipt. A gift the law does not let us accept may have to be forfeited to the Victorian Electoral Commission.</p>
                <p>We use your details to meet electoral law and to keep you up to date with the campaign.</p>
              </div>
            </div>
          </form>
        </div>
      </section>
    </Page>
  );
}

// ---------- about ----------
function AboutPage() {
  useTitle("About");
  const cfg = useConfig();
  return (
    <Page>
      <section className="v-sec v-sec--paper">
        <div className="v-wrap v-narrow v-about">
          <div>
            <h1 className="v-h1 v-h1--navy">What Farmers Fightback Votes is</h1>
            <p>Farmers Fightback started at the farm gate. Farming families in the Wimmera and across western Victoria stood up to Labor's transmission lines, the fines, and a government that would not listen.</p>
            <p>Farmers Fightback Votes is the election arm of that fight. It exists for one event: the Victorian state election on Saturday 28 November 2026. It is paid for by farmers and by the Australians who back them. Not a party, not a union, not a corporation.</p>
            <p>It is separate from Farmers Fightback and from the Wallaloo and Gre Gre District Association (WAGGDA).</p>
          </div>
          <div>
            <h2 className="v-h2 v-h2--red">Our goal</h2>
            <p className="v-about-goal">Put Labor last in every electorate in Victoria, and get them out of government.</p>
            <p>Labor has devastated farming families and is now sending the bill to every Victorian household. This election is the only chance to stop it.</p>
            <p>To do that, we will tell every voter what Labor has done, show them exactly how to number their ballot so Labor goes last, and put a how-to-vote card in as many hands as donations allow.</p>
          </div>
          <div className="v-tile v-tile--red v-tile--plain">
            <h2 className="v-tile-h">Authorisation</h2>
            <p className="v-strong">{cfg.site.authorisation}</p>
            <p>Contact: <a href={`mailto:${cfg.site.support_email}`}>{cfg.site.support_email}</a></p>
          </div>
          <div className="v-row">
            <Link to="/seat" className="v-btn v-btn--navy">Find my candidates</Link>
            <Link to="/donate" className="v-btn v-btn--red">Donate</Link>
          </div>
        </div>
      </section>
    </Page>
  );
}

// ---------- app ----------
function App() {
  const [cfg, setCfg] = useState(null); const [err, setErr] = useState(null);
  const [, force] = useState(0);
  useEffect(() => { captureAttribution(); fetch("/config/jurisdictions.json").then((r) => r.json()).then(setCfg).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { const on = () => force((n) => n + 1); window.addEventListener("popstate", on); return () => window.removeEventListener("popstate", on); }, []);
  if (err) return <div style={{ padding: 40 }}>Couldn't load site config: {err}</div>;
  if (!cfg) return null;
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  const seatArgs = { state: (parts[1] || "").toUpperCase(), district: parts[2] ? decodeURIComponent(parts[2]) : "" };
  let view;
  if (path === "/") view = <HomePage />;
  else if (parts[0] === "seat") view = <SeatPage key={path} {...seatArgs} />;
  else if (parts[0] === "card" && seatArgs.district) view = <CardPage {...seatArgs} />;
  else if (parts[0] === "donate") view = <DonatePage />;
  else if (parts[0] === "issues") view = <IssuesPage />;
  else if (parts[0] === "about") view = <AboutPage />;
  else view = <HomePage />;
  return <Config.Provider value={cfg}>{view}</Config.Provider>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
