// One-off migration: move historical Events rows out of the main base into
// the dedicated Events base, freeing the main base's record allowance.
//
//   GET /api/admin/migrate-events?token=ADMIN_TOKEN            dry run
//   GET /api/admin/migrate-events?token=ADMIN_TOKEN&write=1    migrate a batch
//   GET /api/admin/migrate-events?token=ADMIN_TOKEN&mode=count verify counts
//
// Design: there is no cursor and no saved state. The old table itself is the
// work queue — each batch is copied, re-verified, and only then deleted, so
// what remains in the old table is exactly the work still to do. Re-invoke
// until it reports done. Every step is idempotent:
//
//   1. Read a page of old rows.
//   2. Look their event_ids up in the new base; skip any already copied
//      (so a crash between copy and delete just means one no-op pass).
//   3. Write the missing ones, 10 per request.
//   4. RE-READ the new base for every event_id in the page. Only rows the
//      new base confirms it holds are deleted from the old one. A row that
//      failed to copy — or that this key cannot see, if the token lacks
//      access to the new base — is kept and reported, never deleted.
//
// A row with no event_id cannot be verified, so it is never copied or
// deleted; it is counted in `unverifiable` for a human to look at. Both
// writers have always set event_id, so this should stay at zero.
//
// The fan-out columns travel with the row and nothing here re-fans-out:
// these events were projected into their typed tables long ago.
//
// Runs inside a 300s function budget and stops itself at 240s, reporting
// how far it got. At Airtable's rate limits each invocation moves roughly
// five thousand rows.

const {
  atFetch, escapeFormula, MAIN_BASE_ID, EVENTS_BASE_ID, EVENTS_HISTORY_BASES, EVENTS_SPLIT,
} = require("../_airtable");

const EVENTS = process.env.AIRTABLE_EVENTS_TABLE || "Events";
const TIME_BUDGET_MS = 240 * 1000;

// Everything the old rows carry that the new table has a column for. Reading
// an explicit list also keeps reverse-link and computed columns out.
const COPY_FIELDS = [
  "event_id", "contact", "event_type", "timestamp", "payload", "fbclid",
  "referral_code_used", "source_channel", "meta_event_id",
  "fanout_status", "fanout_error",
  "sentiment_label", "sentiment_score", "stance", "topic",
  "escalation_flags", "analysed_at",
];

// Old row -> new row. Two translations, both forced by Airtable itself:
// a linked record cannot cross bases (contact -> contact_id text), and the
// new base's escalation_flags is plain text (multi-select -> joined string).
// Selects arrive from the REST API as plain strings already.
function mapOldEvent(fields) {
  const f = fields || {};
  const out = {};
  for (const k of COPY_FIELDS) {
    if (k === "contact") continue;
    if (f[k] === undefined || f[k] === null || f[k] === "") continue;
    out[k] = k === "escalation_flags" && Array.isArray(f[k]) ? f[k].join(", ") : f[k];
  }
  if (Array.isArray(f.contact) && f.contact.length) out.contact_id = f.contact[0];
  return out;
}

function authed(req) {
  const url = new URL(req.url, "https://x");
  const token = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  return Boolean(process.env.ADMIN_TOKEN) && token === process.env.ADMIN_TOKEN;
}

// Which of these event_ids does the new base hold? 30 per OR() keeps it to a
// couple of requests per page.
async function inNewBase(eventIds) {
  const found = new Set();
  for (let i = 0; i < eventIds.length; i += 30) {
    const slice = eventIds.slice(i, i + 30);
    const formula = `OR(${slice.map((id) => `{event_id}='${escapeFormula(id)}'`).join(",")})`;
    const params = new URLSearchParams({ filterByFormula: formula, pageSize: "100" });
    params.append("fields[]", "event_id");
    // eslint-disable-next-line no-await-in-loop
    const r = await atFetch(`${encodeURIComponent(EVENTS)}?${params}`, { baseId: EVENTS_BASE_ID });
    for (const rec of r.records || []) found.add(rec.fields && rec.fields.event_id);
  }
  return found;
}

async function countEvents(baseId) {
  let n = 0;
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    params.append("fields[]", "event_id");
    if (offset) params.set("offset", offset);
    // eslint-disable-next-line no-await-in-loop
    const r = await atFetch(`${encodeURIComponent(EVENTS)}?${params}`, { baseId });
    n += (r.records || []).length;
    offset = r.offset;
  } while (offset);
  return n;
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  if (!EVENTS_SPLIT) {
    return res.status(409).json({
      error: "AIRTABLE_EVENTS_BASE_ID points at the main base — there is nowhere to migrate to",
    });
  }

  const url = new URL(req.url, "https://x");
  const mode = url.searchParams.get("mode") || "migrate";
  const write = url.searchParams.get("write") === "1";
  const started = Date.now();

  try {
    if (mode === "count") {
      const counts = {};
      for (const baseId of [MAIN_BASE_ID, ...EVENTS_HISTORY_BASES, EVENTS_BASE_ID]) {
        if (counts[baseId] !== undefined) continue;
        // eslint-disable-next-line no-await-in-loop
        counts[baseId] = await countEvents(baseId);
      }
      counts.live_base = EVENTS_BASE_ID;
      return res.status(200).json(counts);
    }

    // The newest events in the new base — the live check that the split log
    // is actually collecting. Migrated history keeps its old timestamps, so
    // anything stamped after the cut-over is organically new. Read-only, and
    // identity is reduced to presence: no payload, no contact details.
    if (mode === "recent") {
      const params = new URLSearchParams({
        pageSize: "15",
        filterByFormula: `IS_AFTER({timestamp}, DATEADD(NOW(), -24, 'hours'))`,
      });
      ["event_id", "event_type", "timestamp", "source_channel", "fanout_status", "contact_id"]
        .forEach((f) => params.append("fields[]", f));
      params.set("sort[0][field]", "timestamp");
      params.set("sort[0][direction]", "desc");
      const r = await atFetch(`${encodeURIComponent(EVENTS)}?${params}`, { baseId: EVENTS_BASE_ID });
      const events = (r.records || []).map((rec) => {
        const { contact_id, ...rest } = rec.fields || {};
        return { ...rest, has_contact: Boolean(contact_id) };
      });
      return res.status(200).json({ last_24h_in_new_base: events.length, events });
    }

    const out = {
      dry_run: !write,
      scanned: 0, copied: 0, already_copied: 0, deleted: 0, unverifiable: 0,
      kept_unconfirmed: 0, done: false,
    };

    let offset;
    do {
      const params = new URLSearchParams({ pageSize: "100" });
      COPY_FIELDS.forEach((f) => params.append("fields[]", f));
      if (offset) params.set("offset", offset);
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await atFetch(`${encodeURIComponent(EVENTS)}?${params}`, { baseId: MAIN_BASE_ID });
      } catch (e) {
        // Deleting rows mid-iteration can kill Airtable's page cursor. Not a
        // failure: everything already deleted is done, and the next invocation
        // starts a fresh scan over whatever remains.
        if (offset) { out.iterator_lost = e.message.slice(0, 120); offset = undefined; break; }
        throw e;
      }
      const records = page.records || [];
      offset = page.offset;
      if (!records.length && out.scanned === 0) out.done = true;
      out.scanned += records.length;

      const rows = records.filter((r) => r.fields && r.fields.event_id);
      out.unverifiable += records.length - rows.length;
      if (!rows.length) continue;

      // eslint-disable-next-line no-await-in-loop
      const existing = await inNewBase(rows.map((r) => r.fields.event_id));
      const missing = rows.filter((r) => !existing.has(r.fields.event_id));
      out.already_copied += rows.length - missing.length;

      if (!write) {
        out.copied += missing.length;
        // A dry run only sizes the job; one page is a fair sample.
        break;
      }

      for (let i = 0; i < missing.length; i += 10) {
        const chunk = missing.slice(i, i + 10);
        // eslint-disable-next-line no-await-in-loop
        await atFetch(encodeURIComponent(EVENTS), {
          method: "POST",
          baseId: EVENTS_BASE_ID,
          body: JSON.stringify({
            records: chunk.map((r) => ({ fields: mapOldEvent(r.fields) })),
            typecast: true,
          }),
        });
        out.copied += chunk.length;
      }

      // The gate on every delete: a fresh read-back of the new base. Not the
      // write's response — an independent query, so a row is only ever
      // removed from the old base after the new base has said it holds it.
      // eslint-disable-next-line no-await-in-loop
      const confirmed = await inNewBase(rows.map((r) => r.fields.event_id));
      const deletable = rows.filter((r) => confirmed.has(r.fields.event_id));
      out.kept_unconfirmed += rows.length - deletable.length;

      for (let i = 0; i < deletable.length; i += 10) {
        const chunk = deletable.slice(i, i + 10);
        const del = new URLSearchParams();
        chunk.forEach((r) => del.append("records[]", r.id));
        // eslint-disable-next-line no-await-in-loop
        await atFetch(`${encodeURIComponent(EVENTS)}?${del}`, {
          method: "DELETE",
          baseId: MAIN_BASE_ID,
        });
        out.deleted += chunk.length;
      }
    } while (offset && Date.now() - started < TIME_BUDGET_MS);

    // Done means a complete pass (no cursor left, none lost) in which
    // re-running would change nothing: everything with an event_id was
    // removed, and only rows that can never be handled (no event_id) remain.
    // An unconfirmed row is retryable — its copy may simply have failed this
    // time — so it keeps the job open.
    if (!offset && !out.iterator_lost && out.kept_unconfirmed === 0
        && out.scanned === out.deleted + out.unverifiable) {
      out.done = true;
    }
    out.elapsed_s = Math.round((Date.now() - started) / 1000);
    return res.status(200).json(out);
  } catch (e) {
    console.error("migrate-events:", e.message);
    return res.status(500).json({ error: e.message.slice(0, 300) });
  }
};

module.exports.mapOldEvent = mapOldEvent;
