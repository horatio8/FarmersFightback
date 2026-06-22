# Petition → Donation → Referral Tracking System — Part 2
### Addendum to SPEC.md, covering everything added after the first spec

This document picks up from where `SPEC.md` left off. Everything below is **additive** to that earlier spec; nothing in part 1 has been removed.

What's new in this part:
1. Meta Lead Ads ingestion via Zapier (drop-in alternative to webhook + App Review)
2. Generic `/api/event-log` upgrades — flexible payload shape, auto referral code, Meta Lead tagging, Campaign Nucleus passthrough
3. Petition Signatures schema additions for Meta context
4. New singleSelect choice `Meta Lead` on source channels
5. Reusable Airtable Interface (live dashboard with quick filters)
6. Planned: daily Meta ad-spend rollup → cost-per-lead per signature

---

## 1. Meta Lead Ads ingestion via Zapier

### 1.1 Why this path

Meta's native webhook route (the previous `/api/meta-lead-webhook` endpoint) requires App Review for `leads_retrieval` Advanced Access, Lead Access Manager configuration, the Page-to-App subscription dance, and per-form subscription. **Zapier handles all of that** via its existing OAuth integrations.

Trade-offs vs the native webhook:
- ✅ No App Review (Zapier is already approved)
- ✅ Free tier polls Meta every ~15 min — fine for non-urgent leads
- ✅ Same data lands in our backend; nothing else changes downstream
- ❌ ~15 min latency on free Zapier tier (paid: instant)
- ❌ Per-petition Zaps need wiring once each

### 1.2 Zap structure (one Zap per Lead form)

Single-step Zap (Trigger + one Action — free-tier compatible):

```
Trigger: Facebook Lead Ads (Business Admins) → New Lead
  Page: <campaign Page>
  Form: <one Lead form>

Action: Webhooks by Zapier → Custom Request
  Method: POST
  URL: https://<your-domain>/api/event-log
  Headers: Content-Type: application/json
  Data (JSON body):
    {
      "event_type": "Petition Signed",
      "source_channel": "Facebook",
      "payload": {
        "source": "meta_lead_ad",
        "petition_slug": "<your-slug, e.g. hold-the-gate>",
        "leadgen_id": "{{trigger.id}}",
        "form_id":    "{{trigger.form_id}}",
        "ad_id":      "{{trigger.ad_id}}",
        "campaign_id":"{{trigger.campaign_id}}",
        "page_id":    "{{trigger.page_id}}",
        "lead_data":  "{{trigger}}"
      }
    }
```

Server-side, `/api/event-log` does the rest — match-or-create Contact, log Event, fan out to Petition Signatures, push to Campaign Nucleus.

### 1.3 Per-petition mapping

The Zap body literally contains `petition_slug: "hold-the-gate"` (or `"baldwins"`, etc.). The endpoint uses that string to route to the right Campaign Nucleus form via env-var lookup (see §3.3).

---

## 2. `/api/event-log` upgrades

### 2.1 Flexible identity extraction

Different Zapier Lead Ads connectors emit lead fields in different shapes — some flat, some nested under `payload.lead_data`. The endpoint now walks three levels in order:

```
1. body.first_name      (top-level)
2. payload.lead_data.first_name
3. payload.first_name
```

And takes the first non-empty value. Same for `last_name`, `email`, `mobile`/`phone`/`phone_number`, `postcode`/`post_code`/`zip`/`zip_code`/`postal_code`, `fbclid`, `fbp`. Future Lead Ad shape changes don't require code changes.

### 2.2 Auto-generation of `referral_code`

`/api/event-log` now calls `setReferralCodeIfMissing()` on every match-or-create, matching the behaviour of `/api/petition-signup`. So Meta leads can themselves participate in the share-with-five loop.

### 2.3 Meta Lead tagging

When `payload.source === "meta_lead_ad"`, the endpoint **overrides** `source_channel` to the literal string `Meta Lead`, regardless of what the caller sent. This:
- Writes `Contacts.first_source_channel = "Meta Lead"` on the contact
- Writes `Events.source_channel = "Meta Lead"` on the event
- Airtable's `typecast: true` auto-creates the select option on first write

Lets reports cleanly separate paid Lead Ads from organic Facebook landings (which keep `Facebook` as their channel).

### 2.4 Campaign Nucleus passthrough

If `payload.petition_slug` is set, the endpoint looks it up in env var `CN_RECEIVER_URLS` and POSTs a form-encoded copy of the contact to the matching CN form. Best-effort — failures don't break the Airtable write.

Env var format:
```json
{
  "hold-the-gate": "https://teller.campaignnucleus.com/forms/receiver/...",
  "baldwins": "https://teller.campaignnucleus.com/forms/receiver/...",
  "_default": "https://teller.campaignnucleus.com/forms/receiver/..."
}
```

Response includes `cn: { ok, status }` so testers can see whether the push fired.

---

## 3. Schema additions

### 3.1 `Petition Signatures` — 14 new columns

```
lead_source           singleSelect   Web form | Meta lead ad | Other
meta_leadgen_id       singleLineText
meta_form_id          singleLineText
meta_form_name        singleLineText
meta_ad_id            singleLineText
meta_ad_name          singleLineText
meta_adset_id         singleLineText
meta_adset_name       singleLineText
meta_campaign_id      singleLineText
meta_campaign_name    singleLineText
meta_page_id          singleLineText
meta_platform         singleLineText   fb | ig | etc.
meta_partner_name     singleLineText
meta_created_time     dateTime
```

`projectPetitionSigned()` reads these from `payload.lead_data.*` first, then `payload.*`, populating each only when the source data is non-empty.

### 3.2 `Contacts.first_source_channel` and `Events.source_channel`

Existing singleSelect fields, now extended with a `Meta Lead` choice (auto-created via typecast on first Meta Lead Ads event). All earlier values (`Facebook`, `Organic`, `Referral`, `Direct`, `Other`) remain valid.

### 3.3 Env vars (additions)

```
CN_RECEIVER_URLS   JSON: petition_slug → Campaign Nucleus form receiver URL
                   Optional "_default" key as catch-all
```

---

## 4. Airtable Interface (Campaign Tracker)

Two-page dashboard published as a real interface on the same base. Updates live as new data lands — no refresh button needed.

### 4.1 Page 1: "Performance Overview" — dropdown filters

Four sections, one per source table:

| Section | Source table | Filters (dropdown) | Elements |
|---------|-------------|---------------------|----------|
| Contacts | Contacts | Source · Status · First seen | Total contacts · Source donut · Status bar |
| Signatures | Petition Signatures | Lead source · Signed at | Total signatures · Web vs Meta donut · By Meta form · By campaign |
| Donations | Donations | Stripe object type · Donated at | Total raised · Donation count · Avg gift · By content_name · Object type donut |
| Sharing | Events | (tabs instead — see below) | Count · By source channel · By event type |

The dropdown on date fields includes a Custom Range picker built into Airtable's UI — covers arbitrary date filtering.

### 4.2 Page 2: "Performance by date" — date-tab quick filters

Same four sections, but each section has tab chips at the top:
- All · Today · Yesterday · This week · This month · This year · Past 7 days · Past 30 days

Each tab applies a filter to its section's date field (Australia/Sydney timezone). Sharing section keeps the same tabs (since tabs and dropdowns are mutually exclusive per section).

### 4.3 Why two pages instead of one

Airtable Interface sections allow EITHER tabs OR dropdowns, not both. Two pages gives users both the quick-pick UX (date tabs) and the flexible-combination UX (source dropdowns + custom date ranges) without forcing a tradeoff.

---

## 5. Operational notes

### 5.1 Backfilling historical signatures

When new columns are added to a projection table, existing rows project against the OLD code path and won't have the new columns populated. Two options:
1. **Manual backfill**: query Events for rows of the relevant type, find linked Petition Signatures rows, run their payload through the current projector and update with `update_records_for_table`. Used for the small handful of pre-projector Meta test leads.
2. **Skip the backfill**: future rows will be correct; tag the old ones with a note view if they pollute reports.

### 5.2 Airtable's `typecast: true`

All Airtable writes from `_airtable.js` and event-log path use `typecast: true`. This means new singleSelect choices (`Meta Lead`, `Meta lead ad`, `Share Conversion`, etc.) are **auto-created on first write** — no schema migration step before code can ship the new value.

### 5.3 Zapier free-tier polling

Free Zapier polls Meta Lead Ads on ~15-minute cadence. Donors / signers won't see their email automation fire immediately. Paid Zapier Starter ($19.99/mo) drops this to 1-2 min. If sub-minute is required, fall back to the native Meta webhook (with the App Review burden it brings).

---

## 6. Planned, not built — Meta ad-spend cost-per-lead rollup

This is in the design phase; included here as the next planned addition.

### 6.1 Goal

For each Petition Signature that came in via a Meta Lead form, surface the cost the campaign paid for that lead. Computed daily from Meta Marketing API spend ÷ leads collected per ad per day.

### 6.2 Architecture

```
[Vercel Cron, daily 13:00 UTC = 23:00 Australia/Sydney]
   └── /api/cron/ad-spend-rollup
        ├── GET graph.facebook.com/v21.0/{ad_account_id}/insights
        │     ?level=ad
        │     &fields=ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,reach
        │     &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
        ├── For each ad: count Petition Signatures rows where
        │   meta_ad_id = ad_id AND timestamp falls on that date
        ├── cost_per_lead = spend / leads_count
        └── UPSERT to "Ad Spend Daily" table on (date, ad_id)
```

### 6.3 New Airtable table — `Ad Spend Daily`

```
spend_id (primary)       singleLineText  date_adid composite, idempotency key
date                     date
meta_ad_id               singleLineText
meta_ad_name             singleLineText
meta_adset_id            singleLineText
meta_adset_name          singleLineText
meta_campaign_id         singleLineText
meta_campaign_name       singleLineText
currency                 singleLineText
spend                    currency
leads_count              number
cost_per_lead            currency
impressions              number
clicks                   number
reach                    number
last_synced              dateTime
```

### 6.4 Petition Signatures linkage

Add a lookup field on Petition Signatures: `cost_per_lead_attributed`. Matches on `meta_ad_id` + date-of-`timestamp` against `Ad Spend Daily`. Updates automatically as the rollup populates.

### 6.5 Dashboard additions

- Big number: Average cost per lead (across all signatures with `cost_per_lead_attributed` set)
- Bar chart: Cost per lead by `meta_campaign_name`
- Bar chart: Total spend by `meta_ad_name`
- Filter by date as everywhere else

### 6.6 Env vars

```
META_ADS_TOKEN       System User access token, ads_read + business_management
META_AD_ACCOUNT_ID   act_NNNNNNNNN (Business Manager → Ad Accounts)
```

### 6.7 Cron config in `vercel.json`

```json
{
  "crons": [
    { "path": "/api/cron/ad-spend-rollup", "schedule": "0 13 * * *" }
  ]
}
```

### 6.8 App Review

**Not required.** `ads_read` is Standard Access. A System User on your own Ad Account, on an App in Development Mode, can read its own data without App Review.

### 6.9 Edge cases

- **Ads with spend but zero leads**: store the row anyway with `cost_per_lead = null` and `leads_count = 0` so spend is visible.
- **Leads with no `meta_ad_id`** (e.g. Lead Ads Testing tool entries): no match in `Ad Spend Daily`; their `cost_per_lead_attributed` stays blank.
- **Re-runs of the cron**: upsert on `(date, ad_id)` is idempotent. Safe to backfill arbitrary date ranges by manually invoking the endpoint with a `?date=` query param.
- **Subscription rebills** (`invoice.paid`): no `client_reference_id` on the invoice object → no `petition_slug` recorded → no per-petition CPL attribution for rebills. Open follow-up.

---

## 7. Reusable build sequence for a new campaign site

If applying this stack to a different site, the order to do things is:

1. Airtable: create base with the four tables (Contacts, Events, Donations, Petition Signatures) per Part 1
2. Add the 14 Meta-context columns to Petition Signatures (auto-typecast handles the `lead_source` choices)
3. Vercel: deploy the API endpoints (`_airtable`, `_meta`, `petition-signup`, `event-log`, `stripe-webhook`, `share-context`, `share-issued`, `share-click`, `share-signup`) with the env vars (`AIRTABLE_*`, `META_*`, `STRIPE_*`, `CN_RECEIVER_URLS`)
4. Wire the petition form to `/api/petition-signup` (via the shared `signPetition()` helper)
5. Add the `/share` page (three-state: polling / ask_identity / ready)
6. Update Stripe Payment Link success URLs to `/share?session_id={CHECKOUT_SESSION_ID}` and append `?client_reference_id=<petition-slug>` to each donate-button URL at click time
7. OG meta tags on every shareable page
8. Build the Campaign Tracker Interface (two pages: Performance Overview + Performance by date)
9. For Meta Lead Ads: build one Zap per Lead form pointing at `/api/event-log` with the petition_slug baked into the payload
10. (Future) Stand up the ad-spend cron + `Ad Spend Daily` table for cost attribution

Skip step 9 entirely if no Meta Lead Ads. Skip step 10 if cost attribution isn't needed.

---

## 8. Verification checklist (additions)

In addition to Part 1's checklist:

- [ ] Fire a test Meta lead via Zapier → confirm Airtable Contact has `first_source_channel = "Meta Lead"` and Petition Signatures row has `lead_source = "Meta lead ad"` plus all `meta_*` columns populated
- [ ] Confirm `/api/event-log` response includes `cn: { ok: true }` for petition-slug-tagged calls
- [ ] Add a new Meta Lead form on the Page → only need to add the new `form_id → petition_slug` Zap + update `CN_RECEIVER_URLS`; no code change
- [ ] Filter the Campaign Tracker dashboard by `lead_source = "Meta lead ad"` — paid leads isolated
- [ ] Date tabs on "Performance by date" page work in Sydney timezone (verify by signing a test contact at 11:55pm AEST and checking it falls in Today vs Tomorrow)
- [ ] (Once ad cost cron is live) Cron runs successfully → Ad Spend Daily populated → CPL appears on Petition Signatures via lookup
