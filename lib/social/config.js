// Shared configuration for the social identity pipeline.
// All values that could ever change live here.

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app8m8laqgIClPw2Z';
const EVENTS_BASE_ID = process.env.AIRTABLE_EVENTS_BASE_ID || 'appE8OEBzFLzOfdMm';

module.exports = {
  AIRTABLE_BASE_ID,

  // The Events log lives in its own base as of 18 Aug 2026. The main base hit
  // its record ceiling and every logEvent() write started failing, taking
  // petition signups down with it. Airtable's record limit is per base, so a
  // second base buys a fresh allowance at no extra cost.
  //
  // Rollback without a deploy: set AIRTABLE_EVENTS_BASE_ID to the main base id
  // and AIRTABLE_EVENTS_TABLE_ID to tblhCWL3mckJl6YQ7. Both must move together
  // -- a table id is only valid inside its own base.
  EVENTS_BASE_ID,
  EVENTS_TABLE_ID: process.env.AIRTABLE_EVENTS_TABLE_ID || 'tblbI6YkuKYAKY3Li',

  // True while the log lives somewhere other than the main base. Writers use
  // this to drop cross-base linked records (Airtable links cannot span bases)
  // and to match the split table's field types.
  EVENTS_SPLIT: EVENTS_BASE_ID !== AIRTABLE_BASE_ID,

  TABLES: {
    IDENTITIES: 'tblGRJe5q0opvHP9x',
    SYNC_STATE: 'tbl3mNhGNJeIok9YQ',
    // The handle callers pass around. lib/social/airtable.js rewrites it to
    // EVENTS_TABLE_ID in EVENTS_BASE_ID on every request, so nothing outside
    // that module needs to know the log moved.
    EVENTS: 'tblhCWL3mckJl6YQ7',
    CONTACTS: 'tblE5snFCtwZmXkry',
    SIGNATURES: 'tblnuogSHcGKGFf6x',
  },

  // Zernio REST API
  ZERNIO_BASE: 'https://zernio.com/api/v1',

  // The Zernio workspace is shared across four organisations, and the API key
  // and webhook subscription are both workspace-wide. That is intentional
  // (owner decision, 2026-08-06): the pipeline captures interactions from ALL
  // of them into this base, building one pooled identity graph. Events are
  // stamped with the account and organisation they came from so any rollup or
  // export can still be segmented per organisation later.
  ORG_BY_ACCOUNT: {
    '69c0641d6cb7b8cf4c8f3088': 'Fair Migration',             // facebook
    '69c063656cb7b8cf4c8f2e69': 'Fair Migration',             // instagram fairmigration.au
    '69c064816cb7b8cf4c8f3190': 'Fair Migration',             // linkedin
    '6a064f605e333c05296d469c': 'Farmers Fightback',          // facebook farmersfightback
    '69d880ac7dea335c2bd0791c': 'Farmers Fightback',          // instagram farmersfightback.au
    '6a00150592b3d8e85fb068b2': 'Farmers Fightback',          // linkedin
    '6a0650005e333c05296d52f6': 'Farmers Fightback',          // linkedinads
    '6a0017f592b3d8e85fb079a8': 'Farmers Fightback',          // twitter FarmersFightbac
    '6a00156e92b3d8e85fb06abb': 'Farmers Fightback',          // youtube
    '69ffa46592b3d8e85fad973f': 'Affordable Energy Australia', // facebook
    '69ffa48392b3d8e85fad9899': 'Affordable Energy Australia', // instagram affordableenergy.au
    '69ffa4e492b3d8e85fad9ca0': 'Affordable Energy Australia', // linkedin
    '6a064efd5e333c05296d383a': 'Affordable Energy Australia', // metaads
    '6a02d95b92b3d8e85fcb8b93': 'Affordable Energy Australia', // tiktok affordable.energy
    '69ffa55a92b3d8e85fada010': 'Affordable Energy Australia', // twitter AusAffordEnergy
    '6a028a8292b3d8e85fc86e5d': 'Affordable Energy Australia', // youtube
    '6a02da3d92b3d8e85fcb9349': 'Coalition for Conservation',  // facebook
    '6a02da5a92b3d8e85fcb9407': 'Coalition for Conservation',  // instagram c4conservation
    '6a02d9f292b3d8e85fcb918c': 'Coalition for Conservation',  // linkedin
    '6a01c33792b3d8e85fbfae9a': 'Coalition for Conservation',  // tiktok
    '6a02d9bf92b3d8e85fcb8fc3': 'Coalition for Conservation',  // twitter CforConserv
    '6a02d8dd92b3d8e85fcb88ad': 'Coalition for Conservation',  // youtube
  },

  // Events the webhook subscription asks Zernio for.
  ZERNIO_EVENTS: [
    'comment.received',
    'message.received',
    'conversation.started',
    'lead.received',
  ],

  // Facebook page id -> connected account id. comment.received payloads carry
  // no account attribution (verified live), but a facebook platformPostId is
  // "<pageId>_<postId>", so the page prefix identifies the owner with no API
  // call. Page ids read off each account's own posts in the comment inbox.
  FB_PAGE_TO_ACCOUNT: {
    '133989799793120': '6a064f605e333c05296d469c', // Farmers Fightback
    '802816542921013': '69ffa46592b3d8e85fad973f', // Affordable Energy Australia
    '777669788767941': '69c0641d6cb7b8cf4c8f3088', // Fair Migration
    '1669729786657086': '6a02da3d92b3d8e85fcb9349', // Coalition for Conservation
  },

  airtableToken() {
    const t = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
    if (!t) throw new Error('AIRTABLE_TOKEN (or AIRTABLE_API_KEY) is not set');
    return t;
  },

  zernioKey() {
    const k = process.env.ZERNIO_API_KEY;
    if (!k) throw new Error('ZERNIO_API_KEY is not set');
    return k;
  },
};
