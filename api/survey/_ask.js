// Gatepost ask router — evaluates config.ask.rules against a completed
// response and returns a fully-resolved end-screen the client just renders.
// Kept server-side so donate URLs, cap rules and rule logic aren't guessable
// or tamperable from the browser.

const { getClient } = require("./_survey");

function utm(url, outcomeId, ctx) {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  const p = new URLSearchParams({
    utm_medium: ctx.src || "web",
    utm_source: "gatepost",
    utm_campaign: ctx.campaign || "survey",
    variant: outcomeId,
    uid: ctx.uid || "",
  });
  return url + sep + p.toString();
}

// Per-amount donate link: base + UTM + amount (+ frequency for monthly).
function donateAmountUrl(base, outcomeId, ctx, amount, frequency) {
  let u = utm(base, outcomeId, ctx);
  if (amount != null) u += `&amount=${encodeURIComponent(amount)}`;
  if (frequency && frequency !== "oneoff") u += `&frequency=${encodeURIComponent(frequency)}`;
  return u;
}

function matchRule(rule, answers) {
  const w = rule.when || {};
  const v = answers[w.field];
  if (Object.prototype.hasOwnProperty.call(w, "in")) {
    return Array.isArray(w.in) && w.in.includes(v);
  }
  if (Object.prototype.hasOwnProperty.call(w, "equals")) {
    return v === w.equals;
  }
  if (Object.prototype.hasOwnProperty.call(w, "not_includes")) {
    const arr = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
    return !arr.includes(w.not_includes);
  }
  if (Object.prototype.hasOwnProperty.call(w, "includes")) {
    const arr = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
    return arr.includes(w.includes);
  }
  return false;
}

function normAmounts(amounts) {
  return (amounts || []).map((a) =>
    typeof a === "object" ? { amount: a.amount, tag: a.tag || "" } : { amount: a, tag: "" }
  );
}

// Resolve a matched rule (or the default) into the render-ready outcome.
function buildOutcome(ask, rule, answers, ctx) {
  const client = getClient();
  const cap = (client && client.donation) || {};
  const id = rule.id;
  const style = rule.style;
  const motiv = answers.motivation_primary;
  const motivationLine = (ask.c1_framing && ask.c1_framing[motiv]) || null;

  const out = {
    id,
    style,
    framing: rule.framing || "",
    body: rule.body || "",
  };

  if (style === "solidarity") {
    out.primary_cta = {
      label: (rule.primary_cta && rule.primary_cta.label) || "Volunteer",
      url: utm(ask.volunteer_url, id, ctx),
      kind: "volunteer",
    };
    out.secondary_cta = {
      label: (rule.secondary_cta && rule.secondary_cta.label) || "Chip in a little",
      url: donateAmountUrl(ask.donate_url, id, ctx, null, "oneoff"),
      kind: "donate_soft",
    };
    return out;
  }

  if (style === "share") {
    out.primary_cta = {
      label: (rule.primary_cta && rule.primary_cta.label) || "Share the campaign",
      url: utm(ask.share_url, id, ctx),
      kind: "share",
    };
    out.secondary_cta = {
      label: (rule.secondary_cta && rule.secondary_cta.label) || "Make a small donation",
      url: donateAmountUrl(ask.donate_url, id, ctx, null, "oneoff"),
      kind: "donate_soft",
    };
    return out;
  }

  // Ladder styles (monthly / major / oneoff). C1 swaps the motivation line
  // shown above the amounts.
  const frequency = rule.frequency || "oneoff";
  out.motivation_line = motivationLine;
  out.frequency = frequency;
  out.amounts = normAmounts(rule.amounts).map((a) => ({
    amount: a.amount,
    tag: a.tag,
    url: donateAmountUrl(ask.donate_url, id, ctx, a.amount, frequency),
  }));
  out.allow_other = Boolean(rule.allow_other);
  if (out.allow_other) {
    out.other_url = donateAmountUrl(ask.donate_url, id, ctx, null, frequency);
    out.cap = { amount: cap.cap_amount, currency: cap.cap_currency, disclosure: cap.cap_disclosure };
  }
  if (rule.talk_to_us && ask.major_mailto) {
    out.talk_to_us = { label: "Talk to us about a major gift", url: `mailto:${ask.major_mailto}` };
  }
  return out;
}

function evaluateAsk(survey, answers, ctx) {
  const ask = survey.ask || {};
  for (const rule of ask.rules || []) {
    if (matchRule(rule, answers)) return buildOutcome(ask, rule, answers, ctx);
  }
  return buildOutcome(ask, ask.default || { id: "default", style: "ladder_oneoff" }, answers, ctx);
}

module.exports = { evaluateAsk };
