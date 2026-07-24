/* global React, ReactDOM */
// Gatepost survey engine (client). Typeform-style, one question per screen,
// auto-advance, save-per-answer, resume, tiers, skip_if_known, option piping,
// server-driven ask router. All brand tokens come from the bootstrap payload.

const { useState, useEffect, useRef, useCallback } = React;

// ---- URL context --------------------------------------------------------
function urlContext() {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/s\/([A-Za-z0-9_-]+)/);
  const slug = (m && m[1]) || "supporters";
  const q = new URLSearchParams(location.search);
  return { slug, uid: q.get("uid") || "", src: q.get("src") || "", c: q.get("c") || "" };
}

function interp(str, vars) {
  return String(str || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null && vars[k] !== "" ? vars[k] : ""));
}
function titleCaseName(s) {
  s = String(s || "").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.data = data; throw e; }
  return data;
}

// ---- Flow helpers -------------------------------------------------------
function fieldById(survey, id) {
  const s = (survey.screens || []).find((x) => x.id === id);
  return s ? s.field : null;
}
function isKnown(known, key) {
  return key && known && known[key] != null && String(known[key]).trim() !== "";
}
function buildFlow(survey, known) {
  const core = [], ext = [];
  let gate = null;
  for (const s of survey.screens || []) {
    if (s.skip_if_known && isKnown(known, s.skip_if_known)) continue;
    if (s.tier === "core") core.push(s);
    else if (s.tier === "interstitial") gate = s;
    else if (s.tier === "extension") ext.push(s);
  }
  return { core, gate, ext };
}

// ================= root ==================================================
function App() {
  const ctx = useRef(urlContext()).current;
  const [phase, setPhase] = useState("loading"); // loading|capture|run|ask|error
  const [boot, setBoot] = useState(null);
  const [answers, setAnswers] = useState({});
  const [known, setKnown] = useState({});
  const [flow, setFlow] = useState({ core: [], gate: null, ext: [] });
  const [extOptIn, setExtOptIn] = useState(false);
  const [pos, setPos] = useState({ stage: "core", i: 0 }); // stage: core|gate|ext
  const [ask, setAsk] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const responseId = useRef(null);

  // ---- bootstrap --------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const b = await postJson("/api/survey/resolve", { slug: ctx.slug, uid: ctx.uid, src: ctx.src, c: ctx.c });
        applyBrand(b.brand);
        if (b.needs_capture) { setBoot(b); setPhase("capture"); return; }
        startFrom(b);
      } catch (e) {
        setErrMsg("We couldn't load the survey just now. Please try again shortly.");
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startFrom(b) {
    responseId.current = b.response_id;
    const kn = (b.contact && b.contact.known) || {};
    const seeded = { ...(b.answered || {}) };
    if (kn.postcode && !seeded.postcode) seeded.postcode = kn.postcode; // skipped-but-known
    setBoot(b); setKnown(kn); setAnswers(seeded);
    const fl = buildFlow(b.survey, kn);
    setFlow(fl);

    if (b.status === "complete") { finish(b.survey, seeded); return; }

    // Fresh visit (no saved answers): start at the top so the welcome shows.
    // Genuine resume (has saved answers): jump to the first unanswered question,
    // treating leading statements as already seen.
    const answeredCount = Object.keys(b.answered || {}).length;
    if (answeredCount === 0) {
      setPos({ stage: "core", i: 0 });
      setPhase("run");
      return;
    }
    const anyExt = fl.ext.some((s) => hasAns(seeded, s));
    if (anyExt) {
      setExtOptIn(true);
      const idx = fl.ext.findIndex((s) => !hasAns(seeded, s));
      if (idx < 0) { finish(b.survey, seeded); return; }
      setPos({ stage: "ext", i: idx });
    } else {
      const idx = fl.core.findIndex((s) => !hasAns(seeded, s));
      if (idx < 0) setPos({ stage: fl.gate ? "gate" : "core", i: fl.gate ? 0 : fl.core.length });
      else setPos({ stage: "core", i: idx });
    }
    setPhase("run");
  }

  function hasAns(a, screen) {
    if (!screen || !screen.field) return true; // statements count as satisfied
    const v = a[screen.field];
    return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
  }

  // ---- persistence ------------------------------------------------------
  const saveAnswer = useCallback((next) => {
    if (!responseId.current) return;
    postJson("/api/survey/answer", { response_id: responseId.current, slug: ctx.slug, answers: next })
      .catch((e) => console.error("save:", e.message));
  }, [ctx.slug]);

  async function finish(survey, finalAnswers) {
    setPhase("loading");
    try {
      const r = await postJson("/api/survey/complete", {
        response_id: responseId.current, slug: ctx.slug, answers: finalAnswers,
      });
      setAsk(r.ask); setPhase("ask");
      window.scrollTo(0, 0);
    } catch (e) {
      // Even if completion errors, answers are saved; show a graceful end.
      setAsk(null); setPhase("ask");
    }
  }

  // ---- navigation -------------------------------------------------------
  const vars = { first_name: titleCaseName((boot && boot.contact && boot.contact.name) || known.first_name || "") };

  function commit(screen, value, advance) {
    // Statements/interstitials carry no field — just advance, never persist a
    // bogus column (an "undefined" key would 422 the Airtable write).
    if (screen.field) {
      const next = { ...answers, [screen.field]: value };
      setAnswers(next);
      saveAnswer(next);
    }
    if (advance) setTimeout(() => goNext(), screen.field ? 170 : 0);
  }

  function goNext() {
    setPos((p) => {
      if (p.stage === "core") {
        if (p.i + 1 < flow.core.length) return { stage: "core", i: p.i + 1 };
        return flow.gate ? { stage: "gate", i: 0 } : endStage();
      }
      if (p.stage === "gate") {
        // decided via gate buttons; goNext only called on "go on"
        if (flow.ext.length) return { stage: "ext", i: 0 };
        return endStage();
      }
      if (p.stage === "ext") {
        if (p.i + 1 < flow.ext.length) return { stage: "ext", i: p.i + 1 };
        return endStage();
      }
      return p;
    });
  }
  function endStage() { queueFinish(); return { stage: "done", i: 0 }; }
  const finishQueued = useRef(false);
  function queueFinish() {
    if (finishQueued.current) return; finishQueued.current = true;
    setTimeout(() => finish(boot.survey, answersRef.current), 0);
  }
  // keep a live ref of answers for the deferred finish
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; }, [answers]);

  function onGate(optIn) {
    setExtOptIn(optIn);
    if (optIn && flow.ext.length) setPos({ stage: "ext", i: 0 });
    else queueFinish(), setPos({ stage: "done", i: 0 });
  }

  // ---- render -----------------------------------------------------------
  if (phase === "loading") return <Loading />;
  if (phase === "error") return <ErrorView msg={errMsg} />;
  if (phase === "capture") return <Capture boot={boot} ctx={ctx} onDone={startFrom} />;
  if (phase === "ask") return <AskScreen boot={boot} ask={ask} vars={vars} />;

  // run
  let screen = null, total = flow.core.length + (flow.gate ? 1 : 0) + (extOptIn ? flow.ext.length : 0), done = 0;
  if (pos.stage === "core") { screen = flow.core[pos.i]; done = pos.i; }
  else if (pos.stage === "gate") { screen = flow.gate; done = flow.core.length; }
  else if (pos.stage === "ext") { screen = flow.ext[pos.i]; done = flow.core.length + (flow.gate ? 1 : 0) + pos.i; }
  if (!screen) return <Loading />;

  const progress = total > 0 ? Math.min(0.99, done / total) : 0;

  return (
    <div className="sv-shell">
      <div className="sv-bar"><div className="sv-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <div className="sv-stage">
        <Screen
          key={screen.id}
          screen={screen}
          survey={boot.survey}
          answers={answers}
          vars={vars}
          onCommit={commit}
          onGate={onGate}
        />
      </div>
      <Foot copy={boot.copy} />
    </div>
  );
}

// ================= screen renderer =======================================
function Screen({ screen, survey, answers, vars, onCommit, onGate }) {
  const t = screen.type;
  if (t === "statement" && screen.extension_gate) return <GateScreen screen={screen} vars={vars} onGate={onGate} />;
  if (t === "statement") return <StatementScreen screen={screen} vars={vars} onNext={() => onCommit(screen, "__seen__", true)} />;
  if (t === "single_select") return <SingleSelect screen={screen} answers={answers} vars={vars} onCommit={onCommit} />;
  if (t === "multi_select") return <MultiSelect screen={screen} survey={survey} answers={answers} vars={vars} onCommit={onCommit} />;
  if (t === "scale_1_5") return <ScaleSelect screen={screen} answers={answers} vars={vars} onCommit={onCommit} />;
  if (t === "postcode") return <PostcodeInput screen={screen} answers={answers} vars={vars} onCommit={onCommit} />;
  if (t === "phone_optin") return <PhoneOptin screen={screen} vars={vars} onCommit={onCommit} />;
  if (t === "email" || t === "short_text") return <TextInput screen={screen} answers={answers} vars={vars} onCommit={onCommit} type={t} />;
  return <StatementScreen screen={{ headline: screen.question || "Thanks" }} vars={vars} onNext={() => onCommit(screen, "__seen__", true)} />;
}

function Q({ screen, vars }) {
  return (
    <div className="sv-q">
      <h1 className="sv-h">{interp(screen.question || screen.headline, vars)}</h1>
      {screen.help ? <p className="sv-help">{screen.help}</p> : null}
    </div>
  );
}

function StatementScreen({ screen, vars, onNext }) {
  return (
    <div className="sv-q sv-center">
      <h1 className="sv-h sv-h-big">{interp(screen.headline, vars)}</h1>
      {screen.body ? <p className="sv-lead">{interp(screen.body, vars)}</p> : null}
      <button className="sv-btn" onClick={onNext}>{screen.button || "Continue"} <Arrow /></button>
    </div>
  );
}

function GateScreen({ screen, vars, onGate }) {
  return (
    <div className="sv-q sv-center">
      <h1 className="sv-h sv-h-big">{interp(screen.headline, vars)}</h1>
      {screen.body ? <p className="sv-lead">{interp(screen.body, vars)}</p> : null}
      <button className="sv-btn" onClick={() => onGate(true)}>{screen.button || "Go on"} <Arrow /></button>
      <button className="sv-link" onClick={() => onGate(false)}>{screen.skip_button || "Skip to the end"}</button>
    </div>
  );
}

function SingleSelect({ screen, answers, vars, onCommit }) {
  const [picked, setPicked] = useState(null);
  const cur = answers[screen.field];
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <div className="sv-opts">
        {screen.options.map((o) => {
          const active = picked === o.value || (picked == null && cur === o.value);
          return (
            <button key={o.value} className={"sv-opt" + (active ? " is-pick" : "")}
              onClick={() => { setPicked(o.value); onCommit(screen, o.value, true); }}>
              <span className="sv-opt-label">{o.label}</span>
              <span className="sv-opt-tick"><Check /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MultiSelect({ screen, survey, answers, vars, onCommit }) {
  const initial = Array.isArray(answers[screen.field]) ? answers[screen.field]
    : (answers[screen.field] ? String(answers[screen.field]).split(", ") : []);
  const [sel, setSel] = useState(initial);
  // option piping
  let options = screen.options;
  if (screen.pipe_from) {
    const srcField = fieldById(survey, screen.pipe_from);
    const chosen = srcField ? answers[srcField] : null;
    if (chosen) options = options.filter((o) => o.value !== chosen);
  }
  function toggle(v) {
    setSel((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);
  }
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <div className="sv-opts">
        {options.map((o) => {
          const active = sel.includes(o.value);
          return (
            <button key={o.value} className={"sv-opt" + (active ? " is-pick" : "")} onClick={() => toggle(o.value)}>
              <span className="sv-opt-label">{o.label}</span>
              <span className="sv-opt-box">{active ? <Check /> : null}</span>
            </button>
          );
        })}
      </div>
      <button className="sv-btn sv-btn-next" disabled={sel.length === 0} onClick={() => onCommit(screen, sel, true)}>
        {sel.length ? "Next" : "Pick at least one"} <Arrow />
      </button>
    </div>
  );
}

function ScaleSelect({ screen, answers, vars, onCommit }) {
  const [picked, setPicked] = useState(null);
  const cur = answers[screen.field];
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <div className="sv-scale">
        {[1, 2, 3, 4, 5].map((n) => {
          const active = picked === n || (picked == null && Number(cur) === n);
          return (
            <button key={n} className={"sv-scale-btn" + (active ? " is-pick" : "")}
              onClick={() => { setPicked(n); onCommit(screen, n, true); }}>{n}</button>
          );
        })}
      </div>
      <div className="sv-scale-labels"><span>{screen.low_label}</span><span>{screen.high_label}</span></div>
    </div>
  );
}

function PostcodeInput({ screen, answers, vars, onCommit }) {
  const [val, setVal] = useState(String(answers[screen.field] || ""));
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  function onChange(e) {
    const d = e.target.value.replace(/\D/g, "").slice(0, 4);
    setVal(d);
    if (d.length === 4) setTimeout(() => onCommit(screen, d, true), 120);
  }
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <input ref={ref} className="sv-input sv-input-code" inputMode="numeric" pattern="[0-9]*"
        placeholder="3000" value={val} onChange={onChange}
        onKeyDown={(e) => { if (e.key === "Enter" && val.length === 4) onCommit(screen, val, true); }} />
      {val.length > 0 && val.length < 4 ? null : null}
      <button className="sv-btn sv-btn-next" disabled={val.length !== 4} onClick={() => onCommit(screen, val, true)}>Next <Arrow /></button>
    </div>
  );
}

function PhoneOptin({ screen, vars, onCommit }) {
  const [mode, setMode] = useState("choose"); // choose|number
  const [num, setNum] = useState("");
  const ref = useRef(null);
  useEffect(() => { if (mode === "number" && ref.current) ref.current.focus(); }, [mode]);
  const valid = num.replace(/\D/g, "").length >= 8;
  return (
    <div>
      <Q screen={screen} vars={vars} />
      {mode === "choose" ? (
        <div className="sv-opts">
          <button className="sv-opt" onClick={() => setMode("number")}>
            <span className="sv-opt-label">{screen.yesLabel || "Yes, text me"}</span><span className="sv-opt-tick"><Check /></span>
          </button>
          <button className="sv-opt" onClick={() => onCommit(screen, "no", true)}>
            <span className="sv-opt-label">{screen.noLabel || "No thanks"}</span>
          </button>
        </div>
      ) : (
        <div>
          <input ref={ref} className="sv-input" inputMode="tel" type="tel" placeholder="04xx xxx xxx"
            value={num} onChange={(e) => setNum(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid) onCommit(screen, "yes:" + num, true); }} />
          <button className="sv-btn sv-btn-next" disabled={!valid} onClick={() => onCommit(screen, "yes:" + num, true)}>
            Save my number <Arrow />
          </button>
        </div>
      )}
    </div>
  );
}

function TextInput({ screen, answers, vars, onCommit, type }) {
  const [val, setVal] = useState(String(answers[screen.field] || ""));
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  const ok = type === "email" ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val.trim()) : val.trim().length > 0;
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <input ref={ref} className="sv-input" type={type === "email" ? "email" : "text"}
        value={val} onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && ok) onCommit(screen, val.trim(), true); }} />
      <button className="sv-btn sv-btn-next" disabled={!ok} onClick={() => onCommit(screen, val.trim(), true)}>Next <Arrow /></button>
    </div>
  );
}

// ================= contact capture (fallback) ============================
function Capture({ boot, ctx, onDone }) {
  const [first, setFirst] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const cap = boot.capture || {};
  const ok = first.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  async function submit() {
    if (!ok || busy) return; setBusy(true); setErr("");
    try {
      const b = await postJson("/api/survey/capture", {
        slug: ctx.slug, first_name: first.trim(), email: email.trim(), mobile: mobile.trim(), src: ctx.src, c: ctx.c,
      });
      onDone(b);
    } catch (e) { setErr(e.data && e.data.error ? e.data.error : "Something went wrong. Please try again."); setBusy(false); }
  }
  return (
    <div className="sv-shell">
      <div className="sv-bar"><div className="sv-bar-fill" style={{ width: "4%" }} /></div>
      <div className="sv-stage">
        <div className="sv-q">
          <h1 className="sv-h">Let's get you started.</h1>
          <p className="sv-help">{cap.intro || "So we can save your answers, tell us who you are."}</p>
          <div className="sv-form">
            <input className="sv-input" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
            <input className="sv-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="sv-input" type="tel" inputMode="tel" placeholder="Mobile (optional)" value={mobile} onChange={(e) => setMobile(e.target.value)} />
          </div>
          {err ? <p className="sv-err">{err}</p> : null}
          <button className="sv-btn sv-btn-next" disabled={!ok || busy} onClick={submit}>{busy ? "Saving..." : "Start"} <Arrow /></button>
          {cap.privacy_line ? (
            <p className="sv-fine">{cap.privacy_line}{cap.privacy_url ? <> <a href={cap.privacy_url} target="_blank" rel="noopener">Privacy</a>.</> : null}</p>
          ) : null}
        </div>
      </div>
      <Foot copy={boot.copy} />
    </div>
  );
}

// ================= ask screen ============================================
function AskScreen({ boot, ask, vars }) {
  if (!ask) {
    return (
      <div className="sv-shell"><div className="sv-stage"><div className="sv-q sv-center">
        <h1 className="sv-h sv-h-big">Thank you.</h1>
        <p className="sv-lead">Your answers are in. We'll be in touch.</p>
      </div></div><Foot copy={boot.copy} /></div>
    );
  }
  const isLadder = ask.style && ask.style.indexOf("ladder") === 0;
  return (
    <div className="sv-shell">
      <div className="sv-bar"><div className="sv-bar-fill" style={{ width: "100%" }} /></div>
      <div className="sv-stage">
        <div className="sv-q sv-center">
          {ask.framing ? <h1 className="sv-h sv-h-big">{ask.framing}</h1> : <h1 className="sv-h sv-h-big">Thank you.</h1>}
          {ask.body ? <p className="sv-lead">{ask.body}</p> : null}

          {isLadder ? (
            <div className="sv-ask">
              {ask.motivation_line ? <p className="sv-motiv">{ask.motivation_line}</p> : null}
              <div className="sv-ladder">
                {(ask.amounts || []).map((a) => (
                  <a key={a.amount} className="sv-amt" href={a.url}>
                    <span className="sv-amt-n">${a.amount}{ask.frequency === "monthly" ? <small>/mo</small> : null}</span>
                    {a.tag ? <span className="sv-amt-tag">{a.tag}</span> : null}
                  </a>
                ))}
                {ask.allow_other ? <a className="sv-amt sv-amt-other" href={ask.other_url}>Other amount</a> : null}
              </div>
              {ask.talk_to_us ? <a className="sv-link" href={ask.talk_to_us.url}>{ask.talk_to_us.label}</a> : null}
              {ask.cap && ask.cap.disclosure ? <p className="sv-fine">{ask.cap.disclosure}</p> : null}
            </div>
          ) : (
            <div className="sv-ask">
              {ask.primary_cta ? <a className="sv-btn sv-btn-block" href={ask.primary_cta.url}>{ask.primary_cta.label} <Arrow /></a> : null}
              {ask.secondary_cta ? <a className="sv-link" href={ask.secondary_cta.url}>{ask.secondary_cta.label}</a> : null}
            </div>
          )}
        </div>
      </div>
      <Foot copy={boot.copy} />
    </div>
  );
}

// ================= chrome ================================================
function Loading() { return <div className="sv-load"><span>Loading&hellip;</span></div>; }
function ErrorView({ msg }) {
  return <div className="sv-shell"><div className="sv-stage"><div className="sv-q sv-center">
    <h1 className="sv-h">Hmm.</h1><p className="sv-lead">{msg}</p>
    <button className="sv-btn" onClick={() => location.reload()}>Try again</button>
  </div></div></div>;
}
function Foot({ copy }) {
  return (
    <footer className="sv-foot">
      <span>Farmers Fightback</span>
      {copy && copy.privacy_url ? <a href={copy.privacy_url} target="_blank" rel="noopener">Privacy</a> : null}
    </footer>
  );
}
function Arrow() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function Check() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

// ---- inject brand + component CSS --------------------------------------
function applyBrand(brand) {
  if (!brand) return;
  const r = document.documentElement.style;
  const map = { navy: "--navy", navy_deep: "--navy-deep", red: "--red", button: "--button", button_hover: "--button-hover", gold: "--gold", cream: "--cream", ink_on_dark: "--ink", muted_on_dark: "--muted", pill_radius: "--pill" };
  Object.entries(map).forEach(([k, v]) => { if (brand[k]) r.setProperty(v, brand[k]); });
}

const CSS = `
.sv-shell{display:flex;flex-direction:column;min-height:100dvh}
.sv-bar{position:fixed;top:0;left:0;right:0;height:4px;background:rgba(255,255,255,.10);z-index:5}
.sv-bar-fill{height:100%;background:var(--gold);transition:width .35s cubic-bezier(.4,0,.2,1)}
.sv-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:64px 22px 32px;width:100%}
.sv-q{width:100%;max-width:560px}
.sv-center{text-align:center;display:flex;flex-direction:column;align-items:center}
.sv-h{font-family:var(--f-head);font-weight:700;font-size:29px;line-height:1.18;color:var(--ink);letter-spacing:-.01em;text-wrap:balance}
.sv-h-big{font-size:34px;line-height:1.12}
.sv-help{color:var(--muted);font-size:15.5px;margin-top:12px;line-height:1.45}
.sv-lead{color:var(--muted);font-size:17px;margin-top:14px;line-height:1.5;max-width:460px;text-wrap:pretty}
.sv-opts{display:flex;flex-direction:column;gap:11px;margin-top:26px}
.sv-opt{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;
  background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.16);border-radius:14px;
  padding:16px 18px;color:var(--ink);font-family:var(--f-ui);font-size:16.5px;line-height:1.3;cursor:pointer;
  transition:border-color .12s,background .12s,transform .05s;-webkit-tap-highlight-color:transparent}
.sv-opt:hover{border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.1)}
.sv-opt:active{transform:scale(.994)}
.sv-opt.is-pick{border-color:var(--gold);background:rgba(255,179,0,.16)}
.sv-opt-label{flex:1}
.sv-opt-tick{width:24px;height:24px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--gold);opacity:0;transition:opacity .1s}
.sv-opt.is-pick .sv-opt-tick{opacity:1}
.sv-opt-box{width:24px;height:24px;flex:none;border:2px solid rgba(255,255,255,.35);border-radius:7px;display:flex;align-items:center;justify-content:center;color:var(--navy-deep)}
.sv-opt.is-pick .sv-opt-box{background:var(--gold);border-color:var(--gold)}
.sv-scale{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:26px}
.sv-scale-btn{aspect-ratio:1;border-radius:14px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.16);
  color:var(--ink);font-family:var(--f-head);font-size:24px;font-weight:700;cursor:pointer;transition:.12s}
.sv-scale-btn:hover{border-color:rgba(255,255,255,.4)}
.sv-scale-btn.is-pick{background:var(--gold);border-color:var(--gold);color:var(--navy-deep)}
.sv-scale-labels{display:flex;justify-content:space-between;margin-top:10px;color:var(--muted);font-size:13px}
.sv-input{width:100%;margin-top:24px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.24);
  border-radius:14px;padding:16px 18px;color:var(--ink);font-family:var(--f-ui);font-size:18px;outline:none;transition:border-color .12s}
.sv-input:focus{border-color:var(--gold)}
.sv-input::placeholder{color:rgba(255,255,255,.4)}
.sv-input-code{max-width:180px;text-align:center;letter-spacing:.3em;font-size:24px}
.sv-form{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.sv-form .sv-input{margin-top:12px}
.sv-btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;margin-top:26px;
  background:var(--button);color:#fff;border:0;border-radius:var(--pill);padding:15px 30px;font-family:var(--f-ui);
  font-weight:700;font-size:16.5px;cursor:pointer;transition:background .14s,transform .05s;box-shadow:0 10px 26px rgba(0,0,0,.28)}
.sv-btn:hover{background:var(--button-hover)}
.sv-btn:active{transform:translateY(1px)}
.sv-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
.sv-btn-next{align-self:flex-start}
.sv-center .sv-btn-next,.sv-btn-block{align-self:center}
.sv-btn-block{width:100%;max-width:360px;text-decoration:none;margin-top:8px}
.sv-link{display:inline-block;margin-top:18px;background:none;border:0;color:var(--muted);font-family:var(--f-ui);
  font-size:15px;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.sv-link:hover{color:var(--ink)}
.sv-ask{width:100%;max-width:440px;margin-top:22px}
.sv-motiv{font-family:var(--f-head);font-size:19px;color:var(--gold);line-height:1.3;margin-bottom:16px;text-wrap:pretty}
.sv-ladder{display:flex;flex-direction:column;gap:11px}
.sv-amt{display:flex;flex-direction:column;align-items:center;gap:2px;text-decoration:none;
  background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.2);border-radius:14px;padding:15px 18px;
  color:var(--ink);transition:.12s}
.sv-amt:hover{border-color:var(--gold);background:rgba(255,179,0,.14);transform:translateY(-1px)}
.sv-amt-n{font-family:var(--f-head);font-weight:700;font-size:26px}
.sv-amt-n small{font-size:14px;font-weight:400;color:var(--muted)}
.sv-amt-tag{font-size:13.5px;color:var(--muted)}
.sv-amt-other{font-family:var(--f-ui);font-weight:600;font-size:16px}
.sv-fine{color:var(--muted);opacity:.85;font-size:12.5px;margin-top:16px;line-height:1.45}
.sv-fine a,.sv-foot a{color:var(--muted)}
.sv-err{color:#ff9b9b;font-size:14px;margin-top:12px}
.sv-foot{display:flex;justify-content:space-between;gap:16px;padding:20px 22px calc(20px + env(safe-area-inset-bottom));
  color:var(--muted);font-size:12px;opacity:.75;max-width:600px;margin:0 auto;width:100%}
.sv-load{display:flex;min-height:100dvh;align-items:center;justify-content:center;color:var(--muted);font-family:var(--f-head);font-size:18px}
.sv-load span{animation:svp 1.1s ease-in-out infinite}
@keyframes svp{0%,100%{opacity:.25}50%{opacity:1}}
@media (min-width:640px){.sv-h{font-size:32px}.sv-h-big{font-size:40px}.sv-stage{padding-top:80px}}
`;
(function injectCss() {
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
})();

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
