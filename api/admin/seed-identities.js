// GET/POST /api/admin/seed-identities?token=ADMIN_TOKEN
// Resumable one-off backfill: walks every Meta lead ad Petition Signature,
// pulls the PSID out of the payload's inbox_url, and upserts a facebook
// Identity already linked to the signature's contact.
//
// ~12,400 of the ~15,000 Meta lead signatures carry a PSID. Each invocation
// processes pages until ~50 seconds have elapsed, saves its cursor to the
// Sync State table, and reports progress. Call it repeatedly (curl in a
// loop, or just refresh) until it returns { done: true }. Re-running after
// completion is harmless: everything is an upsert on identity_key.

const { TABLES } = require('../../lib/social/config');
const { listPage, select, update, create, upsert, fesc } = require('../../lib/social/airtable');

const STATE_KEY = 'seed_identities';
const PSID_RE = /\/latest\/(\d+)\?nav_ref=thread_view_by_psid/;
const TIME_BUDGET_MS = 50 * 1000;

async function getState() {
  const rows = await select(TABLES.SYNC_STATE, `{key} = '${STATE_KEY}'`, null, 1);
  if (!rows.length) return { rec: null, state: { offset: null, processed: 0, seeded: 0, done: false } };
  let state = { offset: null, processed: 0, seeded: 0, done: false };
  try {
    state = JSON.parse(rows[0].fields.value || '{}');
  } catch (e) { /* fresh start */ }
  return { rec: rows[0], state };
}

async function saveState(rec, state) {
  const fields = { key: STATE_KEY, value: JSON.stringify(state), updated_at: new Date().toISOString() };
  if (rec) await update(TABLES.SYNC_STATE, [{ id: rec.id, fields }]);
  else await create(TABLES.SYNC_STATE, [fields]);
}

module.exports = async (req, res) => {
  const token = (req.query && req.query.token) || req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'bad admin token' });
    return;
  }

  const started = Date.now();
  let { rec, state } = await getState();

  if (state.done && !(req.query && req.query.restart)) {
    res.status(200).json({ done: true, ...state, note: 'already complete; pass ?restart=1 to run again' });
    return;
  }
  if (req.query && req.query.restart) {
    state = { offset: null, processed: 0, seeded: 0, done: false };
  }

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const page = await listPage(TABLES.SIGNATURES, {
        pageSize: 100,
        filterByFormula: `{lead_source} = 'Meta lead ad'`,
        fields: ['payload', 'contact', 'first_name', 'last_name', 'email', 'mobile'],
        ...(state.offset ? { offset: state.offset } : {}),
      });

      const rows = [];
      for (const r of page.records || []) {
        state.processed += 1;
        const f = r.fields || {};
        let psid = null;
        try {
          const j = JSON.parse(f.payload || '{}');
          const m = PSID_RE.exec(j.inbox_url || '');
          if (m) psid = m[1];
        } catch (e) { /* unparseable payload; skip */ }
        if (!psid) continue;

        const contactId = Array.isArray(f.contact) && f.contact.length ? f.contact[0] : null;
        const displayName = [f.first_name, f.last_name].filter(Boolean).join(' ') || undefined;

        const fields = {
          identity_key: `facebook|${psid}`,
          platform: 'facebook',
          platform_user_id: psid,
          display_name: displayName,
          email: f.email || undefined,
          phone: f.mobile || undefined,
          resolution_status: contactId ? 'Linked' : 'Unresolved',
          source: 'lead_backfill',
        };
        if (contactId) fields.contact = [contactId];
        Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
        rows.push(fields);
      }

      if (rows.length) {
        await upsert(TABLES.IDENTITIES, rows, ['identity_key']);
        state.seeded += rows.length;
      }

      state.offset = page.offset || null;
      if (!state.offset) {
        state.done = true;
        break;
      }
    }

    await saveState(rec, state);
    res.status(200).json({
      done: state.done,
      processed: state.processed,
      seeded: state.seeded,
      note: state.done ? 'backfill complete' : 'call again to continue',
    });
  } catch (e) {
    await saveState(rec, state).catch(() => {});
    res.status(500).json({ ok: false, error: String(e && e.message), ...state });
  }
};
