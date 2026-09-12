# Farmers Votes

The political arm of Farmers Fightback: look up your seat, see where your members and candidates stand on farming, get told how to vote, donate. Victoria first, every other state switchable.

Full design, evidence and status: **[SPEC.md](SPEC.md)**.

## Run

```
node test/run.js                 # lookup engine, API, candidate data (14 tests)
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

Own Vercel project on this repo with **Root Directory = `farmersvotes`**. Env: `GOOGLE_MAPS_KEY`, `STRIPE_FV_SECRET_KEY`, `STRIPE_FV_WEBHOOK_SECRET`, `AIRTABLE_API_KEY`, `AIRTABLE_FV_BASE_ID`, plus the Campaign Nucleus and Cellcast keys shared with FF.
