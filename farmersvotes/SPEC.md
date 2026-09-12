# Farmers Votes: build spec and evidence

**Purpose.** Tell voters how their local members and candidates stand on farming issues, and convert that anger into donations. Victoria first (state election **Saturday 28 November 2026**), every other state switchable without a rebuild.

**Stack.** Same as Farmers Fightback and for the same reasons: static pages + serverless functions on Vercel, Airtable as the store, Stripe for money, Campaign Nucleus and Cellcast for email and SMS, Meta pixel + CAPI for attribution. Lives in this repo under `farmersvotes/`, deployed as its **own Vercel project with Root Directory = `farmersvotes`** on its own domain. The FF site ignores the folder (`.vercelignore`).

**Status at 12 Sep 2026.** Sections marked ✅ are built and tested (`node test/run.js`, 14/14). Everything else is designed here and waiting on the inputs listed at the end.

---

## 1. Jurisdiction registry ✅

`config/jurisdictions.json` is the only place a state is named.

- One entry per state and territory: houses, seats per voter, how the upper house is derived, election dates, commission.
- `enabled: true` switches a state on. `federal_enabled` adds the federal seat for that state.
- VIC is on. NSW, QLD, SA, WA, TAS, NT, ACT are defined and off.
- Turning a state on = flip the flag + `node scripts/ingest-boundaries.js NSW` (about 5 minutes, mostly the postcode intersections). Nothing in the site code changes.
- The federal layer is the same mechanism, off until you want it. Next federal election is due by 2028.

## 2. Electorate lookup ✅

**Data source: ABS ASGS 2024 electoral boundaries**, served as GeoJSON from `geo.abs.gov.au`. One national endpoint for every state's lower house seats (SED) and every federal division (CED). Licence CC BY 4.0.

Evidence it is current and correct:
- Victoria federal from ABS = **38 divisions**, name for name identical to the AEC's own `Vic-october-2024-esri.zip` shapefile (the 2024 redistribution). Cross-checked 12 Sep 2026.
- Victoria state = **88 districts**, the 2021 redivision in force for the 2026 election. ABS names each one with its Legislative Council region in brackets, e.g. `Ripon (Western Victoria)`, so the **upper house region comes free**: no second boundary file needed.
- National counts from the same endpoint: NSW 93, QLD 93, SA 47, WA 59, NT 25, ACT 5 (each plus two ABS pseudo-regions that are stripped).
- Known towns resolve correctly: Marnoo → Ripon / Western Victoria / Mallee; Horsham → Lowan; Melbourne CBD → Melbourne / Northern Metropolitan; Mildura, Bendigo, Bairnsdale, Warrnambool all right.

How it works:
- Polygons simplified to ~40m and shipped in the repo (`data/boundaries/vic-state.json` 1.6MB, `vic-federal.json` 1.1MB). Point-in-polygon is a plain ray cast with a bounding-box pre-filter, no dependencies, **about 1ms per lookup**.
- **Full address** → Google Geocoding → point → seats. Needs `GOOGLE_MAPS_KEY`. Address is geocoded and dropped; only the point and seats come back, nothing logged.
- **Postcode** → precomputed index (`vic-postcodes.json`, 694 Victorian postcodes) built by intersecting ABS Postal Areas with the seat polygons. **447 postcodes sit in one seat and resolve outright; 247 are split** and come back with each seat's share (3387 Marnoo = 86% Ripon, 14% Lowan) so the page can say "your postcode covers two seats, pick yours or give us a street".
- A postcode from a state that is off says so by name ("New South Wales is not switched on yet"), never a blank error.
- `GET /api/lookup?postcode=` / `?lat=&lng=` / `?address=`. Postcode and point answers are edge-cached for a day.

## 3. Candidates and members ✅ (data) / ⏳ (page)

**Source: Wikipedia "Candidates of the 2026 Victorian state election"**, parsed by `scripts/import-candidates-wikipedia.js` into `data/candidates/vic-2026.json`.

What is in it, as of 12 Sep 2026:
- **Legislative Assembly: 88 districts, 372 candidates, 67 sitting members marked, 287 with a citation URL.**
- **Legislative Council: 8 regions, 78 candidates, 16 sitting members**, with ticket position.
- **Retiring: 18 MLAs and 6 MLCs**, with announcement dates and sources.
- Parties resolved: Labor 73, Liberal 69, National 10, Greens 84, One Nation 40, plus Socialists, Family First, Animal Justice, Sustainable Australia, Libertarian, independents.
- Every candidate district matches a boundary name exactly, so the lookup joins straight onto this file.

Caveats, stated plainly:
- Wikipedia is the best single public list before nominations close. It is volunteer-maintained. **Re-run the importer weekly**, and on **9 November** replace it with the VEC's declared candidates.
- Upper house tickets are joint Coalition lists, so Coalition MLCs are labelled "Coalition" unless Wikipedia tags them.
- Bendigo East has no sitting member marked and is not on the retiring list; that is Wikipedia's data, consistent with the Premier's seat being open.

## 4. Data model: new Airtable base "Farmers Votes" ⏳

| Table | One row per | Key fields |
|---|---|---|
| `Contacts` | person | same shape as FF Contacts: contact_id, name, email, mobile, postcode, **seat_state, seat_region, seat_federal**, referral_code, referred_by, source, consent flags, ff_contact_id (link back) |
| `Members` | MP or candidate | name, party, house, electorate, incumbent, retiring, photo, email, survey_token, survey_status, sources (Wikipedia + VEC), overall_rating |
| `Seats` | electorate | state, house, name, region, held_by, margin, is_farming_seat, ff_signature_count |
| `Issues` | issue | slug, title, short question, weight, active, order (five placeholders now) |
| `Positions` | member × issue | rating (Green / Amber / Red / Unknown), **confidence** (High / Medium / Low), **method** (Survey / Voting record / Public statement / Party position / Manual), evidence text, source URLs, reviewed_by, reviewed_at |
| `Party Positions` | party × issue | rating, evidence, source URLs. The fallback when a member has nothing of their own. |
| `Survey Responses` | member survey submission | member, answers per issue, commitments, submitted_at, ip |
| `Questionnaire Responses` | voter questionnaire | contact, ranking, seat, recommended candidates, converted_to_donation |
| `Donations` | Stripe event | same shape as FF Donations |
| `Media Releases` | release | title, date, body, summary, attachments, published, tags |
| `Events` | anything | append-only log, same as FF |

**Sync with Farmers Fightback ("different database, merged with FF").**
- FV base is the source of truth for anything that happens on farmersvotes.
- A `Contacts` row created or updated on FV is pushed to FF `Contacts` within a minute (webhook on write) with `source=farmersvotes` and the consent flags, and `ff_contact_id` is written back. **Not via FF's `matchOrCreateContact`**, which bumps the public signature counter; a dedicated import path that matches on email → mobile → name+postcode and never counts.
- Referral codes are shared: an FF supporter arriving at FV with `?ref=` is attributed the same way, and the code they get on FV is their FF code if they already have one.
- Nightly cron reconciles both ways and reports drift to `support@`.

## 5. Ratings model ⏳

- **Traffic light per member per issue, and an overall light per member.** Overall = worst of the weighted issues unless you override it.
- **Confidence rides on method:**
  - Survey response from the member → High. Their own words.
  - Voting record (Hansard division) → High.
  - Public statement with a source → Medium.
  - Party position inherited → Medium, shown with "party position" tag.
  - Nothing → Unknown, grey, and the page says "hasn't told us".
- **Party position overrides nothing a member said themselves.** A survey answer always wins, per your instruction.
- Every non-grey light requires at least one source URL. The page shows the source. That is the defamation posture: honest opinion on a stated factual basis.
- Disputes go to `support@farmersfightback.com`; a `disputed` flag hides the light until reviewed.

## 6. Candidate and MP survey ⏳

- Each `Members` row gets a **tokenised link** (`/survey/<token>`), the same mechanism as FF's prefill links.
- One page, one question per issue: position (Support / Oppose / Undecided) plus a free-text commitment, plus a "will you sign our pledge" box.
- Submitting writes `Survey Responses`, updates `Positions` with method=Survey, confidence=High, and stamps `survey_status=Responded`.
- **Public accountability page**: every member, whether they answered, and when they were sent it. Non-response is itself a rating signal and a pressure tool.
- Send via Campaign Nucleus with the merge field, one batch per house. Reminders at 7 and 14 days to non-responders.

## 7. Voter questionnaire ⏳

- **Drag to rank** five issues. Big touch targets, one screen, no scrolling on a phone, obvious "next". Built for people who do not use apps.
- Score per candidate in the voter's seat = Σ (issue weight from rank) × (Green +2, Amber 0, Red −2, Unknown −1). Unknown scores below Amber so silence is not rewarded.
- **Output: the candidates in their seat ranked, with the top one named as the recommendation**, each light and its source one tap away.
- **Gated**: name, email, mobile, postcode captured before the result. Consent checkbox for FF and FV updates.
- Result page ends on the donate ask, then a share link carrying their referral code.

## 8. Party comparison ⏳

- Grid: issues down, parties across. Majors (Labor, Liberal, National, Greens, One Nation) shown; **the rest in an expandable section**.
- Reads from `Party Positions`, so it updates without a deploy.
- Placeholder issues until you send the real list (you said more than five here).

## 9. Donations ⏳

- **New Stripe account**, FF's checkout and webhook code reused with a separate key set and a `fv` metadata stamp.
- **Same donor matrix as FF** (tiles, one-off and monthly).
- **Terms acceptance with capture.** Before payment: full name, residential address, email, phone, tick-box accepting the T&Cs, a declaration that the donor is an Australian citizen or permanent resident and not giving on behalf of someone else. Stored on the `Donations` row with timestamp and IP. This is what VEC disclosure will want.
- Cap warning shown when a running total for one donor approaches the Victorian limit.
- Where the ask sits: after the lookup result, after the questionnaire result, a persistent nav button, an exit-intent popup on desktop, a scroll-triggered bar on mobile, and a post-share thank-you. All of these are one config flag each so you can turn any off.

## 10. SMS ⏳

- Cellcast, same sender, same quiet-hours and one-per-person guards as FF.
- **Where people are pissed off**: rank seats by (a) the sitting member's red lights, (b) FF signature density by postcode, (c) margin. That list is the SMS target order. It is a query over `Seats` + FF Contacts postcodes, so it can be a dashboard rather than a guess.
- Journey: lookup → result → "want the seat's scorecard by text?" opt-in → one text with a link carrying their referral code.

## 11. Merch ✅ (pattern) / ⏳ (page)

- Same Shopify store, same products. `/api/shop` copied from FF with `ff_source=farmersvotes.com` on the cart attributes, so the order says which site sold it.

## 12. Media releases ⏳

- `Media Releases` table → `/api/releases` (edge-cached 5 minutes) → `/media` page. Write in Airtable, published within five minutes. Newest first, each with its own URL for sharing.
- News is just the same table with a tag.

## 13. Analytics and attribution ⏳

- Meta pixel (new pixel for the new entity) + CAPI, referral codes, UTM capture: all lifted from FF.
- Feature register (`lib/features.js` pattern) so every switch on this site is listed and reportable, as on FF.

## 14. Compliance surface, as built

- `config.site.authorisation` prints on every page footer and the donate flow. Currently `Authorised by Ben Duxson, Farmers Votes, Marnoo VIC`. You gave "VIC" alone; the VEC wants a locality with the name, so I used the one FF already uses. Change it in one place.
- Privacy policy and T&Cs pages: drafts to follow, same voice as the FF shop policies.
- The lookup keeps no addresses. Contacts capture is explicit and consented.

---

## Domain options

All checked available 12 Sep 2026. **Recommendation: register `farmersvotes.com.au` as primary and take `farmersvote.com.au` plus the `.au` forms so nobody else can.**

| Domain | Note |
|---|---|
| `farmersvotes.com.au` | matches the entity name |
| `farmersvotes.au` | short form, redirect |
| `farmersvotes.org.au` | needs a non-profit eligibility basis |
| `farmersvote.com.au`, `farmersvote.au` | the singular, defensive |
| `farmersvotes.com`, `farmersvote.com` | international, defensive |

## What I need from you, in order

1. **Domain**: pick and register. I point Vercel at it.
2. **Vercel project**: create one from this repo with Root Directory `farmersvotes`, or give me access and I will.
3. **Google Maps key** (Geocoding API enabled, HTTP-referrer restricted to the domain) → `GOOGLE_MAPS_KEY`.
4. **Stripe**: new account's secret key, publishable key, webhook secret → `STRIPE_FV_*`.
5. **Airtable**: say go and I create the base and tables above under your workspace; then add it to the API token the site uses.
6. **Campaign Nucleus**: separate list/tag for FV, and whether FV sends from its own identity.
7. **Cellcast**: same account, or a new sender ID.
8. **Meta**: new Page + pixel for Farmers Votes; the political advertiser verification and "Paid for by" disclaimer for the new entity. Start today, it gates all ad spend.
9. **Issues**: the real list, even rough, so ratings work can start.
10. **Photos**: member photos are not on Wikipedia in a usable licence for most; Parliament of Victoria headshots are the fallback.

## Launch sequencing

- **This week**: domain, Vercel project, keys, Airtable base. Lookup page, member page (Wikipedia data, grey lights), party grid with placeholders, donate flow, media releases, merch, footer/authorisation. Live with "ratings coming" on every light.
- **Week 2**: survey out to all 450 members and candidates. Questionnaire live. First ratings from voting records on the biggest issues.
- **Ongoing to 9 Nov**: ratings fill in; weekly candidate re-import.
- **9 Nov**: swap to VEC declared candidates. Final push, SMS by seat.
- **After 28 Nov**: flip `NSW.enabled`, run ingest, same site.
