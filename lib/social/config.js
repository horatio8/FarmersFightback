// Shared configuration for the social identity pipeline.
// All values that could ever change live here.

module.exports = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || 'app8m8laqgIClPw2Z',

  TABLES: {
    IDENTITIES: 'tblGRJe5q0opvHP9x',
    SYNC_STATE: 'tbl3mNhGNJeIok9YQ',
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

  // True when a row/event belongs to us, or when we genuinely cannot tell.
  //
  // Deliberately asymmetric: we drop only on POSITIVE evidence that something
  // belongs to another organisation. A payload with no account attribution is
  // kept, because silently discarding our own traffic over a missing field is
  // worse than the occasional foreign record — and every source we actually
  // read (inbox conversations, comment inbox) does carry accountId.
  isOurAccount(accountId) {
    if (!accountId) return true;
    return this.ZERNIO_ACCOUNT_IDS.includes(String(accountId));
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
