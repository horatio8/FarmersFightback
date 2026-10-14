# Scrap the Fire Tax

Election site for CFA volunteers at the Victorian state election, 28 November 2026. Adapted from `farmersvotes/` (same lookup engine, boundaries, candidate data, donate flow and password gate), rebranded and re-pointed at the Emergency Services and Volunteers Fund levy.

What changed from Farmers Votes:

| Area | Change |
|---|---|
| Brand | "Scrap the Fire Tax", red / hi-vis yellow / charcoal. Wordmark is markup (`Logo` in `app.jsx`), no image files. Working name until the brand and domain are settled. |
| Seat page | A volunteer scorecard instead of "Put Labor Last": every candidate gets a green, red or grey firefighter from `content/scorecard.json`, sorted green first. A candidate's own survey answer beats their party's position. Every coloured light shows its source. |
| Issues | Six sourced issues in `content/issues.json`, two tracks (Country / City). |
| Images | `assets/hero.jpg` and `assets/issues/*.jpg` are AI-generated illustrations. No CFA logos or insignia. Label them as AI in any paid ad. |
| Gate | `middleware.js`, password `hooter`. Delete the file to open the site. |
| Placeholders | Authorisation line and support email in `config/jurisdictions.json`; entity legal name in the donate terms (`app.jsx`). |

Run: `node test/run.js`, `node scripts/dev-server.js` (port 3100).

Deploy: own Vercel project on this repo, Root Directory = `cfavotes`. Without Airtable or Stripe env vars the lookup and scorecard work, capture answers 202 without storing, and donate says donations open shortly.
