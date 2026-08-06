// Minimal Zernio REST client.

const { ZERNIO_BASE, ZERNIO_PROFILE_ID, zernioKey } = require('./config');

async function zernio(method, path, body, query) {
  let url = `${ZERNIO_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    }
    url += `?${qs.toString()}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${zernioKey()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json && json.error ? JSON.stringify(json.error) : res.statusText;
    throw new Error(`Zernio ${method} ${path} ${res.status}: ${msg}`);
  }
  return json;
}

// Best-effort lookup of the human on the other side of a conversation.
// Returns { participantId, participantName, participantPicture } or null.
async function getConversationParticipant(conversationId) {
  try {
    const out = await zernio('GET', `/inbox/conversations/${encodeURIComponent(conversationId)}`);
    const c = out.data || out.conversation || out;
    if (c && (c.participantId || c.participantName)) {
      return {
        participantId: c.participantId || null,
        participantName: c.participantName || null,
        participantPicture: c.participantPicture || null,
      };
    }
  } catch (e) {
    // fall through to the list endpoint
  }
  try {
    // Scoped, like every other read: unscoped this scans four organisations'
    // inboxes to answer a question about one of ours.
    const out = await zernio('GET', '/inbox/conversations', null, {
      limit: 100,
      profileId: ZERNIO_PROFILE_ID,
    });
    const rows = out.data || [];
    const hit = rows.find((r) => r.id === conversationId);
    if (hit) {
      return {
        participantId: hit.participantId || null,
        participantName: hit.participantName || null,
        participantPicture: hit.participantPicture || null,
      };
    }
  } catch (e) {
    // give up quietly; caller falls back to a conversation-scoped key
  }
  return null;
}

module.exports = { zernio, getConversationParticipant };
