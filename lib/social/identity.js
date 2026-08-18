// Identity + event primitives shared by the webhook, seed and resolver.

const crypto = require('crypto');
const { TABLES, EVENTS_SPLIT } = require('./config');
const { select, create, update, fesc } = require('./airtable');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function emailKey(email) {
  return `email|${sha256(String(email).trim().toLowerCase())}`;
}

function phoneKey(e164) {
  return `phone|${sha256(String(e164).replace(/[^\d+]/g, ''))}`;
}

function socialKey(platform, userId) {
  return `${platform}|${userId}`;
}

// Upsert an identity by identity_key.
// - creates the row (with first_seen) when new
// - bumps last_seen / interaction_count and fills any blank fields when existing
// - never overwrites an existing contact link or a non-empty display_name
// Returns the identity record { id, fields }.
async function upsertIdentity(key, attrs = {}) {
  const now = new Date().toISOString();
  const existing = await select(
    TABLES.IDENTITIES,
    `{identity_key} = '${fesc(key)}'`,
    null,
    1
  );

  if (existing.length === 0) {
    const fields = {
      identity_key: key,
      platform: attrs.platform,
      platform_user_id: attrs.platform_user_id,
      display_name: attrs.display_name,
      username: attrs.username,
      email: attrs.email,
      phone: attrs.phone,
      profile_picture: attrs.profile_picture,
      conversation_id: attrs.conversation_id,
      first_seen: now,
      last_seen: now,
      interaction_count: 1,
      last_interaction_type: attrs.interaction_type,
      resolution_status: attrs.contact ? 'Linked' : 'Unresolved',
      source: attrs.source || 'webhook',
    };
    if (attrs.contact) fields.contact = [attrs.contact];
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
    const [rec] = await create(TABLES.IDENTITIES, [fields]);
    return rec;
  }

  const rec = existing[0];
  const f = rec.fields || {};
  const patch = {
    last_seen: now,
    interaction_count: (f.interaction_count || 0) + 1,
  };
  if (attrs.interaction_type) patch.last_interaction_type = attrs.interaction_type;
  // fill blanks only
  for (const k of ['display_name', 'username', 'email', 'phone', 'profile_picture', 'conversation_id']) {
    if (attrs[k] && !f[k]) patch[k] = attrs[k];
  }
  if (attrs.contact && !(f.contact && f.contact.length)) {
    patch.contact = [attrs.contact];
    patch.resolution_status = 'Linked';
  }
  await update(TABLES.IDENTITIES, [{ id: rec.id, fields: patch }]);
  return { id: rec.id, fields: { ...f, ...patch } };
}

// Append a row to the Events log, deduped on event_id.
// Returns true if written, false if it already existed.
async function appendEvent(eventId, eventType, payload, opts = {}) {
  const existing = await select(
    TABLES.EVENTS,
    `{event_id} = '${fesc(eventId)}'`,
    ['event_id'],
    1
  );
  if (existing.length > 0) return false;

  const fields = {
    event_id: eventId,
    event_type: eventType, // typecast:true creates the select option if new
    timestamp: opts.timestamp || new Date().toISOString(),
    payload: JSON.stringify(payload),
  };
  if (opts.source_channel) fields.source_channel = opts.source_channel;
  // Contacts stayed in the main base, so once the log is split the link
  // becomes a plain record id. Nothing reads it back as a link -- the
  // Identities row is what ties a person to their Contact.
  if (opts.contact) {
    if (EVENTS_SPLIT) fields.contact_id = opts.contact;
    else fields.contact = [opts.contact];
  }
  await create(TABLES.EVENTS, [fields]);
  return true;
}

module.exports = { sha256, emailKey, phoneKey, socialKey, upsertIdentity, appendEvent };
