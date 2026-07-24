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

  // run — progress + numbering are PER SECTION (core, then extension), so the
  // bar fills to the end of the section and resets when they opt into more.
  let screen = null, qIndex = 0, qTotal = 1, progress = 0, showNumber = true, showGreeting = false;
  if (pos.stage === "core") {
    screen = flow.core[pos.i]; qTotal = flow.core.length; qIndex = pos.i;
    progress = qTotal > 0 ? (pos.i + 1) / qTotal : 0;
    showGreeting = pos.i === 0; // greeting/intro rides on top of question 1
  } else if (pos.stage === "gate") {
    screen = flow.gate; showNumber = false; progress = 1; // core section complete
  } else if (pos.stage === "ext") {
    screen = flow.ext[pos.i]; qTotal = flow.ext.length; qIndex = pos.i;
    progress = qTotal > 0 ? (pos.i + 1) / qTotal : 0;
  }
  if (!screen) return <Loading />;
  const intro = boot.survey.intro;

  return (
    <div className="sv-shell">
      <div className="sv-bar"><div className="sv-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <div className="sv-stage">
        <div className="sv-col">
          {showGreeting && intro ? (
            <div className="sv-greet">
              <h2>{interp(intro.headline, vars)}</h2>
              {intro.body ? <p>{interp(intro.body, vars)}</p> : null}
            </div>
          ) : null}
          {showNumber ? (
            <div className="sv-qnum">Question {qIndex + 1} <span>of {qTotal}</span></div>
          ) : null}
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
  const deco = screen.options.length > 3; // >3 answers get icon + bold to differentiate
  return (
    <div>
      <Q screen={screen} vars={vars} />
      <div className="sv-opts">
        {screen.options.map((o) => {
          const active = picked === o.value || (picked == null && cur === o.value);
          return (
            <button key={o.value} className={"sv-opt" + (deco ? " sv-opt--deco" : "") + (active ? " is-pick" : "")}
              onClick={() => { setPicked(o.value); onCommit(screen, o.value, true); }}>
              {deco ? <span className="sv-opt-ic"><Icon name={o.icon} /></span> : null}
              <span className={"sv-opt-label" + (deco ? " is-bold" : "")}>{o.label}</span>
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
  const deco = options.length > 3; // >3 answers get icon + bold to differentiate
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
            <button key={o.value} className={"sv-opt" + (deco ? " sv-opt--deco" : "") + (active ? " is-pick" : "")} onClick={() => toggle(o.value)}>
              {deco ? <span className="sv-opt-ic"><Icon name={o.icon} /></span> : null}
              <span className={"sv-opt-label" + (deco ? " is-bold" : "")}>{o.label}</span>
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

// Line-art icon set (24x24, stroke). Keyed by option `icon` in survey config.
const ICON_PATHS = {
  tractor: '<circle cx="7" cy="16" r="4"/><circle cx="18" cy="17" r="3"/><path d="M11 14l-1-6h4l2 6"/><path d="M14 8h4v6"/>',
  home: '<path d="M4 11l8-6 8 6"/><path d="M6 10v9h12v-9"/>',
  mappin: '<path d="M12 21s-7-6.5-7-11a7 7 0 0114 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/>',
  city: '<rect x="4" y="9" width="7" height="12"/><rect x="12" y="5" width="8" height="16"/><path d="M15 9v0M15 13v0M15 17v0"/>',
  wheat: '<path d="M12 21V9"/><path d="M12 12c-2 0-3.5-1.2-3.5-3 2 0 3.5 1.2 3.5 3z"/><path d="M12 12c2 0 3.5-1.2 3.5-3-2 0-3.5 1.2-3.5 3z"/><path d="M12 16c-2 0-3.5-1.2-3.5-3 2 0 3.5 1.2 3.5 3z"/><path d="M12 16c2 0 3.5-1.2 3.5-3-2 0-3.5 1.2-3.5 3z"/>',
  gavel: '<path d="M9 11l4 4"/><path d="M14 6l4 4-3 3-4-4z"/><path d="M4 21l6-6"/><path d="M13 19h7"/>',
  flame: '<path d="M12 3c3 4 5 6 5 9a5 5 0 01-10 0c0-1.6.6-2.7 1.6-3.7C9 10 10 8 12 3z"/>',
  leaf: '<path d="M5 19c0-8 6-13 14-13 0 8-5 14-13 14"/><path d="M5 19c4-1 7-4 9-8"/>',
  handshake: '<path d="M12 8l2.5 2.5a1.5 1.5 0 002-2L14 6H9L5 9"/><path d="M19 9l-3 3"/><path d="M9 12l2 2M11 11l2 2M13 10l2 2"/>',
  bolt: '<path d="M13 2L4 14h7l-2 8 9-12h-7z"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v5"/><path d="M12 18h0"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 5-4 1 2-5z"/>',
  dollar: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.5 9.3c-.6-.8-1.5-1-2.5-1-1.4 0-2.5.7-2.5 1.8 0 2.4 5 1.2 5 3.6 0 1.1-1.1 1.8-2.5 1.8-1 0-1.9-.3-2.5-1.1"/>',
  hand: '<path d="M9 11V5.5a1.5 1.5 0 013 0V10"/><path d="M12 10V4.5a1.5 1.5 0 013 0V10"/><path d="M15 10.5V7a1.5 1.5 0 013 0v6c0 3.5-2.5 6-6 6-2 0-3.5-1-4.5-2.5L6 13c-.7-1.1.8-2.2 1.8-1.3L9 13"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 11l8-4M8 13l8 4"/>',
  sign: '<path d="M12 3v18"/><path d="M6 6h10l2 2.5L16 11H6z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M4 7l8 6 8-6"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  arrowdown: '<path d="M12 4v14M6 12l6 6 6-6"/>',
  scales: '<path d="M12 4v16M6 20h12M4 8h16"/><path d="M4 8l-2 4h4z"/><path d="M20 8l-2 4h4z"/><path d="M8 5l4-1 4 1"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  gift: '<rect x="4" y="10" width="16" height="10" rx="1"/><path d="M3 10h18v3H3z"/><path d="M12 10v10"/><path d="M12 10C10.5 10 9 9 9 7.5S11 5.5 12 10zM12 10c1.5 0 3-1 3-2.5S13 5.5 12 10z"/>',
  repeat: '<path d="M4 9l3-3 3 3"/><path d="M7 6v5a4 4 0 004 4h6"/><path d="M20 15l-3 3-3-3"/><path d="M17 18v-5a4 4 0 00-4-4H7"/>',
  star: '<path d="M12 3l2.6 5.6L20 9.3l-4 4 1 6-5-3-5 3 1-6-4-4 5.4-.7z"/>',
  video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3z"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><path d="M16 6a3 3 0 012 5.5"/><path d="M17 14.5c2 .6 4 2 4 4.5"/>',
  utensils: '<path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10"/><path d="M16 3c-1.5 0-3 2-3 5s1.5 4 3 4v9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
  _default: '<circle cx="12" cy="12" r="8"/>',
};
function Icon({ name }) {
  const p = ICON_PATHS[name] || ICON_PATHS._default;
  return <svg className="sv-ic-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: p }} aria-hidden="true" />;
}

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
.sv-col{width:100%;max-width:560px}
.sv-greet{margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.12)}
.sv-greet h2{font-family:var(--f-head);font-weight:700;font-size:25px;color:var(--ink);letter-spacing:-.01em}
.sv-greet p{color:var(--muted);font-size:15.5px;margin-top:7px;line-height:1.45}
.sv-qnum{font-family:var(--f-ui);font-weight:700;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);margin-bottom:14px}
.sv-qnum span{color:var(--muted);font-weight:600}
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
.sv-opt--deco{gap:14px}
.sv-opt-ic{width:42px;height:42px;flex:none;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(255,179,0,.15);color:var(--gold);transition:background .12s,color .12s}
.sv-opt.is-pick .sv-opt-ic{background:var(--gold);color:var(--navy-deep)}
.sv-opt-label.is-bold{font-weight:700}
.sv-ic-svg{display:block}
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
