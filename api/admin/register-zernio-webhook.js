// GET/POST /api/admin/register-zernio-webhook?token=ADMIN_TOKEN
// One-off: registers this deployment's /api/zernio-webhook endpoint with
// Zernio (POST /v1/webhooks/settings) for the four events the pipeline
// consumes. Safe to re-run: it lists existing webhooks first and updates
// the one named below instead of creating a duplicate.

const { zernio } = require('../../lib/social/zernio');
const { ZERNIO_EVENTS } = require('../../lib/social/config');

const WEBHOOK_NAME = 'ff-identity-pipeline';

module.exports = async (req, res) => {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'bad admin token' });
    return;
  }
  if (!process.env.ZERNIO_WEBHOOK_SECRET) {
    res.status(400).json({ error: 'set ZERNIO_WEBHOOK_SECRET first (any long random string)' });
    return;
  }

  const base =
    process.env.PUBLIC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  if (!base) {
    res.status(400).json({ error: 'set PUBLIC_BASE_URL, e.g. https://farmersfightback.com' });
    return;
  }
  const url = `${base}/api/zernio-webhook`;

  const body = {
    name: WEBHOOK_NAME,
    url,
    events: ZERNIO_EVENTS,
    secret: process.env.ZERNIO_WEBHOOK_SECRET,
  };

  try {
    // Update-if-exists so re-runs never create duplicates.
    let existingId = null;
    try {
      const listing = await zernio('GET', '/webhooks/settings');
      const rows = listing.data || listing.webhooks || [];
      const hit = rows.find((w) => w.name === WEBHOOK_NAME);
      if (hit) existingId = hit._id || hit.id;
    } catch (e) {
      // listing endpoint unavailable is fine; fall through to create
    }

    let out;
    if (existingId) {
      out = await zernio('PUT', '/webhooks/settings', { _id: existingId, ...body });
    } else {
      out = await zernio('POST', '/webhooks/settings', body);
    }
    res.status(200).json({ ok: true, url, events: ZERNIO_EVENTS, zernio: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message) });
  }
};
