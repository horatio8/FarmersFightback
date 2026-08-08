// GET /api/admin/meta-token-debug?token=ADMIN_TOKEN
//
// Read-only diagnosis for the ads_read failure: asks Meta who the configured
// ads token belongs to, what permissions it carries, and which ad accounts it
// can actually reach. Returns Meta's answers only — never the token itself.

const econ = require('../../lib/econ/config');

function authed(req) {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  return !!(process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN);
}

async function graph(path, params = {}) {
  const qs = new URLSearchParams({ access_token: econ.adsToken(), ...params });
  const res = await fetch(`${econ.GRAPH}/${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'bad token' });

  const out = {
    token_source: process.env.META_ADS_TOKEN ? 'META_ADS_TOKEN' : 'META_CAPI_TOKEN (fallback)',
    target_account: null,
  };
  try { out.target_account = econ.adAccountId(); } catch (e) { out.target_account = String(e.message); }

  try {
    const me = await graph('me', { fields: 'id,name' });
    out.me = me.json;

    const perms = await graph('me/permissions');
    out.permissions = (perms.json.data || []).map(p => `${p.permission}:${p.status}`);

    const accts = await graph('me/adaccounts', { fields: 'id,name', limit: 50 });
    out.ad_accounts_visible = (accts.json.data || []).map(a => `${a.id} (${a.name})`);
    if (accts.json.error) out.ad_accounts_error = accts.json.error;

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ...out, error: String(e && e.message) });
  }
};
