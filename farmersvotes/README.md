# Farmers Votes

Farmers Fightback Votes, the election arm of Farmers Fightback: "Save our farmers. Put Labor Last." Look up your seat, see who's standing and how to vote, sign up for an election-day text, donate. Victoria first, every other state switchable.

Pages (one React bundle, `app.jsx`, routed on pathname), built from the Claude Design handoff:

| Route | Page |
|---|---|
| `/` | Home: hero, postcode lookup, Mary and Colin, six issue cards, donate matrix |
| `/seat` | Find: postcode lookup, split-postcode picker, when and where to vote |
| `/seat/VIC/<District>` | Result: hook, SMS reminder, how to vote, candidates, boundary map, share |
| `/card/VIC/<District>` | The how-to-vote card on its own, to print (A5) or screenshot |
| `/issues` | Why put Labor last: two tracks, six issues with sources |
| `/donate` | Amount, donor details, declaration, then Stripe Checkout; thank-you on return |
| `/about` | What Farmers Fightback Votes is |

`/parties`, `/quiz` and `/media` from the first version redirect. There is no shop on this site.

Copy lives in `content/`: `issues.json` (the six issues), `seats.json` (per-seat hook, stances, and after the ballot draw the how-to-vote order, which switches a seat to the numbered card), `places.json` (towns per seat and per split postcode).

Full design, evidence and status: **[SPEC.md](SPEC.md)**.

## Run

```
node test/run.js                 # lookup engine, APIs, content files, routes (25 tests)
node scripts/dev-server.js       # the site on http://localhost:3100
node -e "console.log(require('./lib/electorates').lookupPostcode('3387'))"
```

No dependencies to install for the site itself. The scripts have their own:

```
cd scripts && npm install
node scripts/ingest-boundaries.js VIC              # boundaries + postcode index from ABS
node scripts/import-candidates-wikipedia.js VIC 2026   # candidates + retiring list from Wikipedia
```

## Switch a state on

1. `node scripts/ingest-boundaries.js NSW`
2. In `config/jurisdictions.json`, set `states.NSW.enabled = true`
3. `node test/run.js`

## Deploy

Own Vercel project on this repo with **Root Directory = `farmersvotes`**. Env: `GOOGLE_MAPS_KEY`, `STRIPE_FV_SECRET_KEY` (without it `/api/donate` answers 503 and the page says donations open shortly), `STRIPE_FV_WEBHOOK_SECRET`, `AIRTABLE_API_KEY`, `AIRTABLE_FV_BASE_ID=app9btcsVjsWFtc2n` (base "Farmers Votes", created 12 Sep 2026 with the 12 tables in SPEC.md; add it to the API token's scope), plus the Campaign Nucleus and Cellcast keys shared with FF.
