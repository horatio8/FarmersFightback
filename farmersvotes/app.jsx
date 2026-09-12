/* global React, ReactDOM */
// Farmers Votes front end. One bundle, routed on pathname. Reads
// /config/jurisdictions.json for site copy and the enabled states, and the
// /api endpoints for everything else.
const { useState, useEffect, useMemo, useRef, createContext, useContext } = React;

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
const getGate = () => { try { return JSON.parse(localStorage.getItem("fv_gate") || "null"); } catch { return null; } };
const setGate = (v) => { try { localStorage.setItem("fv_gate", JSON.stringify(v)); } catch {} };
const track = (name, data) => { try { if (window.fbq) window.fbq("track", name, data || {}); } catch {} };

const Config = createContext(null);
const useConfig = () => useContext(Config);
const nav = (to) => { window.history.pushState({}, "", to); window.dispatchEvent(new PopStateEvent("popstate")); window.scrollTo(0, 0); };
const Link = ({ to, className, children, ...rest }) => <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey || rest.target) return; e.preventDefault(); nav(to); }} {...rest}>{children}</a>;

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

// ---------- chrome ----------
function Nav() {
  const cfg = useConfig();
  const [open, setOpen] = useState(false);
  const path = window.location.pathname;
  const links = [["/", "Home"], ["/seat", "Your seat"], ["/parties", "Parties"], ["/quiz", "How to vote"], ["/media", "Media"], ["/shop", "Shop"]];
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <Link to="/" className="brand">Farmers <b>Votes</b><span className="brand-tag">by Farmers Fightback</span></Link>
        <div className="nav-links">{links.map(([to, l]) => <Link key={to} to={to} className={path === to || (to !== "/" && path.startsWith(to)) ? "is-active" : ""}>{l}</Link>)}</div>
        <div className="nav-cta">
          <Link to="/donate" className="btn btn--red">Donate</Link>
          <button className="burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}><span /><span /><span /></button>
        </div>
      </div>
      {open && <div className="mobile-menu">{links.map(([to, l]) => <Link key={to} to={to} onClick={() => setOpen(false)}>{l}</Link>)}</div>}
    </nav>
  );
}
function Footer() {
  const cfg = useConfig();
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div>
          <div className="brand" style={{ color: "#fff" }}>Farmers <b>Votes</b></div>
          <p style={{ maxWidth: 380, marginTop: 10 }}>Where your members and candidates stand on farming, with the evidence. Run by the people behind Farmers Fightback.</p>
        </div>
        <div><h4>Take action</h4><Link to="/seat">Find your seat</Link><Link to="/quiz">How should I vote?</Link><Link to="/donate">Donate</Link><a href="https://www.farmersfightback.com/take-action/hold-the-gate#sign">Sign the petition</a></div>
        <div><h4>More</h4><Link to="/parties">Compare the parties</Link><Link to="/media">Media releases</Link><Link to="/shop">Merch</Link><a href="https://www.farmersfightback.com">farmersfightback.com</a><a href={`mailto:${cfg.site.support_email}`}>Contact</a></div>
      </div>
      <div className="wrap footer-base">
        <span className="auth">{cfg.site.authorisation}</span>
        <span>© {new Date().getFullYear()} Farmers Votes</span>
      </div>
    </footer>
  );
}
function Shell({ children }) { return <><Nav /><main>{children}</main><Footer /></>; }
function DonateBand({ heading, lede }) {
  return (
    <section className="section band"><div className="wrap band-inner">
      <div className="light-text"><span className="eyebrow eyebrow--light">Back the fight</span><h2 className="h2" style={{ marginTop: 10 }}>{heading || "They have the lobbyists. We have you."}</h2><p className="lede">{lede || "Every dollar goes to telling voters the truth about who stands with farmers."}</p></div>
      <Link to="/donate" className="btn btn--red btn--lg">Chip in now ›</Link>
    </div></section>
  );
}

// ---------- lookup ----------
function Lookup({ compact }) {
  const cfg = useConfig();
  const [mode, setMode] = useState("postcode");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const submit = async (e) => {
    e && e.preventDefault(); setErr(""); setResult(null);
    const v = q.trim(); if (!v) return;
    setBusy(true);
    try {
      const u = mode === "postcode" ? `/api/lookup?postcode=${encodeURIComponent(v)}` : `/api/lookup?address=${encodeURIComponent(v)}`;
      const r = await fetch(u); const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Lookup failed");
      if (!j.supported) { setErr(j.reason === "Unknown postcode" ? "We can't find that postcode." : `${j.reason}. We're starting with ${cfg.states[cfg.site.default_jurisdiction].name}.`); return; }
      track("Search", { search_string: mode, content_category: "lookup" });
      if (j.resolved === false) { setResult(j); return; }
      const seat = (j.seats || []).find((s) => s.house === "assembly");
      go(j.state, seat.name, j);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const go = (state, district, j) => {
    const region = ((j.seats || []).find((s) => s.house === "council") || {}).name || (j.options && j.options.council && j.options.council[0]) || "";
    const federal = ((j.seats || []).find((s) => s.house === "reps") || {}).name || "";
    sessionStorage.setItem("fv_last_seat", JSON.stringify({ state, district, region, federal, postcode: mode === "postcode" ? q.trim() : "" }));
    nav(`/seat/${state}/${encodeURIComponent(district)}`);
  };
  return (
    <form className="lookup" onSubmit={submit}>
      {!compact && <><h3 className="h3">Find your seat</h3><p>Your postcode is enough for most people. If it's split across seats, we'll ask you to pick.</p></>}
      <div className="toggle" role="tablist">
        <button type="button" className={mode === "postcode" ? "is-on" : ""} onClick={() => setMode("postcode")}>Postcode</button>
        <button type="button" className={mode === "address" ? "is-on" : ""} onClick={() => setMode("address")}>Street address</button>
      </div>
      <div className="field">
        <label htmlFor="lookup-q">{mode === "postcode" ? "Postcode" : "Address"}</label>
        <input id="lookup-q" inputMode={mode === "postcode" ? "numeric" : "text"} autoComplete={mode === "postcode" ? "postal-code" : "street-address"} placeholder={mode === "postcode" ? "e.g. 3387" : "e.g. 12 Main St, Marnoo VIC"} value={q} onChange={(e) => setQ(e.target.value)} maxLength={mode === "postcode" ? 4 : 120} />
      </div>
      {result && result.resolved === false && (
        <div>
          <p><b>Postcode {result.postcode} covers {result.options.assembly.length} seats.</b> Which is yours?</p>
          <div className="pick">{result.options.assembly.map((o) => <button type="button" key={o.code} onClick={() => go(result.state, o.name, { seats: [{ house: "assembly", name: o.name }], options: result.options })}><span>{o.name}</span><small>{Math.round(o.share * 100)}% of the postcode</small></button>)}</div>
          <p className="hint">Not sure? <button type="button" className="btn btn--outline" style={{ padding: "8px 12px", fontSize: 12 }} onClick={() => { setMode("address"); setResult(null); }}>Use your street address</button></p>
        </div>
      )}
      <button className="btn btn--red btn--lg btn--block" disabled={busy}>{busy ? "Looking up…" : "Show me my seat ›"}</button>
      {err && <p className="error">{err}</p>}
      {!compact && <p className="hint">We don't keep your address. Only the seat.</p>}
    </form>
  );
}

// ---------- capture gate ----------
function Gate({ seat, onDone }) {
  const cfg = useConfig();
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", mobile: "", consent_email: true, consent_sms: false });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const up = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (!f.first_name.trim()) return setErr("Your first name, please.");
    if (!/^\S+@\S+\.\S+$/.test(f.email)) return setErr("Enter a valid email.");
    setBusy(true);
    try {
      const attr = getAttribution();
      const r = await fetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, postcode: seat.postcode, seat_state: seat.district, seat_region: seat.region, seat_federal: seat.federal, jurisdiction: seat.state, source: "Lookup", ref: attr.ref || "", utm: attr }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Something went wrong");
      setGate({ at: Date.now(), referral_code: j.referral_code || null, email: f.email });
      track("Lead", { content_name: "Seat lookup" });
      onDone(j);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <form className="lookup" onSubmit={submit} style={{ maxWidth: 560, margin: "0 auto" }}>
      <span className="eyebrow">One more step</span>
      <h3 className="h3" style={{ marginTop: 8 }}>Your <em>{seat.district}</em> scorecard is ready</h3>
      <p>Tell us who you are and we'll keep you posted on {seat.district} before {cfg.states[seat.state].name} votes.</p>
      <div className="field-row">
        <div className="field"><label>First name</label><input autoComplete="given-name" value={f.first_name} onChange={up("first_name")} /></div>
        <div className="field"><label>Last name</label><input autoComplete="family-name" value={f.last_name} onChange={up("last_name")} /></div>
      </div>
      <div className="field"><label>Email</label><input type="email" autoComplete="email" inputMode="email" value={f.email} onChange={up("email")} /></div>
      <div className="field"><label>Mobile (optional, for a text on election week)</label><input type="tel" autoComplete="tel" inputMode="tel" value={f.mobile} onChange={up("mobile")} placeholder="04…" /></div>
      <label className="check"><input type="checkbox" checked={f.consent_email} onChange={up("consent_email")} /><span>Email me updates from Farmers Votes and Farmers Fightback. Unsubscribe any time.</span></label>
      <label className="check"><input type="checkbox" checked={f.consent_sms} onChange={up("consent_sms")} /><span>Text me too.</span></label>
      <button className="btn btn--red btn--lg btn--block" disabled={busy}>{busy ? "One sec…" : "Show my scorecard ›"}</button>
      {err && <p className="error">{err}</p>}
      <p className="hint">We keep your details under the Privacy Act and never sell them.</p>
    </form>
  );
}

// ---------- scorecard ----------
const Dot = ({ r }) => <span className={`dot ${r}`} aria-label={r} />;
function MemberCard({ m, issues }) {
  return (
    <article className="card">
      <div className={`card-top rating-${m.overall}`}>
        <div className="card-name">{m.name}</div>
        <div className="card-party">{m.party}{m.incumbent && <span className="badge badge--mp">Sitting MP</span>}{m.retiring && <span className="badge badge--retiring">Retiring</span>}{m.ticket_position && <span className="badge">#{m.ticket_position} on ticket</span>}</div>
      </div>
      <div className="lights">
        {issues.map((i) => { const r = m.ratings[i.slug] || { rating: "Unknown" }; return (
          <div className="light" key={i.slug}><Dot r={r.rating} /><span className="light-label">{i.title}</span>
            {r.sources && r.sources[0] ? <a className="light-src" href={r.sources[0]} target="_blank" rel="noopener noreferrer">source ↗</a> : <span className="light-src">{r.method === "Party position" ? "party position" : r.rating === "Unknown" ? "hasn't told us" : ""}</span>}
          </div>); })}
      </div>
      <div className="card-foot"><span className="overall"><Dot r={m.overall} /> Overall: {m.overall === "Unknown" ? "no position yet" : m.overall}</span></div>
    </article>
  );
}
function SeatPage({ state, district }) {
  const cfg = useConfig();
  const last = (() => { try { return JSON.parse(sessionStorage.getItem("fv_last_seat") || "null"); } catch { return null; } })() || {};
  const [gated, setGated] = useState(!!getGate());
  const { loading, data, error } = useFetch(state && district ? `/api/seat?state=${state}&district=${encodeURIComponent(district)}` : null, [state, district]);
  useEffect(() => { if (data) track("ViewContent", { content_name: `Seat ${data.seat.name}`, content_category: "scorecard" }); }, [data]);
  if (!state || !district) return <Shell><section className="section"><div className="wrap" style={{ maxWidth: 560 }}><span className="eyebrow">Your seat</span><h1 className="h2" style={{ margin: "10px 0 18px" }}>Who represents <em>you</em>?</h1><Lookup /></div></section></Shell>;
  if (error) return <Shell><section className="section"><div className="wrap"><h1 className="h2">We couldn't load that seat.</h1><p className="lede">{error}</p><Link to="/seat" className="btn btn--outline" style={{ marginTop: 16 }}>Try another lookup</Link></div></section></Shell>;
  if (loading || !data) return <Shell><section className="section"><div className="wrap"><div className="skel" style={{ height: 40, width: 320, marginBottom: 20 }} /><div className="cards">{[1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 300 }} />)}</div></div></section></Shell>;
  const seatInfo = { state, district: data.seat.name, region: data.region && data.region.name, federal: last.federal || "", postcode: last.postcode || "" };
  const days = data.election && data.election.date ? Math.max(0, Math.ceil((new Date(data.election.date) - Date.now()) / 86400000)) : null;
  const gate = getGate();
  const share = `${window.location.origin}/seat/${state}/${encodeURIComponent(data.seat.name)}${gate && gate.referral_code ? `?ref=${gate.referral_code}` : ""}`;
  return (
    <Shell>
      <section className="seat-head"><div className="wrap">
        <span className="eyebrow">{data.state_name} · {data.seat.house}</span>
        <h1 className="h1" style={{ marginTop: 8 }}>{data.seat.name}</h1>
        <div className="seat-meta">
          {data.region && <span>Upper house: <b>{data.region.name}</b> ({data.region.members} members)</span>}
          {days !== null && <span>Election: <b>{new Date(data.election.date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</b>, {days} days away</span>}
          <span><Link to="/seat" style={{ textDecoration: "underline" }}>Not your seat?</Link></span>
        </div>
      </div></section>
      {!gated ? (
        <section className="section" style={{ background: "var(--paper-2)" }}><div className="wrap"><Gate seat={seatInfo} onDone={() => setGated(true)} /></div></section>
      ) : (
        <>
          <section className="section"><div className="wrap">
            <span className="eyebrow">Lower house · {data.seat.house}</span>
            <h2 className="h2" style={{ margin: "10px 0 6px" }}>Candidates for <em>{data.seat.name}</em></h2>
            {!data.ratings_live && <p className="notice" style={{ margin: "12px 0 6px" }}>Ratings are being researched. Grey means we haven't published a position yet. Every light will carry its source.</p>}
            <div className="legend"><span><Dot r="Green" /> Backs farmers</span><span><Dot r="Amber" /> Mixed</span><span><Dot r="Red" /> Against farmers</span><span><Dot r="Unknown" /> No position yet</span></div>
            {data.lower.length ? <div className="cards">{data.lower.map((m) => <MemberCard key={m.member_id} m={m} issues={data.issues} />)}</div> : <p className="lede">No candidates announced yet for this seat.</p>}
          </div></section>
          {data.region && (
            <section className="section" style={{ paddingTop: 0 }}><div className="wrap">
              <span className="eyebrow">Upper house · {data.region.house}</span>
              <h2 className="h2" style={{ margin: "10px 0 16px" }}>{data.region.name} region</h2>
              <p className="lede" style={{ marginBottom: 18 }}>You also elect {data.region.members} members here. Tickets are listed in the order parties put them forward.</p>
              {data.upper.length ? <div className="cards">{data.upper.map((m) => <MemberCard key={m.member_id} m={m} issues={data.issues} />)}</div> : <p className="lede">No tickets announced yet.</p>}
            </div></section>
          )}
          <section className="section" style={{ paddingTop: 0 }}><div className="wrap"><div className="step" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
            <div><b style={{ fontSize: 22, display: "inline" }}>Share this scorecard.</b><div style={{ color: "var(--ink-2)", marginTop: 4 }}>Every neighbour who sees it is a vote that counts.</div></div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a className="btn btn--outline" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer" onClick={() => track("Share", { content_name: data.seat.name })}>Facebook</a>
              <a className="btn btn--outline" href={`sms:?&body=${encodeURIComponent(`Where do our ${data.seat.name} candidates stand on farming? ${share}`)}`}>Text it</a>
              <button className="btn btn--outline" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(share); }}>Copy link</button>
            </div>
          </div></div></section>
          <DonateBand heading={`Help us reach every voter in ${data.seat.name}`} lede="Ads in this seat cost money. Your donation puts this scorecard in front of your neighbours." />
        </>
      )}
    </Shell>
  );
}

// ---------- parties ----------
function PartiesPage() {
  const cfg = useConfig();
  const { loading, data, error } = useFetch(`/api/parties?state=${cfg.site.default_jurisdiction}`, []);
  const Grid = ({ rows, issues }) => (
    <div className="grid-wrap"><table className="grid"><thead><tr><th>Issue</th>{rows.map((r) => <th key={r.party} style={{ textAlign: "center" }}>{r.party}</th>)}</tr></thead>
      <tbody>{issues.map((i) => <tr key={i.slug}><td>{i.title}</td>{rows.map((r) => { const x = r.ratings[i.slug]; return <td className="c" key={r.party}>{x.sources[0] ? <a href={x.sources[0]} target="_blank" rel="noopener noreferrer"><Dot r={x.rating} /></a> : <Dot r={x.rating} />}</td>; })}</tr>)}</tbody></table></div>
  );
  return (
    <Shell>
      <section className="section"><div className="wrap">
        <span className="eyebrow">Compare the parties</span>
        <h1 className="h2" style={{ margin: "10px 0 10px" }}>Where each party <em>really</em> stands</h1>
        <p className="lede" style={{ marginBottom: 20 }}>Positions come from voting records, platforms and what they told us in our survey. Tap a light for the source.</p>
        {loading && <div className="skel" style={{ height: 320 }} />}
        {error && <p className="error">{error}</p>}
        {data && <>
          {!data.live && <p className="notice" style={{ marginBottom: 14 }}>Placeholder issues. Real positions publish as the research is signed off.</p>}
          <div className="legend"><span><Dot r="Green" /> Backs farmers</span><span><Dot r="Amber" /> Mixed</span><span><Dot r="Red" /> Against</span><span><Dot r="Unknown" /> No position</span></div>
          <Grid rows={data.majors} issues={data.issues} />
          {data.others.length > 0 && <details className="more"><summary>Other parties and independents ({data.others.length})</summary><Grid rows={data.others} issues={data.issues} /></details>}
        </>}
      </div></section>
      <DonateBand />
    </Shell>
  );
}

// ---------- media ----------
function MediaPage({ slug }) {
  const { loading, data, error } = useFetch("/api/releases", []);
  const items = (data && data.items) || [];
  const one = slug ? items.find((i) => i.slug === slug) : null;
  return (
    <Shell><section className="section"><div className="wrap" style={{ maxWidth: 820 }}>
      <span className="eyebrow">Media</span>
      {one ? (<article><time>{new Date(one.date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })} · {one.type}</time><h1 className="h2" style={{ margin: "8px 0 18px" }}>{one.title}</h1><div className="lede" style={{ maxWidth: "none", whiteSpace: "pre-wrap" }}>{one.body || one.summary}</div>{one.attachments.map((a) => <p key={a.url}><a href={a.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>{a.name}</a></p>)}<p style={{ marginTop: 24 }}><Link to="/media" style={{ textDecoration: "underline" }}>← All media releases</Link></p></article>) : (<>
        <h1 className="h2" style={{ margin: "10px 0 18px" }}>Media releases</h1>
        {loading && <div className="skel" style={{ height: 200 }} />}
        {error && <p className="error">{error}</p>}
        {data && !items.length && <p className="lede">Nothing published yet. Media enquiries: <a href="mailto:support@farmersfightback.com" style={{ textDecoration: "underline" }}>support@farmersfightback.com</a>.</p>}
        <div className="releases">{items.map((i) => <div className="release" key={i.slug}><time>{new Date(i.date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })} · {i.type}</time><h3 className="h3"><Link to={`/media/${i.slug}`}>{i.title}</Link></h3><p>{i.summary}</p></div>)}</div>
      </>)}
    </div></section></Shell>
  );
}

// ---------- donate (UI ready; checkout wires to Stripe when keys land) ----------
const AMOUNTS = { oneoff: [25, 50, 100, 250, 500, 1000], monthly: [10, 20, 35, 50, 100, 200] };
function DonatePage() {
  const cfg = useConfig();
  const [freq, setFreq] = useState("oneoff"); const [amt, setAmt] = useState(100); const [other, setOther] = useState("");
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", mobile: "", address: "", terms: false, citizen: false, own_funds: false });
  const up = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const value = other ? Number(other) : amt;
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (!(value > 0)) return setErr("Pick an amount.");
    if (!f.first_name || !f.last_name || !/^\S+@\S+\.\S+$/.test(f.email) || !f.address.trim()) return setErr("We need your name, email and residential address. Electoral law requires it for donations.");
    if (!f.terms || !f.citizen || !f.own_funds) return setErr("Please tick all three declarations.");
    setBusy(true);
    try {
      const r = await fetch("/api/donate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: value, frequency: freq, ...f, attribution: getAttribution() }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) { setErr("Donations open at launch. Thanks for being early."); return; }
      if (!r.ok || !j.url) throw new Error(j.error || "Could not start checkout");
      track("InitiateCheckout", { value, currency: "AUD" });
      window.location.href = j.url;
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Shell>
      <section className="hero"><div className="wrap hero-grid">
        <div className="light-text"><span className="eyebrow eyebrow--light">Donate</span><h1 className="h1" style={{ margin: "10px 0 14px" }}>They have billions. <em>We have you.</em></h1><p className="lede">Every dollar tells more voters where their candidates stand. No consultants, no waste. Just the truth, in every seat that matters.</p></div>
        <form className="lookup" onSubmit={submit}>
          <div className="toggle"><button type="button" className={freq === "oneoff" ? "is-on" : ""} onClick={() => setFreq("oneoff")}>One-off</button><button type="button" className={freq === "monthly" ? "is-on" : ""} onClick={() => setFreq("monthly")}>Monthly</button></div>
          <div className="pick" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>{AMOUNTS[freq].map((a) => <button type="button" key={a} onClick={() => { setAmt(a); setOther(""); }} style={{ justifyContent: "center", fontWeight: 700, fontSize: 18, borderColor: !other && amt === a ? "var(--red)" : undefined, background: !other && amt === a ? "#fff5f5" : undefined }}>${a}</button>)}</div>
          <div className="field"><label>Other amount</label><input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value.replace(/[^\d.]/g, ""))} placeholder="$" /></div>
          <div className="field-row"><div className="field"><label>First name</label><input value={f.first_name} onChange={up("first_name")} autoComplete="given-name" /></div><div className="field"><label>Last name</label><input value={f.last_name} onChange={up("last_name")} autoComplete="family-name" /></div></div>
          <div className="field"><label>Email</label><input type="email" value={f.email} onChange={up("email")} autoComplete="email" /></div>
          <div className="field"><label>Mobile</label><input type="tel" value={f.mobile} onChange={up("mobile")} autoComplete="tel" /></div>
          <div className="field"><label>Residential address (required by electoral law)</label><input value={f.address} onChange={up("address")} autoComplete="street-address" /></div>
          <label className="check"><input type="checkbox" checked={f.citizen} onChange={up("citizen")} /><span>I am an Australian citizen or permanent resident, or an Australian entity.</span></label>
          <label className="check"><input type="checkbox" checked={f.own_funds} onChange={up("own_funds")} /><span>This donation is from my own funds and not on behalf of anyone else.</span></label>
          <label className="check"><input type="checkbox" checked={f.terms} onChange={up("terms")} /><span>I accept the <Link to="/about" style={{ textDecoration: "underline" }}>donation terms</Link> and understand my details may be disclosed to the electoral commission as required by law.</span></label>
          <button className="btn btn--red btn--lg btn--block" disabled={busy}>{busy ? "One moment…" : `Donate $${value || 0}${freq === "monthly" ? " a month" : ""} ›`}</button>
          {err && <p className="error">{err}</p>}
          <p className="hint">Secure payment by Stripe. {cfg.site.authorisation}.</p>
        </form>
      </div></section>
    </Shell>
  );
}

// ---------- simple pages ----------
function QuizPage() {
  return (<Shell><section className="section"><div className="wrap" style={{ maxWidth: 720 }}><span className="eyebrow">How should I vote?</span><h1 className="h2" style={{ margin: "10px 0 12px" }}>Rank what matters to <em>you</em>. We'll show who backs it.</h1><p className="lede">Twenty seconds: drag five issues into order and we match you to the candidates in your seat. Opening shortly, once the ratings are in.</p><div style={{ marginTop: 22 }}><Link to="/seat" className="btn btn--red btn--lg">Find my seat first ›</Link></div></div></section><DonateBand /></Shell>);
}
function ShopPage() {
  return (<Shell><section className="section"><div className="wrap" style={{ maxWidth: 720 }}><span className="eyebrow">Merch</span><h1 className="h2" style={{ margin: "10px 0 12px" }}>Wear the <em>Fightback</em></h1><p className="lede">Tees, quarter zips, crews, caps and beanies. Same gear, same store.</p><div style={{ marginTop: 22 }}><a className="btn btn--red btn--lg" href="https://shop.farmersfightback.com/?utm_source=farmersvotes&utm_medium=website&utm_campaign=shop" rel="noopener">Open the shop ›</a></div></div></section></Shell>);
}
function AboutPage() {
  const cfg = useConfig();
  return (<Shell><section className="section"><div className="wrap" style={{ maxWidth: 760 }}><span className="eyebrow">About</span><h1 className="h2" style={{ margin: "10px 0 12px" }}>Who we are</h1><p className="lede">Farmers Votes is run by the people behind Farmers Fightback. We rate members and candidates on the issues that decide whether farming families survive, and we show our sources. Donation terms, privacy and the full policy method will be published here before launch.</p><p className="lede" style={{ marginTop: 14 }}>{cfg.site.authorisation}. Contact: <a href={`mailto:${cfg.site.support_email}`} style={{ textDecoration: "underline" }}>{cfg.site.support_email}</a>.</p></div></section></Shell>);
}
function HomePage() {
  const cfg = useConfig();
  const st = cfg.states[cfg.site.default_jurisdiction];
  const days = st.election && st.election.date ? Math.max(0, Math.ceil((new Date(st.election.date) - Date.now()) / 86400000)) : null;
  const rel = useFetch("/api/releases?limit=3", []);
  return (
    <Shell>
      <section className="hero"><div className="wrap hero-grid">
        <div className="light-text">
          <span className="eyebrow eyebrow--light">{st.name} votes {days !== null ? `in ${days} days` : "soon"}</span>
          <h1 className="h1" style={{ margin: "12px 0 16px" }}>Where does <em>your</em> MP stand on farming?</h1>
          <p className="lede">Enter your postcode. See how every candidate in your seat rates on the issues that decide whether farming families survive, with the evidence.</p>
        </div>
        <Lookup />
      </div></section>
      <section className="section"><div className="wrap">
        <span className="eyebrow">How it works</span>
        <h2 className="h2" style={{ marginTop: 10 }}>Three steps. Twenty seconds.</h2>
        <div className="steps">
          <div className="step"><b>1</b><h3 className="h3">Find your seat</h3><p>Postcode or address. We work out your lower and upper house seats.</p></div>
          <div className="step"><b>2</b><h3 className="h3">See the scorecard</h3><p>Every candidate, traffic-light rated on each issue, sources one tap away.</p></div>
          <div className="step"><b>3</b><h3 className="h3">Vote for the bush</h3><p>Rank your issues and we'll tell you who to put first. Then share it.</p></div>
        </div>
      </div></section>
      <section className="section" style={{ paddingTop: 0 }}><div className="wrap band-inner"><div><span className="eyebrow">The parties</span><h2 className="h2" style={{ marginTop: 10 }}>Labor, Liberal, National, Greens, One Nation, side by side</h2></div><Link to="/parties" className="btn btn--outline btn--lg">Compare the parties ›</Link></div></section>
      <DonateBand />
      {rel.data && rel.data.items.length > 0 && <section className="section"><div className="wrap"><span className="eyebrow">Latest</span><h2 className="h2" style={{ margin: "10px 0 18px" }}>Media releases</h2><div className="releases">{rel.data.items.map((i) => <div className="release" key={i.slug}><time>{new Date(i.date).toLocaleDateString("en-AU", { day: "numeric", month: "long" })}</time><h3 className="h3"><Link to={`/media/${i.slug}`}>{i.title}</Link></h3><p>{i.summary}</p></div>)}</div></div></section>}
    </Shell>
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
  let view;
  if (path === "/") view = <HomePage />;
  else if (parts[0] === "seat") view = <SeatPage state={(parts[1] || "").toUpperCase()} district={parts[2] ? decodeURIComponent(parts[2]) : ""} />;
  else if (parts[0] === "parties") view = <PartiesPage />;
  else if (parts[0] === "media") view = <MediaPage slug={parts[1] ? decodeURIComponent(parts[1]) : ""} />;
  else if (parts[0] === "donate") view = <DonatePage />;
  else if (parts[0] === "quiz") view = <QuizPage />;
  else if (parts[0] === "shop") view = <ShopPage />;
  else if (parts[0] === "about") view = <AboutPage />;
  else view = <HomePage />;
  return <Config.Provider value={cfg}>{view}</Config.Provider>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
