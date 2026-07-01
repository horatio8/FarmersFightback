/* ============================================================
   Farmers Fightback Rally — ticketing funnel
   Design ported from claude.ai/design ticketing/Farmers Fightback
   Rally Ticketing.html. Two flows:
     - paid: Adult + Kids qty → Stripe hosted Checkout → confirm
     - comp: /rally?claim=<token> → confirm (skips Stripe on $0)
   Backend:
     POST /api/rally-checkout  — creates Stripe Checkout Session
     POST /api/rally-claim     — validates comp token, records claim
     GET  ?session_id=X        — Stripe returns here on success
   ============================================================ */

const { useState, useRef, useEffect } = React;

/* Ticket prices — these mirror the design's TWEAK_DEFAULTS. To change
   after ship, update these constants; the server-side Stripe Price still
   controls what actually gets charged, so both must stay in sync. */
const ADULT_PRICE = 30;
const KID_PRICE = 15;

const EVENT = {
  date: "Saturday 29 August",
  gates: "Gates from 6:00pm",
  venue: "Marnoo Cricket Ground",
  place: "Marnoo, Victoria",
};

const money = (n) => "$" + Number(n).toLocaleString("en-AU");

/* ---------- tiny inline icons ---------- */
const I = {
  ticket: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M14 6v12" strokeDasharray="2 2"/></svg>),
  lock: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>),
  check: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>),
  star: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z"/></svg>),
  warn: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M4.7 19h14.6a2 2 0 0 0 1.7-3l-7.3-12a2 2 0 0 0-3.4 0L3 16a2 2 0 0 0 1.7 3z"/></svg>),
  copy: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>),
  fb: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M14 8.5V6.8c0-.8.2-1.3 1.4-1.3H17V2.7c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v1.8H8v3h2.6V21H14v-8.5h2.6l.4-3z"/></svg>),
  wa: (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.7-.1l.9-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.2.5.3 0 .2 0 .8-.2 1.4z"/></svg>),
  mail: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>),
  sms: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a8 8 0 0 1-11.4 7.2L3 21l1.8-5.4A8 8 0 1 1 21 12z"/></svg>),
  portrait: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="9" r="3.3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>),
  music: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>),
  food: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 3v7a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3M6 12v9M18.5 3c-1.7 0-3 2.2-3 5.5s1.3 4 3 4v8.5"/></svg>),
  family: (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="8" cy="7" r="2.5"/><circle cx="16.5" cy="8" r="2"/><path d="M3.5 20a4.5 4.5 0 0 1 9 0M13 20a3.8 3.8 0 0 1 7.5 0"/></svg>),
};

/* ---------- helpers ---------- */
function readRef() {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("ref") || sessionStorage.getItem("ff_ref") || "";
  } catch { return ""; }
}
function readClaim() {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("claim") || sessionStorage.getItem("ff_rally_claim") || "";
  } catch { return ""; }
}
function readSessionId() {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("session_id") || "";
  } catch { return ""; }
}

/* ---------- masthead ---------- */
function Masthead() {
  return (
    <header className="ffx-mast">
      <span className="ffx-rays" />
      <span className="ffx-sun" />
      <div className="ffx-mast-in">
        <img className="ffx-logo" src="/assets/logo-horizontal.png" alt="Farmers Fightback" />
        <div className="ffx-kicker">You&rsquo;re invited to the</div>
        <h1 className="ffx-title">Farmers Fightback<span className="ffx-rally">Rally</span></h1>
        <p className="ffx-sub"><strong>A night to fight for the future of farming &mdash; everyone welcome.</strong></p>
        <div className="ffx-band">
          <div className="ffx-band-date">{EVENT.date}</div>
          <div className="ffx-band-time">{EVENT.gates}</div>
          <div className="ffx-band-place">{EVENT.venue}<small>{EVENT.place}</small></div>
        </div>
      </div>
    </header>
  );
}

/* ---------- stepper ---------- */
function Stepper({ step, comp, allDone }) {
  const steps = comp ? ["Your details", "Your tickets"] : ["Tickets", "Payment", "Your tickets"];
  return (
    <div className="ffx-stepper">
      {steps.map((s, i) => {
        const done = allDone || i < step;
        const on = !allDone && i === step;
        return (
          <div key={s} className={"ffx-step" + (on ? " on" : "") + (done ? " done" : "")}>
            <span className="ffx-step-n">{done ? <I.check width="14" height="14" /> : i + 1}</span>
            <span className="ffx-step-l">{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- qty stepper ---------- */
function Qty({ value, onChange, min = 0, max = 20 }) {
  return (
    <div className="ffx-qty">
      <button type="button" className="ffx-qty-b" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} aria-label="Decrease">&minus;</button>
      <span className="ffx-qty-v">{value}</span>
      <button type="button" className="ffx-qty-b" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} aria-label="Increase">+</button>
    </div>
  );
}

/* ---------- field ---------- */
function Field({ label, opt, err, ...rest }) {
  return (
    <label className={"ffx-field" + (err ? " err" : "")}>
      <span className="ffx-field-l">{label}{opt ? <em>optional</em> : <span className="ffx-req" aria-hidden="true">*</span>}</span>
      <input className="ffx-input" {...rest} />
      {err && <span className="ffx-field-e">{err}</span>}
    </label>
  );
}

/* ---------- lineup ---------- */
function LineupSection() {
  const guests = [
    { lead: true, name: "Pauline Hanson", role: "Headline speaker · from 7pm", img: "/assets/rally-hanson.jpg", ph: "Photo of Pauline Hanson" },
    { name: "Ben Duxson", role: "Farmers Fightback", img: "/assets/rally-duxson.jpg", ph: "Photo of Ben Duxson" },
    { name: "Special guests", role: "More to be announced", img: "/assets/rally-guests.jpg", ph: "Add photo" },
  ];
  return (
    <section className="ffx-lineup">
      <div className="ffx-lineup-head">
        <span className="ffx-lineup-eb">On the night</span>
        <h2>Speakers from 7pm &mdash; then food &amp; music</h2>
        <p>Come for the fight, stay for the night. A proper country get-together with the people standing up for our farmers.</p>
      </div>
      <div className="ffx-speakers">
        {guests.map((g) => (
          <div key={g.name} className={"ffx-spk" + (g.lead ? " ffx-spk-lead" : "")}>
            <div className={"ffx-spk-photo" + (g.img ? " has-img" : "")}>
              {g.img
                ? <img className="ffx-spk-img" src={g.img} alt={g.name} loading="lazy" />
                : <React.Fragment><I.portrait width="32" height="32" /><span className="ph-txt">{g.ph}</span></React.Fragment>}
            </div>
            <div className="ffx-spk-name">{g.name}</div>
            <div className="ffx-spk-role">{g.role}</div>
          </div>
        ))}
      </div>
      <div className="ffx-onnight">
        <div className="ffx-on-item"><span className="ffx-on-ic"><I.music width="18" height="18" /></span><div><b>Live music</b><span>Local bands till late</span></div></div>
        <div className="ffx-on-item"><span className="ffx-on-ic"><I.food width="18" height="18" /></span><div><b>Food &amp; bar</b><span>Country kitchen + local brews</span></div></div>
        <div className="ffx-on-item"><span className="ffx-on-ic"><I.family width="18" height="18" /></span><div><b>Family friendly</b><span>Kids welcome all night</span></div></div>
      </div>
    </section>
  );
}

/* ---------- terms modal ---------- */
function TermsModal({ onClose }) {
  return (
    <div className="ffx-modal" onClick={onClose}>
      <div className="ffx-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="ffx-modal-top">
          <h3>Terms &amp; Conditions</h3>
          <button type="button" className="ffx-modal-x" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="ffx-modal-body">
          <h4>1. Tickets &amp; payment</h4>
          <p>All ticket sales are processed securely through Stripe. Prices are in Australian dollars and include GST where applicable. Your ticket is confirmed once payment is received and a confirmation email has been sent.</p>
          <h4>2. Refunds &amp; transfers</h4>
          <p>Tickets are non-refundable unless the event is cancelled. Tickets are transferable &mdash; forward your confirmation email to the new attendee. If the event is cancelled, ticket holders will be refunded in full.</p>
          <h4>3. Entry</h4>
          <p>Bring your ticket (printed or on your phone) to scan at the gate. Gates open from 6:00pm. Organisers reserve the right to refuse entry.</p>
          <h4>4. Children &amp; families</h4>
          <p>Children 12 and under require a Kids ticket. Under-18s must be accompanied by a parent or guardian at all times.</p>
          <h4>5. Conduct</h4>
          <p>This is a peaceful, family-friendly community event. Anyone behaving in a threatening, abusive or unsafe manner will be asked to leave without refund.</p>
          <h4>6. Photography &amp; media</h4>
          <p>Photography and filming take place for campaign and media purposes. By attending you consent to appearing in images and footage. Tell a staff member if you would prefer not to be photographed.</p>
          <h4>7. Program changes</h4>
          <p>Speakers, program and running times are indicative and may change without notice. Advertised guests are subject to availability.</p>
          <h4>8. Donations</h4>
          <p>Donations are voluntary, separate from ticket purchases, and non-refundable. They are not tax-deductible unless otherwise stated.</p>
          <h4>9. Privacy</h4>
          <p>Your details are collected to manage your booking and to keep you updated about the campaign. We do not sell your information, and you can unsubscribe at any time.</p>
          <h4>10. Liability</h4>
          <p>Attendees enter the venue at their own risk. The organisers are not liable for any loss, damage or injury except to the extent required by law.</p>
          <p className="ffx-modal-meta">Farmers Fightback · Marnoo, Victoria. Authorised by Ben Duxson. Questions? events@farmersfightback.com. Last updated August 2025.</p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   STEP 1 — DETAILS  (paid + comp share this)
   ============================================================ */
function DetailsStep({ comp, claimInfo, qty, setQty, form, setForm, onNext, submitting, submitError }) {
  const [errs, setErrs] = useState({});
  const total = comp ? 0 : qty.adults * ADULT_PRICE + qty.kids * KID_PRICE;
  const totalTix = comp ? qty.comp : qty.adults + qty.kids;
  const compMax = claimInfo ? Math.max(0, (claimInfo.max_qty || 0) - (claimInfo.used_qty || 0)) : 0;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const e = {};
    if (!form.first.trim()) e.first = "Required";
    if (!form.last.trim()) e.last = "Required";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) e.email = "Enter a valid email";
    if (!form.phone.trim()) e.phone = "Required";
    if (totalTix < 1) e.qty = "Add at least one ticket";
    setErrs(e);
    if (Object.keys(e).length) return;
    onNext();
  };

  return (
    <React.Fragment>
    <div className="ffx-card">
      <Stepper step={0} comp={comp} />

      {comp && claimInfo && !claimInfo.error && (
        <div className="ffx-vip">
          <div className="ffx-vip-tag"><I.star width="13" height="13" /> VIP &amp; donor invitation</div>
          <div className="ffx-vip-h">You&rsquo;ve been shouted {claimInfo.max_qty} free ticket{claimInfo.max_qty === 1 ? "" : "s"}</div>
          <p className="ffx-vip-p">A thank-you from Farmers Fightback. Claim below &mdash; no payment needed.</p>
          <div className="ffx-vip-tok">Token <b>{claimInfo.token}</b> &middot; {compMax} of {claimInfo.max_qty} remaining</div>
        </div>
      )}
      {comp && claimInfo && claimInfo.error && (
        <div className="ffx-vip ffx-vip-err">
          <div className="ffx-vip-tag"><I.warn width="13" height="13" /> Token issue</div>
          <div className="ffx-vip-h">{claimInfo.error}</div>
          <p className="ffx-vip-p">Check the link in your email, or <a href="mailto:events@farmersfightback.com" style={{color:"var(--barn)",textDecoration:"underline"}}>get in touch</a> and we'll sort it.</p>
        </div>
      )}

      <div className="ffx-sec-h">{comp ? "Claim your tickets" : "Choose your tickets"}</div>

      <div className="ffx-tickets">
        {comp ? (
          <div className="ffx-trow">
            <div className="ffx-trow-i"><I.ticket width="22" height="22" className="ffx-trow-ic" />
              <div><div className="ffx-trow-n">Free entry &mdash; comped</div><div className="ffx-trow-p">{money(0)} &middot; capped at {claimInfo ? claimInfo.max_qty : 0}</div></div>
            </div>
            <Qty value={qty.comp} min={1} max={compMax} onChange={(v) => setQty({ ...qty, comp: v })} />
          </div>
        ) : (
          <React.Fragment>
            <div className="ffx-trow">
              <div className="ffx-trow-i"><I.ticket width="22" height="22" className="ffx-trow-ic" />
                <div><div className="ffx-trow-n">Adult</div><div className="ffx-trow-p">{money(ADULT_PRICE)} each</div></div>
              </div>
              <Qty value={qty.adults} onChange={(v) => setQty({ ...qty, adults: v })} />
            </div>
            <div className="ffx-trow">
              <div className="ffx-trow-i"><I.ticket width="22" height="22" className="ffx-trow-ic" />
                <div><div className="ffx-trow-n">Kids <span className="ffx-trow-sub">12 &amp; under</span></div><div className="ffx-trow-p">{money(KID_PRICE)} each</div></div>
              </div>
              <Qty value={qty.kids} onChange={(v) => setQty({ ...qty, kids: v })} />
            </div>
          </React.Fragment>
        )}
      </div>
      {errs.qty && <div className="ffx-err-line">{errs.qty}</div>}

      <div className="ffx-sec-h">Your details</div>
      <div className="ffx-fields">
        <Field label="First name" value={form.first} onChange={set("first")} err={errs.first} placeholder="Jane" />
        <Field label="Last name" value={form.last} onChange={set("last")} err={errs.last} placeholder="Farmer" />
        <Field label="Email" type="email" value={form.email} onChange={set("email")} err={errs.email} placeholder="jane@example.com" />
        <Field label="Phone" value={form.phone} onChange={set("phone")} err={errs.phone} placeholder="0400 000 000" />
        <Field label="Postcode" opt value={form.postcode} onChange={set("postcode")} placeholder="3387" />
      </div>

      <div className="ffx-cta-row">
        <div className="ffx-total">
          <span className="ffx-total-l">{comp ? "Total" : totalTix + " ticket" + (totalTix === 1 ? "" : "s")}</span>
          <span className="ffx-total-v">{money(total)}{comp && <em> · free</em>}</span>
        </div>
        <button className="ffx-btn ffx-btn-lg" onClick={submit} disabled={submitting || (comp && (!claimInfo || claimInfo.error))}>
          {submitting ? "Please wait…" : (comp ? "Confirm my free tickets" : "Continue to payment")}
        </button>
      </div>
      {submitError && <div className="ffx-err-line">{submitError}</div>}
      {comp && <p className="ffx-fine">$0 order &mdash; you&rsquo;ll skip payment and go straight to your tickets.</p>}
    </div>
    <LineupSection />
    </React.Fragment>
  );
}

/* ============================================================
   STEP 2 — CHECKOUT (paid only) — Stripe Embedded Checkout
   Mounts Stripe's card-payment iframe inline. No redirect out until
   Stripe redirects to return_url on success.
   ============================================================ */
function CheckoutStep({ qty, form, ref_code, onBack, onTerms }) {
  const mountRef = useRef(null);
  const [state, setState] = useState("mounting"); // mounting | mounted | error
  const [errorMsg, setErrorMsg] = useState("");
  const total = qty.adults * ADULT_PRICE + qty.kids * KID_PRICE;
  const lines = [
    qty.adults > 0 && { n: "Adult", q: qty.adults, u: ADULT_PRICE },
    qty.kids > 0 && { n: "Kids (12 & under)", q: qty.kids, u: KID_PRICE },
  ].filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    let checkoutInstance = null;

    (async () => {
      try {
        // 1. Mint a fresh Embedded Checkout Session (server-side).
        const r = await fetch("/api/rally-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adult_qty: qty.adults,
            kid_qty: qty.kids,
            first_name: form.first,
            last_name: form.last,
            email: form.email,
            phone: form.phone,
            postcode: form.postcode,
            ref: ref_code,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.client_secret) {
          throw new Error(data.error || "Couldn't start checkout. Please try again.");
        }
        if (!window.Stripe) {
          throw new Error("Stripe.js failed to load. Refresh the page.");
        }
        if (!data.publishable_key) {
          throw new Error("Payments aren't fully configured yet. Please try again shortly.");
        }
        if (cancelled) return;

        // 2. Mount Stripe's embedded UI. It handles card entry, error
        //    states, and redirects to return_url on success — we get
        //    session_id back in the URL and render the confirmation.
        const stripe = window.Stripe(data.publishable_key);
        checkoutInstance = await stripe.initEmbeddedCheckout({
          clientSecret: data.client_secret,
        });
        if (cancelled) { checkoutInstance.destroy(); return; }
        checkoutInstance.mount(mountRef.current);
        setState("mounted");
      } catch (e) {
        if (cancelled) return;
        setState("error");
        setErrorMsg(String(e.message || e));
      }
    })();

    return () => {
      cancelled = true;
      if (checkoutInstance) {
        try { checkoutInstance.destroy(); } catch (e) {}
      }
    };
    // Empty deps — one session per mount. If the user hits Back and then
    // Continue again, CheckoutStep unmounts + remounts, and we mint a new
    // session with the latest details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ffx-card">
      <Stepper step={1} comp={false} />
      <div className="ffx-checkout-head">
        <span className="ffx-lockpill"><I.lock width="15" height="15" /> Secure checkout</span>
        <div className="ffx-sec-h" style={{ margin: "14px 0 0" }}>Confirm &amp; pay</div>
        <p className="ffx-fine" style={{ marginTop: 4 }}>Pay securely with card. Your details go straight to Stripe &mdash; we never see or store them. GST included where applicable.</p>
      </div>

      <div className="ffx-summary">
        {lines.map((l) => (
          <div className="ffx-sum-row" key={l.n}><span>{l.q} &times; {l.n}</span><span>{money(l.u * l.q)}</span></div>
        ))}
        <div className="ffx-sum-row ffx-sum-total"><span>Total</span><span>{money(total)}</span></div>
      </div>

      {/* Stripe's Embedded Checkout requires its mount target to contain no
          child nodes when mount() is called. Keep the ref'd div strictly
          empty and show the loader as a sibling so mount() never rejects. */}
      {state === "mounting" && (
        <div className="ffx-stripe-loader">
          <div className="ffx-spinner" />
          <div className="ffx-proc-h">Loading secure payment&hellip;</div>
        </div>
      )}
      {state !== "error" && (
        <div ref={mountRef} className="ffx-stripe-mount" />
      )}
      {state === "error" && (
        <div style={{margin: "16px 0"}}>
          <div className="ffx-err-line">{errorMsg}</div>
          <button className="ffx-btn ffx-btn-lg" onClick={() => window.location.reload()} style={{ marginTop: 12 }}>Try again</button>
        </div>
      )}
      <p className="ffx-agree">By purchasing tickets you agree to the <a href="#terms" onClick={(e) => { e.preventDefault(); onTerms && onTerms(); }}>Terms and Conditions</a>.</p>
      <button className="ffx-link" onClick={onBack}>&larr; Back to details</button>
    </div>
  );
}

/* ============================================================
   SHARE block
   ============================================================ */
function ShareBlock({ myToken }) {
  const url = `https://www.farmersfightback.com/rally${myToken ? `?ref=${myToken}` : ""}`;
  const text = "I'm going to the Farmers Fightback Rally — Sat 29 Aug, Marnoo. Come stand with us:";
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { navigator.clipboard.writeText(url); } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  const enc = encodeURIComponent;
  const chans = [
    { k: "fb", label: "Facebook", Ic: I.fb, href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`, c: "#1877F2" },
    { k: "wa", label: "WhatsApp", Ic: I.wa, href: `https://wa.me/?text=${enc(text + " " + url)}`, c: "#25D366" },
    { k: "mail", label: "Email", Ic: I.mail, href: `mailto:?subject=${enc("Come to the Farmers Fightback Rally")}&body=${enc(text + "\n\n" + url)}`, c: "#AE3528" },
    { k: "sms", label: "Text", Ic: I.sms, href: `sms:?&body=${enc(text + " " + url)}`, c: "#1F6B3B" },
  ];
  return (
    <div className="ffx-block">
      <div className="ffx-block-h"><span className="ffx-block-eb"><I.star width="12" height="12" /> Bring your people</span>
        <h3>The bigger the crowd, the louder we are</h3>
        <p>Make it a moment with your friends &amp; family.</p>
      </div>
      <div className="ffx-linkrow">
        <input className="ffx-input ffx-linkinput" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className={"ffx-copy" + (copied ? " ok" : "")} onClick={copy}>{copied ? <React.Fragment><I.check width="15" height="15" /> Copied</React.Fragment> : <React.Fragment><I.copy width="15" height="15" /> Copy</React.Fragment>}</button>
      </div>
      <div className="ffx-share-grid">
        {chans.map(({ k, label, Ic, href, c }) => (
          <a key={k} className="ffx-share-btn" href={href} target="_blank" rel="noreferrer" style={{ "--ch": c }}>
            <span className="ffx-share-ic"><Ic width="18" height="18" /></span>{label}
          </a>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   DONATION block — one click straight to the Stripe donation page.
   The per-amount Stripe payment links are read from the SAME source
   as the main /donate page (content/site.json -> donate.amounts[].
   oneOffUrl + donate.customOneOffUrl) so the two never drift. Clicking
   an amount navigates immediately; no select-then-confirm step.
   ============================================================ */
function DonationBlock({ form }) {
  const AMTS = [35, 65, 265, 550, 1500];
  const [urls, setUrls] = useState(null); // { 35: "https://buy.stripe...", ..., other: "..." }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/content/site.json", { cache: "no-store" });
        const data = await r.json();
        const d = (data && data.donate) || {};
        const map = {};
        (d.amounts || []).forEach((a) => {
          if (a && a.amount && a.oneOffUrl) map[a.amount] = a.oneOffUrl;
        });
        map.other = d.customOneOffUrl || "";
        if (!cancelled) setUrls(map);
      } catch (e) {
        if (!cancelled) setUrls({}); // fall back to /donate on click
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Straight to the matching Stripe page. Prefill the donor's email on the
  // Stripe payment link when we have it (Stripe honours ?prefilled_email=).
  // If the URL map didn't load, fall back to the /donate page so the button
  // is never a dead click.
  const go = (key) => {
    const base = urls && (key === "other" ? urls.other : urls[key]);
    let target = base || "/donate";
    if (base && form && form.email) {
      target += (base.includes("?") ? "&" : "?") + "prefilled_email=" + encodeURIComponent(form.email);
    }
    window.location.href = target;
  };

  return (
    <div className="ffx-block ffx-block-green">
      <div className="ffx-block-h">
        <span className="ffx-block-eb light">Chip in as well?</span>
        <h3 className="light">Invite your mates &mdash; <span className="ffx-scriptgold">and</span> chip in</h3>
        <p className="light">Tickets get you there; donations keep the campaign on the road. Both help. Skip if you&rsquo;d rather not.</p>
      </div>
      <div className="ffx-don-grid">
        {AMTS.map((a) => (
          <button key={a} className="ffx-don-opt" onClick={() => go(a)}>{money(a)}</button>
        ))}
        <button className="ffx-don-opt ffx-don-other" onClick={() => go("other")}>Other</button>
      </div>
      <span className="ffx-fine light" style={{ display: "block", marginTop: 14 }}>One-off &middot; secured by Stripe &middot; opens the donation page</span>
    </div>
  );
}

/* ============================================================
   CONFIRMATION
   ============================================================ */
function ConfirmStep({ comp, qty, form, orderRef, myToken }) {
  const totalTix = comp ? qty.comp : qty.adults + qty.kids;
  const total = comp ? 0 : qty.adults * ADULT_PRICE + qty.kids * KID_PRICE;
  const name = (form.first || "Friend") + (form.last ? " " + form.last : "");

  useEffect(() => {
    // Fire a client-side Meta Pixel Purchase event too so the browser side
    // matches what stripe-webhook.js fires server-side via CAPI. Value stays
    // 0 for comp tickets — Meta accepts that.
    if (window.fbq) {
      try {
        window.fbq("track", comp ? "Lead" : "Purchase", {
          content_name: comp ? "Rally Ticket (comp)" : "Rally Ticket",
          value: total,
          currency: "AUD",
          num_items: totalTix,
        });
      } catch (e) {}
    }
  }, []);

  return (
    <div className="ffx-card ffx-confirm">
      <Stepper step={comp ? 1 : 2} comp={comp} allDone />
      <div className="ffx-success">
        <span className="ffx-success-badge"><I.check width="34" height="34" /></span>
        <div className="ffx-success-script">You&rsquo;re in!</div>
        <h2 className="ffx-success-h">{totalTix} ticket{totalTix === 1 ? "" : "s"} confirmed</h2>
        <p className="ffx-fine">You&rsquo;re all set &mdash; see you at the gate.</p>
      </div>

      <div className="ffx-inbox">
        <span className="ffx-inbox-ic"><I.check width="30" height="30" /></span>
        <div className="ffx-inbox-tx">
          <div className="ffx-inbox-h">You&rsquo;re on the list</div>
          <div className="ffx-inbox-code">Confirmation code <b>{orderRef}</b></div>
          <p>Your receipt is in your inbox. Tickets will be issued closer to the function.</p>
        </div>
      </div>

      <div className="ffx-stub">
        <div className="ffx-stub-main">
          <div className="ffx-stub-eb"><I.star width="12" height="12" /> Farmers Fightback Rally</div>
          <div className="ffx-stub-date">{EVENT.date}</div>
          <div className="ffx-stub-rows">
            <div><span>Name</span><b>{name}</b></div>
            <div><span>{comp ? "Type" : "Paid"}</span><b>{comp ? "Comped · " + money(0) : money(total)}</b></div>
          </div>
        </div>
        <div className="ffx-stub-tear">
          <div className="ffx-stub-ref"><span>Order</span><b>{orderRef}</b></div>
        </div>
      </div>

      <ShareBlock myToken={myToken} />
      <DonationBlock form={form} />
    </div>
  );
}

/* ============================================================
   FUNNEL ROOT
   ============================================================ */
function RallyFunnel() {
  const claimToken = readClaim();
  const sessionId = readSessionId();
  const inboundRef = readRef();

  const comp = !!claimToken && !sessionId;
  const returningFromStripe = !!sessionId;

  const [step, setStep] = useState(returningFromStripe ? "confirm" : "details");
  const [showTerms, setShowTerms] = useState(false);
  const [qty, setQty] = useState({ adults: 2, kids: 0, comp: 1 });
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", postcode: "" });
  const [claimInfo, setClaimInfo] = useState(null);
  const [claimSubmitting, setClaimSubmitting] = useState(false);
  const [claimError, setClaimError] = useState("");

  const orderRef = useRef("FFR-" + Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.floor(100 + Math.random() * 899)).current;
  const [myReferralCode, setMyReferralCode] = useState("");

  /* Look up the comp token on landing when claim= is present. */
  useEffect(() => {
    if (!comp) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/rally-claim?token=" + encodeURIComponent(claimToken));
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !data.valid) {
          setClaimInfo({ token: claimToken, error: data.error || "This claim link isn't valid." });
        } else {
          setClaimInfo({ token: claimToken, max_qty: data.max_qty, used_qty: data.used_qty });
          setQty((q) => ({ ...q, comp: Math.min(data.max_qty - data.used_qty, q.comp || 1) || 1 }));
        }
      } catch (e) {
        setClaimInfo({ token: claimToken, error: "Couldn't verify your claim link. Try again in a moment." });
      }
    })();
    return () => { cancelled = true; };
  }, [claimToken, comp]);

  /* On returning from Stripe with ?session_id=, pull the session summary
     so we can render a real confirmation. Server also does the Airtable
     write via webhook independently. */
  useEffect(() => {
    if (!returningFromStripe) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/rally-checkout?session_id=" + encodeURIComponent(sessionId));
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && data.session) {
          const s = data.session;
          setForm((f) => ({
            first: s.first_name || f.first,
            last: s.last_name || f.last,
            email: s.email || f.email,
            phone: s.phone || f.phone,
            postcode: s.postcode || f.postcode,
          }));
          setQty((q) => ({ ...q, adults: s.adult_qty || 0, kids: s.kid_qty || 0 }));
          if (s.referral_code) setMyReferralCode(s.referral_code);
        }
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [returningFromStripe, sessionId]);

  /* Comp submit — post to /api/rally-claim, then jump to confirm. */
  const submitComp = async () => {
    setClaimSubmitting(true); setClaimError("");
    try {
      const r = await fetch("/api/rally-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: claimToken,
          qty: qty.comp,
          first_name: form.first,
          last_name: form.last,
          email: form.email,
          phone: form.phone,
          postcode: form.postcode,
          ref: inboundRef,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        throw new Error(data.error || "Couldn't confirm your tickets. Please try again.");
      }
      if (data.referral_code) setMyReferralCode(data.referral_code);
      setStep("confirm");
    } catch (e) {
      setClaimError(String(e.message || e));
    } finally {
      setClaimSubmitting(false);
    }
  };

  const goPay = () => setStep("checkout");

  let body;
  if (step === "confirm") {
    body = <ConfirmStep comp={comp} qty={qty} form={form} orderRef={orderRef} myToken={myReferralCode} />;
  } else if (step === "checkout" && !comp) {
    body = <CheckoutStep qty={qty} form={form} ref_code={inboundRef} onBack={() => setStep("details")} onTerms={() => setShowTerms(true)} />;
  } else {
    body = (
      <DetailsStep
        comp={comp}
        claimInfo={claimInfo}
        qty={qty}
        setQty={setQty}
        form={form}
        setForm={setForm}
        onNext={comp ? submitComp : goPay}
        submitting={claimSubmitting}
        submitError={claimError}
      />
    );
  }

  return (
    <div className="ffx-app">
      <Masthead />
      <div className="ffx-wrap">{body}</div>
      <footer className="ffx-foot">
        <div><span className="ffx-foot-l">Enquiries</span> events@farmersfightback.com</div>
        <button type="button" className="ffx-foot-terms" onClick={() => setShowTerms(true)}>Terms &amp; Conditions</button>
        <div className="ffx-foot-auth">Authorised by Ben Duxson, Farmers Fightback, Marnoo VIC.</div>
      </footer>
      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<RallyFunnel />);
