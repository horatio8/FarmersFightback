# Petition → Donation → Referral Tracking System
### Reusable specification, applicable to any campaign site

**Stack:** Vercel (static site + serverless functions) · Airtable (data store) · Stripe (payments) · Meta Conversions API (ad attribution)

**Design principles**
1. **Capture natively, lose nothing.** A first-party API receives every interaction. Third-party tools (Stripe, CRM, Meta) are sinks, never the primary path.
2. **Two flexible tables + projection tables.** Single `Contacts` source-of-truth, append-only `Events` log holds full raw payloads, typed projection tables (`Donations`, `Petition Signatures`) populated by a fan-out writer.
3. **Redundant identity matching.** Match on email → mobile → name+postcode before creating.
4. **Server-side + browser-side Meta**, deduped via shared `event_id`.
5. **Per-contact referral attribution.** Every contact gets a short tokenised code embedded in shared URLs; loads, sign-throughs, and donations attribute back to the referrer.
6. **Per-donation petition attribution.** Stripe Checkout's `client_reference_id` carries the petition slug from page → Stripe → webhook → share page, so cross-petition cases are unambiguous.

---

## 1. Data model (Airtable)

### 1.1 `Contacts` — one row per unique person

| Field | Type | Notes |
|-------|------|-------|
| `contact_id` | singleLineText (primary) | UUID generated server-side |
| `first_name`, `last_name` | singleLineText | |
| `email` | email | **Primary match key.** Normalize: trim + lowercase. |
| `mobile` | phoneNumber | **Secondary match key.** Normalize to E.164. |
| `postcode` | singleLineText | Tertiary match (with name) |
| `fbclid` | singleLineText | First-touch only. Never overwritten. |
| `fbp` | singleLineText | First-touch `_fbp` cookie |
| `referral_code` | singleLineText | 5–6 char Crockford alphabet (no 0/O/1/I/L). Unique. |
| `referred_by` | multipleRecordLinks → Contacts | Self-link |
| `first_source_channel` | singleSelect | `Facebook`, `Organic`, `Referral`, `Direct`, `Other` |
| `status` | singleSelect | `Signatory Only`, `Donor Only`, `Signatory + Donor`, `Inactive` |
| `date_first_seen`, `last_updated` | dateTime | |

### 1.2 `Events` — append-only log

| Field | Type | Notes |
|-------|------|-------|
| `event_id` | singleLineText (primary) | UUID |
| `contact` | multipleRecordLinks → Contacts | |
| `event_type` | singleSelect | See §2 funnel |
| `timestamp` | dateTime | |
| `payload` | multilineText | **Full raw request body** as JSON. Never field-filter. |
| `fbclid` | singleLineText | per-event value |
| `referral_code_used` | singleLineText | |
| `source_channel` | singleSelect | |
| `meta_event_id` | singleLineText | dedup key with Meta Pixel |
| `fanout_status` | singleSelect | `Fanned Out`, `No Typed Table`, `Failed` |
| `fanout_error` | singleLineText | error message when failed |

### 1.3 `Donations` — typed projection of `Donation` events

| Field | Type |
|-------|------|
| `donation_id` (primary) | singleLineText (UUID) |
| `contact` → Contacts, `event` → Events | multipleRecordLinks |
| `amount_cents` | number |
| `amount` | currency |
| `currency` | singleLineText |
| `stripe_object_type` | singleSelect (`checkout.session`, `invoice`, `payment_intent`, `charge`) |
| `stripe_object_id`, `stripe_payment_intent` | singleLineText |
| `email`, `name`, `phone`, `postcode`, `country`, `content_name` | typed |
| `source_url`, `fbclid`, `fbp` | text |
| `petition_slug` | singleLineText | from Stripe `client_reference_id` |
| `timestamp` | dateTime |
| `payload` | multilineText (full raw) |

### 1.4 `Petition Signatures` — typed projection of `Petition Signed` events

| Field | Type |
|-------|------|
| `signature_id` (primary) | singleLineText (UUID) |
| `contact`, `event` | multipleRecordLinks |
| `first_name`, `last_name`, `email`, `mobile`, `postcode`, `country`, `campaign`, `consent` | typed |
| `fbclid`, `fbp`, `ref_used` | text |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | text |
| `timestamp` | dateTime |
| `payload` | multilineText |

### 1.5 Identity ladder

Used by every match-or-create operation:

```
1. Match on normalized email
2. else match on E.164 mobile
3. else match on lower(first_name) + lower(last_name) + postcode
4. else CREATE
```

On match: backfill empty fields, refresh `last_updated`, preserve **first-touch** values (`fbclid`, `fbp`, `date_first_seen`, original referral_code).

---

## 2. Event taxonomy + funnel

```
[Ad / Organic / Referral landing]
          │  fbclid + ref captured on landing
          ▼
   Share Click  ──── recipient loaded a ?ref= link
          │
          ▼
   Petition Signed ── new Contact created/matched
          │            referred_by populated if ref present
          ▼
   Share Conversion ─ logged on the REFERRER for credit
          │
          ▼
   Donation ────────── via Stripe webhook
          │            carries petition_slug from client_reference_id
          ▼
   Share Issued ───── donor pressed a share button on /share
          │
          └─► loop: that share generates new Share Clicks
```

Event types stored in `Events.event_type`:

| Event | Logged when | Logged on contact | Fan-out projection |
|-------|-------------|-------------------|---------------------|
| `Petition Signed` | Sign form submit | The signer | `Petition Signatures` |
| `Donation` | Stripe webhook (`checkout.session.completed`, `invoice.paid`) | The donor | `Donations` |
| `Share Issued` | Share button click on /share | The sharer | (none) |
| `Share Click` | Page load with `?ref=` | The referrer | (none) |
| `Share Conversion` | Sign form submit with `?ref=` | The referrer | (none) |
| `Survey Submitted`, `Event Registered`, `Other` | Generic `/api/event-log` | The actor | (none yet) |

**Funnel queries**:
- Total link loads per referrer: `Events` where `event_type = "Share Click"` and `referral_code_used = X`
- Sign-through count: `Events` where `event_type = "Share Conversion"` and `referral_code_used = X`, OR `Contacts` where `referred_by = X`
- Conversion rate: Share Conversions / Share Clicks per referrer
- Per-platform efficacy: filter Share Issued by `payload.platform`, follow forward to Share Clicks via `referral_code_used`

---

## 3. API endpoints

All routes share a CORS allowlist (production domains + Vercel preview hosts). All read `req.body` as JSON.

### 3.1 `POST /api/petition-signup`

Body:
```json
{
  "first_name": "Jane", "last_name": "Doe",
  "email": "jane@example.com", "mobile": "0400 000 000", "postcode": "3000",
  "fbclid": "IwAR…", "fbp": "fb.1.…", "ref": "D8MURK",
  "utm_source": "facebook", "utm_medium": "cpc", "utm_campaign": "spring"
}
```
Server steps:
1. `matchOrCreateContact()` via identity ladder
2. `setReferralCodeIfMissing()` — generate Crockford-alphabet code if absent
3. If `ref` present → resolve referrer → set `referred_by` on new contact + log `Share Conversion` on referrer
4. `logEvent("Petition Signed", payload = entire request body, meta_event_id = petition_{uuid}_{ts})`
5. Fan-out → `Petition Signatures` row
6. Fire Meta CAPI `Lead` with same `meta_event_id` for browser-pixel dedup

Response:
```json
{ "success": true, "contact_id": "uuid", "referral_code": "D8MURK", "meta_event_id": "petition_…", "is_new_contact": true }
```

### 3.2 `POST /api/event-log` — generic

Body: `{ event_type, email|mobile, payload, fbclid?, ref?, source_channel? }`

Match-or-create, log event with `payload = payload || body` (entire body if no payload supplied). No Meta fire.

### 3.3 `POST /api/stripe-webhook`

Stripe-signed events. Subscribe to `checkout.session.completed` and `invoice.paid`.

1. **Manual HMAC signature verification** (5-min skew tolerance) — never trust the SDK in serverless cold-start environments.
2. Skip `checkout.session.completed` when `mode === 'subscription'` (handled by `invoice.paid`).
3. Resolve customer details (`customer_details` → `customer_email` → fetch Customer by ID).
4. **Capture `obj.client_reference_id` → `payload.petition_slug`** (set when the donate button appended it as a URL parameter — see §5.6).
5. `matchOrCreateContact()` from customer details.
6. `logEventIdempotent({ event_type: "Donation", payload: { ...curated, petition_slug, raw: stripeObj }, meta_event_id: "stripe_<obj.id>" })` — idempotent on Stripe ID, retries don't dup.
7. Fan-out → `Donations` row.
8. Fire Meta CAPI `Purchase` with same `event_id`.

Critical: `module.exports.config = { api: { bodyParser: false } }` and read the raw body — Stripe needs the unparsed bytes for signature verification.

**Subscription rebills** (`invoice.paid` with no checkout session): `client_reference_id` isn't on the invoice — to recover the petition slug for rebills, look up the originating Checkout Session via the subscription metadata. Optional follow-up.

### 3.4 `POST /api/share-signup`

Unknown-user form on `/share`. Body: `{ first_name, last_name, email, mobile?, postcode? }`.

Match-or-create via identity ladder, ensure `referral_code`, return contact_id + referral_code. No event logged (contact creation IS the event).

### 3.5 `GET /api/share-context?session_id=cs_…` *or* `?email=…`

Resolves a donor for the `/share` page:
1. If `session_id` → call Stripe API → get `customer_details.email` AND `client_reference_id` (petition slug).
2. Else use `email` directly.
3. Lookup Contacts → return `{ contact_id, referral_code, first_name, petition_slug }`.
4. 404 if not found (client polls).

### 3.6 `POST /api/share-issued`

Body: `{ referral_code, platform, share_url }`. Lookup referrer by code, log `Share Issued` event.

### 3.7 `POST /api/share-click`

Body: `{ ref, source_url?, fbclid? }`. Fired by a beacon on every page load that has `?ref=` in the URL. Lookup referrer by code, log `Share Click` event on referrer's contact. Once-per-session dedup is client-side via sessionStorage flag.

---

## 4. Meta CAPI integration

### 4.1 Shared utility (`_meta.js`)

- SHA-256 hash all PII: `em`, `fn`, `ln`, `ph` (digits only), `zp`, `ct`, `st`, `country`, `external_id`.
- Phone normalization: strip `[\s\-()+ ]`, digits only.
- Include `client_ip_address`, `client_user_agent`.
- Build `fbc` if missing: `fb.1.<timestamp>.<fbclid>`.

### 4.2 Event mapping

| Funnel step | Meta `event_name` | `value` | `event_id` pattern |
|-------------|-------------------|---------|---------------------|
| Petition signed | `Lead` | none | `petition_{uuid}_{ts}` |
| Donation completed | `Purchase` | amount in major units | `stripe_{stripe_obj_id}` |

The same `event_id` is reused by the browser Pixel for dedup in Events Manager.

### 4.3 Browser Pixel + CAPI dedup

On the client, after the server call returns:
```js
window.fbq("track", "Lead", customData, { eventID: serverEventId });
```

---

## 5. Frontend integration

### 5.1 Attribution capture (runs on every page mount)

Captures from URL and persists to `sessionStorage`:
```
utm_source, utm_medium, utm_campaign, utm_content, utm_term,
fbclid, gclid, ttclid, li_fat_id, msclkid, twclid, sccid,
ad_id, adset_id, campaign_id, placement, ref
```

Plus `_fbp` from cookie. Plus `landing_url`, `landing_referrer`, `landing_at`.

### 5.2 Share Click load beacon

On mount, if captured attribution has `ref`:
```js
const key = `ff_ref_click_fired_${ref}`;
if (!sessionStorage.getItem(key)) {
  sessionStorage.setItem(key, "1");
  fetch("/api/share-click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, source_url: window.location.href, fbclid }),
    keepalive: true,
  });
}
```
Once per ref per session — back/forward nav doesn't double-count.

### 5.3 Petition form submit pattern

Shared helper called by every petition form on the site:

```
async function signPetition({ name, email, mobile, postcode, content_name, receiverUrl, ... }) {
  // 1. Persist the current page's URL → ff_last_petition_url localStorage
  //    so a later donate click can derive the petition slug
  // 2. Existing CRM parallel push (no-cors, fire-and-forget)
  // 3. POST /api/petition-signup → await response with referral_code
  // 4. Persist localStorage: ff_referral_code, ff_contact_id
  // 5. Browser Pixel "Lead" with shared event_id from server response
  // 6. Dispatch "petition-signed" CustomEvent for any in-page widgets
}
```

### 5.4 `/share` thank-you page

Three states:

- **polling** — landed with `?session_id={CHECKOUT_SESSION_ID}` from Stripe success_url. Polls `/api/share-context` until the webhook lands and contact exists (≤30s, every 2s). Falls back to ask state on timeout.
- **ask_identity** — no localStorage, no resolvable session. Form: first_name*, last_name*, email* (required) + mobile, postcode (optional). Submit → `/api/share-signup`.
- **ready** — render thank-you copy + N vertical brand-coloured share buttons (Facebook blue, X black, LinkedIn blue, WhatsApp green, Email yellow, Copy gray).

Each share button:
1. POSTs `/api/share-issued` fire-and-forget
2. Persists platform in `localStorage.ff_shared_platforms` (subtle ✓ + ring on used buttons)
3. Opens platform share URL in new tab (or copies link to clipboard for Copy)

Share URL construction — priority order:
1. `petition_slug` from `/api/share-context` (server-trustable; came from Stripe `client_reference_id`)
2. `ff_last_petition_url` in localStorage (set by signPetition)
3. Homepage as final fallback

Result:
```
${PRODUCTION_ORIGIN}/take-action/${petition_slug}?ref=${referral_code}
```
The petition the donor signed (or donated TO) becomes the landing page for everyone they share with — Facebook will render that page's OG image.

Share text supports `{{count}}` template — substituted at render time from the corresponding petition's `currentCount`. Operator updates `currentCount`, share text reflects it on next page load.

### 5.5 OG meta tags on every petition / landing page

```html
<meta property="og:title" content="…"/>
<meta property="og:description" content="…"/>
<meta property="og:image" content="https://<domain>/path/to/hero.jpg"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://<domain>/path"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="https://<domain>/path/to/hero.jpg"/>
```
`og:image` **must be absolute**, **must be ≥1200×630** for Facebook to pick it up reliably.

### 5.6 Stripe Payment Link click-time petition tagging

Stripe lets you pass `?client_reference_id=<value>` as a query param on a Payment Link URL. The resulting Checkout Session carries this value, the webhook reads it, and the share page knows which petition the donor came from — even if the Payment Link itself is shared across multiple campaigns.

```js
function appendClientRef(url, slug) {
  if (!url || !slug) return url;
  const u = new URL(url);
  u.searchParams.set("client_reference_id", String(slug));
  return u.toString();
}
```

Apply at click time on every donate CTA:
- Petition-page donate buttons → hardcode the petition's slug (`appendClientRef(url, "baldwins")`)
- Generic donate page → read `localStorage.ff_last_petition_url`, derive slug, append

### 5.7 Stripe Checkout success_url

For each Payment Link in the Stripe Dashboard, set:
```
https://<your-domain>/share?session_id={CHECKOUT_SESSION_ID}
```
The literal `{CHECKOUT_SESSION_ID}` is Stripe's placeholder — substituted at redirect time.

---

## 6. Identity merge rules

```
match → backfill empty fields only; never overwrite filled fields
match → bump last_updated, preserve date_first_seen
match → preserve original referral_code (don't regenerate)
match → preserve original fbclid (first-touch attribution)
no match → CREATE with all supplied fields + UUID + current timestamps
```

For phone normalization: country-specific E.164. The reference impl uses Australian heuristics (`0` prefix → `+61`) — adapt to your locale.

---

## 7. Fan-out pattern

```
PROJECTION_TABLES = {
  "Petition Signed": "Petition Signatures",
  "Donation": "Donations",
}
```

`logEvent()` writes to `Events`, then attempts a projection. Behavior:

- Event type in `PROJECTION_TABLES` AND write succeeds → `fanout_status: "Fanned Out"`
- Event type not mapped → `fanout_status: "No Typed Table"` (filterable; create the projection later and replay)
- Mapped but projection write failed → `fanout_status: "Failed"` + error in `fanout_error`

Adding a new projection = one entry in `PROJECTION_TABLES` + one `projectXxx()` function. No call-site changes.

New `Events.event_type` choices are auto-created by Airtable when `typecast: true` is set on the record write — no manual schema migration needed.

---

## 8. Idempotency

- **Stripe webhook events**: `meta_event_id = "stripe_" + stripe.object.id` — `logEventIdempotent()` queries Events for an existing row with that key before inserting. Resends/retries don't dup.
- **Petition signups**: `meta_event_id = "petition_" + contactUuid + "_" + Date.now()` — naturally unique per submission.
- **Share Click beacon**: deduped client-side via `sessionStorage` flag per ref code.
- **Share Issued**: no dedup; one row per click is desired (a donor sharing twice should be visible).

---

## 9. Environment variables

```
AIRTABLE_API_KEY                  # Personal access token, scopes: data:read, data:write, schema:read
AIRTABLE_BASE_ID                  # appXXXX…
AIRTABLE_CONTACTS_TABLE=Contacts  # optional override
AIRTABLE_EVENTS_TABLE=Events
AIRTABLE_PETITION_SIGNATURES_TABLE=Petition Signatures
AIRTABLE_DONATIONS_TABLE=Donations

STRIPE_SECRET_KEY                 # restricted token: read Checkout Sessions + Customers + Invoices + Subscriptions
STRIPE_WEBHOOK_SECRET             # whsec_…

META_PIXEL_ID
META_CAPI_TOKEN
META_TEST_EVENT_CODE              # optional, Test Events only
```

All required by both Preview and Production environments. Vercel bakes them in at build time — **redeploy after adding**.

---

## 10. Build sequence

1. Airtable: create `Contacts`, `Events`, `Donations`, `Petition Signatures`. Note: create typed tables BEFORE the link fields point at them.
2. Add `fanout_status` (singleSelect) + `fanout_error` (text) to Events.
3. Stand up `api/_airtable.js` (shared client + identity ladder + projection writers).
4. Stand up `api/_meta.js` (shared CAPI poster + SHA-256).
5. Build `api/petition-signup.js`, wire it from your petition form. Verify a row lands.
6. Build `api/stripe-webhook.js`, register in Stripe Dashboard. Verify a donation lands.
7. Add `?ref=` capture on landing pages (sessionStorage + Share Click beacon to `/api/share-click`).
8. Build `api/share-context`, `share-issued`, `share-click`, `share-signup`.
9. Build `/share` page with the three-state pattern (polling / ask_identity / ready).
10. Add `?client_reference_id=` to every donate CTA so Stripe carries petition context.
11. Update Stripe Payment Link success URLs to point at `/share?session_id={CHECKOUT_SESSION_ID}`.
12. Add OG meta tags (absolute URLs, ≥1200×630) to every petition / landing page.
13. Browser Pixel installed sitewide, firing with shared `event_id`s for dedup.

---

## 11. Verification checklist per deployment

- [ ] Submit petition with new email → `Contacts` row + `Events` Petition Signed + `Petition Signatures` row, all linked.
- [ ] Submit petition twice with same email → second creates Event but reuses Contact; first-touch `fbclid` preserved.
- [ ] Land with `?ref=<existing-code>` → Share Click row on referrer (event_type "Share Click", payload includes source_url and ip).
- [ ] Sign after `?ref=` → Share Conversion row on referrer + new contact's `referred_by` linked.
- [ ] Click `/share` button → Share Issued row.
- [ ] Real Stripe donation with `?client_reference_id=hold-the-gate` on URL → `Donations` row with `payload.petition_slug = "hold-the-gate"` + `Events` Donation row; `meta_event_id = stripe_<id>`.
- [ ] Donate again same email → match, not duplicate.
- [ ] Resend Stripe webhook → no double-row (idempotency).
- [ ] `/share?session_id=cs_…` after a donation → page loads with the right petition's share URL + hero image.
- [ ] Meta Events Manager → Lead + Purchase events with `external_id` and dedup with browser Pixel.
- [ ] Generic `/api/event-log` event with unmapped type → Events row with `fanout_status: No Typed Table`.

---

## 12. Operational notes

- **Stripe Payment Link metadata** — the `metadata` field on a Payment Link is set at creation and applies to every checkout session it produces. Use it for static traits (campaign tag, currency). For per-click context (which petition the donor came from), use `?client_reference_id=` on the URL — it's per-session.
- **Stripe webhook resend** for backfilling missed events is dashboard-only (the Stripe API doesn't expose it). Useful for first-deployment backfills.
- **Subscription rebills** don't carry `client_reference_id` on the `invoice` object. To recover the petition slug for rebills, look up the originating Checkout Session via `subscription.metadata` (stash it at first charge) or via the Stripe API.
- **Airtable test data lifecycle**: create test contacts with a recognisable email domain (e.g. `*@yourdomain.test`) so you can filter and bulk-delete them between deployments.
