// GET/POST /api/admin/backfill-conversations?token=ADMIN_TOKEN
// One-off: pages Zernio's inbox conversation list (Facebook + Instagram DM
// threads, including history replayed from before the accounts were
// connected, which fires no webhooks) and upserts an Identity per
// participant. Resumable via Sync State, same pattern as seed-identities.

const { TABLES } = require('../../lib/social/config');
const { zernio } = require('../../lib/social/zernio');
const { select, update, create, upsert } = require('../../lib/social/airtable');

const STATE_KEY = 'backfill_conversations';
const TIME_BUDGET_MS = 50 * 1000;

async function getState() {
  const rows = await select(TABLES.SYNC_STATE, `{key} = '${STATE_KEY}'`, null, 1);
  if (!rows.length) return { rec: null, state: { cursor: null, processed: 0, done: false } };
  let state = { cursor: null, processed: 0, done: false };
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
  if (req.query && req.query.restart) state = { cursor: null, processed: 0, done: false };

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const out = await zernio('GET', '/inbox/conversations', null, {
        limit: 50,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      });
      const rows = out.data || [];

      // One row per PERSON, not per conversation. Airtable's performUpsert
      // rejects the whole batch ("Cannot update more than one record for
      // fields to merge on") if two records in it share the merge key, and a
      // person with several threads produces exactly that. Collapse on
      // identity_key, keeping the last conversation seen for them in this page.
      const byKey = new Map();
      for (const c of rows) {
        state.processed += 1;
        if (!c.participantId) continue;
        const key = `${c.platform}|${c.participantId}`;
        const prev = byKey.get(key) || {};
        byKey.set(key, {
          identity_key: key,
          platform: c.platform,
          platform_user_id: c.participantId,
          // Keep whichever thread actually carried a name/picture.
          display_name: c.participantName || prev.display_name || undefined,
          profile_picture: c.participantPicture || prev.profile_picture || undefined,
          conversation_id: c.id,
          source: 'dm_backfill',
        });
      }
      const upserts = Array.from(byKey.values());
      // strip undefineds
      upserts.forEach((u) => Object.keys(u).forEach((k) => u[k] === undefined && delete u[k]));
      if (upserts.length) await upsert(TABLES.IDENTITIES, upserts, ['identity_key']);

      const next =
        (out.pagination && out.pagination.nextCursor) || out.nextCursor || null;
      state.cursor = next;
      if (!next || rows.length === 0) {
        state.done = true;
        break;
      }
    }

    await saveState(rec, state);
    res.status(200).json({
      done: state.done,
      processed: state.processed,
      note: state.done ? 'conversation backfill complete' : 'call again to continue',
    });
  } catch (e) {
    await saveState(rec, state).catch(() => {});
    res.status(500).json({ ok: false, error: String(e && e.message), ...state });
  }
};
