// GET /api/cron/identity-resolver  (nightly)
// Links unresolved Identities to Contacts on deterministic keys only:
//   - identity.email  -> Contacts.email   (exact, case-insensitive)
//   - identity.phone  -> Contacts.mobile  (normalised digits)
// Exactly one contact match -> link + Linked.
// Two or more matches      -> Needs Review (a human decides; never guess).
// Zero matches             -> left Unresolved for a future night.
// Name matching is deliberately NOT done here: measured on known-good data
// it misses 22% and is ambiguous on another 11%.

const { TABLES } = require('../../lib/social/config');
const { listPage, select, update, create, fesc } = require('../../lib/social/airtable');

const STATE_KEY = 'identity_resolver';
const TIME_BUDGET_MS = 50 * 1000;

function normPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  // Australian numbers: compare on the last 9 digits (drops 0 / 61 prefixes)
  return digits.slice(-9);
}

module.exports = async (req, res) => {
  // Vercel cron sends Authorization: Bearer CRON_SECRET when configured.
  const auth = req.headers.authorization || '';
  const token = (req.query && req.query.token) || '';
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const adminOk = process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
  if (!cronOk && !adminOk) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const started = Date.now();
  const stats = { scanned: 0, linked: 0, review: 0, unmatched: 0 };

  try {
    let offset = null;
    do {
      const page = await listPage(TABLES.IDENTITIES, {
        pageSize: 100,
        filterByFormula:
          `AND({resolution_status} != 'Linked', OR({email} != '', {phone} != ''))`,
        ...(offset ? { offset } : {}),
      });

      for (const identity of page.records || []) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        stats.scanned += 1;
        const f = identity.fields || {};

        let matches = [];
        if (f.email) {
          matches = await select(
            TABLES.CONTACTS,
            `LOWER({email}) = '${fesc(String(f.email).trim().toLowerCase())}'`,
            ['contact_id'],
            3
          );
        }
        if (matches.length === 0 && f.phone) {
          const tail = normPhone(f.phone);
          if (tail.length >= 8) {
            matches = await select(
              TABLES.CONTACTS,
              `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({mobile}, ' ', ''), '-', ''), '+', ''), 9) = '${fesc(tail)}'`,
              ['contact_id'],
              3
            );
          }
        }

        if (matches.length === 1) {
          await update(TABLES.IDENTITIES, [
            { id: identity.id, fields: { contact: [matches[0].id], resolution_status: 'Linked' } },
          ]);
          stats.linked += 1;
        } else if (matches.length > 1) {
          await update(TABLES.IDENTITIES, [
            { id: identity.id, fields: { resolution_status: 'Needs Review' } },
          ]);
          stats.review += 1;
        } else {
          stats.unmatched += 1;
        }
      }

      offset = page.offset || null;
    } while (offset && Date.now() - started < TIME_BUDGET_MS);

    // record the run
    const existing = await select(TABLES.SYNC_STATE, `{key} = '${STATE_KEY}'`, null, 1);
    const fields = {
      key: STATE_KEY,
      value: JSON.stringify({ last_run: new Date().toISOString(), ...stats }),
      updated_at: new Date().toISOString(),
    };
    if (existing.length) await update(TABLES.SYNC_STATE, [{ id: existing[0].id, fields }]);
    else await create(TABLES.SYNC_STATE, [fields]);

    res.status(200).json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message), ...stats });
  }
};
