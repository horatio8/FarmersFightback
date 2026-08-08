// Config for the campaign economics pipeline (ad spend -> CPA -> ROAS).

module.exports = {
  TABLES: {
    AD_PERFORMANCE: 'tblnIMW2DhT9Q8lZB',
    CONTACTS: 'tblE5snFCtwZmXkry',
    SIGNATURES: 'tblnuogSHcGKGFf6x',
    DONATIONS: 'tblqhZBly7JmJZ675',
    SITE_STATS: 'tblHYh3HSUISIrJFS',
    SYNC_STATE: 'tbl3mNhGNJeIok9YQ',
  },

  GRAPH: 'https://graph.facebook.com/v21.0',

  adAccountId() {
    const id = process.env.META_AD_ACCOUNT_ID; // digits only or act_ prefixed
    if (!id) throw new Error('META_AD_ACCOUNT_ID not set');
    return id.startsWith('act_') ? id : `act_${id}`;
  },

  adsToken() {
    // A token with ads_read on the ad account. Falls back to the CAPI token,
    // which works when that token's user/system-user has ad account access.
    const t = process.env.META_ADS_TOKEN || process.env.META_CAPI_TOKEN;
    if (!t) throw new Error('META_ADS_TOKEN (or META_CAPI_TOKEN) not set');
    return t;
  },

  // Alerting knobs. Defaults only — live values come from the Site Stats row
  // key = "econ_settings" (text_value JSON), editable in Airtable with no
  // redeploy: {"cpa_threshold":2.5,"min_spend":15,"window_hours":3,
  // "sms_mobile":""}. loadSettings() merges that row over these defaults.
  CPA_ALERT_THRESHOLD: Number(process.env.CPA_ALERT_THRESHOLD || 2.5),
  ALERT_MIN_SPEND: Number(process.env.ALERT_MIN_SPEND || 15),
  ALERT_WINDOW_HOURS: Number(process.env.ALERT_WINDOW_HOURS || 3),
  ALERT_MOBILE: process.env.ALERT_MOBILE || '', // optional SMS; pop-ups are primary

  async loadSettings(select) {
    const out = {
      cpa_threshold: this.CPA_ALERT_THRESHOLD,
      min_spend: this.ALERT_MIN_SPEND,
      window_hours: this.ALERT_WINDOW_HOURS,
      sms_mobile: this.ALERT_MOBILE,
    };
    try {
      const rows = await select(this.TABLES.SITE_STATS, `{key} = 'econ_settings'`, null, 1);
      if (rows.length) Object.assign(out, JSON.parse(rows[0].fields.text_value || '{}'));
    } catch (e) { /* defaults stand */ }
    return out;
  },

  // Advertiser account timezone (Meta hourly stats come back in this zone).
  ADVERTISER_TZ: process.env.ADVERTISER_TZ || 'Australia/Melbourne',
};
