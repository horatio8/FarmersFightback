# Tests

Three stages, run in the order that makes each one cheap.

```
cd test && npm install          # once
node run.js                     # check everything, change nothing
node run.js --fix               # repair what can be repaired, then re-check
node run.js --unit              # unit tests only, no browser, about a second
node run.js --update            # accept the current rendering as the baseline
```

Exit code is 0 when everything passed. That is the whole contract; CI needs
nothing else.

## What it costs to run

Nothing, and that is deliberate.

The browser stage drives real Chromium over the real pages, but it serves them
from the working tree, answers our own API from fixtures in `lib/site.js`, and
fulfils every third-party request locally from `node_modules`. So a full run
sends no production traffic, spends no Airtable, Campaign Nucleus or Stripe
quota, calls no model, and needs no secrets. It also cannot be broken by an
outage at unpkg or Google Fonts.

The unit stage replaces `fetch` with an in-memory double, so the modules that
normally talk to Airtable and Campaign Nucleus are exercised without either.

## The three stages

**`unit.js`** — the logic behind the endpoints. Passcodes, invitation tokens,
referral code uniqueness, the email rule Campaign Nucleus actually enforces,
PII masking, rate limiting, what the prefill endpoint will and will not answer
to, and the integrity of `vercel.json` and every internal link.

**`autofix.js`** — static defects that can be both detected and repaired from
the file itself. Missing charset, viewport, favicon, `lang`, or `noindex` on a
private page; a `target=_blank` without `rel=noopener`; a link to a `.html`
path that `cleanUrls` will redirect; an asset loaded over plain http; a
versioned asset whose `?v=` did not move when the file did.

The bar for a rule living here is that its fix needs no judgement. Anything
requiring a decision belongs in a test that fails and asks a person. After
fixing, every rule re-runs; a rule that still reports its own finding is
reported as `STILL BROKEN` rather than looped on.

**`regression.js`** — the impression pass. Every page is loaded in Chromium at
desktop and phone width and reduced to a structural fingerprint: word count,
headings, calls to action, form fields, images, links, horizontal overflow.
Each page must throw no errors, log nothing to `console.error`, resolve every
first-party request, talk only to reviewed third parties, and render real
content. Gated pages must stay shut.

The fingerprint is compared against `baselines/pages.json`, so a change that
quietly empties a page, drops its call to action, or removes a form field
fails the build. It is structural rather than pixel-based on purpose: a
screenshot diff fails on a font hinting change, this fails only when the
page's substance moves.

## Two things worth knowing before changing it

**Overflow is measured as change, not as an absolute.** The harness cannot
reach Google Fonts, so pages render in a wider fallback face — enough to push
the nav past the viewport on its own. Asserting zero overflow would fail on a
font substitution no visitor ever sees. So the check is against the recorded
figure, with an absolute ceiling to catch a grossly broken layout.

**Settling waits for mutations to stop, not for a timer.** These pages compile
their JSX in the browser and mount in stages: `/demandcarroll` briefly holds
385 of its eventual 1452 words, for about 200ms, around 2.5s in. Anything that
samples on an interval lands inside that window sooner or later and fails a
build for no reason. `settle()` watches with a `MutationObserver` and waits for
the DOM to go quiet, which is a signal rather than a guess about machine speed.

## The baseline

`baselines/pages.json` is the recorded impression of each page, and
`baselines/assets.json` tracks asset digests for the cache-bust rule. Both are
committed, because a baseline that only exists on one machine compares nothing.

The baseline is only written when a run is clean, or when `--update` is passed.
Recording a broken page as normal is how a suite stops finding anything.

When a change to a page is intended, run `node run.js --update` and commit the
new baseline alongside it — the diff shows exactly what moved.

## Adding to it

The runner in `lib/tap.js` is about ninety lines and has no dependencies,
because the site itself has none. A test is an async function; a failure is a
thrown error. Assertion messages are written to be read by someone who did not
write the test.

The dependency manifest lives in `test/package.json` rather than at the repo
root: the site is deliberately dependency-free, and a `package.json` at the
root would change how Vercel builds it. `.vercelignore` keeps this folder out
of the deployment.
