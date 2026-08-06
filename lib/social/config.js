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

  // Events the webhook subscription asks Zernio for.
  ZERNIO_EVENTS: [
    'comment.received',
    'message.received',
    'conversation.started',
    'lead.received',
  ],

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
