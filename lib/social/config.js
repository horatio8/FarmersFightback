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

  // The Zernio workspace is shared with other organisations (Fair Migration,
  // Affordable Energy Australia, Coalition for Conservation). The API key and
  // the webhook subscription are BOTH workspace-wide — there is no per-profile
  // key and no per-profile webhook — so every read and every delivered event
  // can carry another client's data. Nothing in this pipeline may rely on the
  // API to scope itself; we scope every read and drop every foreign event here.
  ZERNIO_PROFILE_ID: process.env.ZERNIO_PROFILE_ID || '69d8807145c7f2661006c630',

  // Farmers Fightback's own connected accounts. Reads pass the profile filter;
  // this list is the second line of defence, and the only one available to the
  // webhook (which has no profile scope at all).
  ZERNIO_ACCOUNT_IDS: (process.env.ZERNIO_ACCOUNT_IDS ||
    [
      '6a064f605e333c05296d469c', // facebook  farmersfightback
      '69d880ac7dea335c2bd0791c', // instagram farmersfightback.au
      '6a00150592b3d8e85fb068b2', // linkedin  Farmers Fightback
      '6a0650005e333c05296d52f6', // linkedinads Farmers Fightback
      '6a0017f592b3d8e85fb079a8', // twitter   FarmersFightbac
      '6a00156e92b3d8e85fb06abb', // youtube   farmersfightback
    ].join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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
