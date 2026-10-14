# Scrap the Fire Tax (cfavotes)

Election site for CFA volunteers against the Emergency Services and Volunteers Fund levy, Victorian state election 28 November 2026. Client: John "Hooter" Houston, CFA Volunteers Group Inc. Adapted from `../farmersvotes/`.

Work only inside `cfavotes/` on the `cfavotes` branch. Never edit `farmersvotes/` or the Farmers Fightback site at the repo root.

## Stack

Static React 18 + Babel from unpkg, no build step. Vercel serverless functions in `api/`. Same engine as Farmers Votes.

| File | What it is |
|---|---|
| `app.jsx` | The whole front end, routed on pathname: Home, Find, Seat, Card, Issues, Donate, About |
| `styles.css` | All styles, scoped under `.fv`. Palette: red #C8102E, yellow #FFC72C, charcoal #2A2522 |
| `content/issues.json` | The six issues and their sources |
| `content/scorecard.json` | Green / Red / Unknown light per party and per candidate |
| `content/seats.json` | Per-seat hook, candidate quotes, ballot order after the draw |
| `config/jurisdictions.json` | Election dates, authorisation line, support email |
| `middleware.js` | Password gate (password `hooter`). Delete the file to open the site |
| `data/` | Boundaries and the candidate list. Don't hand-edit; use `scripts/` |

## Run and check

```
node test/run.js              # must stay all green
node scripts/dev-server.js    # http://localhost:3100
```

After any visual change, look at the page at desktop (1280) and phone (390) width before committing. Bump the `?v=` query on `styles.css` and `app.jsx` in `index.html` when either changes.

## Rules

- No em dashes or en dashes anywhere, in copy, code comments or commits. No double hyphen either.
- When James supplies copy, use it exactly as written; fix typos only.
- Every factual claim in `issues.json` and every Green or Red light in `scorecard.json` needs a working https source. Claims from CFA Volunteers Group are attributed to them in the text.
- A candidate's own survey answer always beats their party's position.
- Images in `assets/` are AI-generated. No CFA logos, badges or insignia, ever.
- No env vars are set yet. Don't point this project at the Farmers Votes Airtable base or Stripe keys.

## Still to fill in

- Entity legal name (donate terms in `app.jsx`), authorisation line and support email (`config/jurisdictions.json`)
- Final brand and domain (working name Scrap the Fire Tax, scrapthefiretax.vote)
- Candidate survey answers into `scorecard.json` as they come in
- Hooter's 22 target seats
