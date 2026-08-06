// POST /api/zernio-webhook
// Receives Zernio webhook events (comment.received, message.received,
// conversation.started, lead.received), verifies the HMAC signature,
// upserts an Identity, and appends a row to the Events log.
//
// Zernio delivery is at-least-once with up to 7 retries over ~51 hours,
// and auto-disables the subscription after 10 consecutive failures, so:
//   - always return 2xx once the signature checks out, even if a handler
//     hits an unexpected payload shape (log it, don't 500)
//   - dedupe on the stable webhook event id (payload.id)

const crypto = require('crypto');
const { getConversationParticipant } = require('../lib/social/zernio');
const {
  emailKey,
  phoneKey,
  socialKey,
  upsertIdentity,
  appendEvent,
} = require('../lib/social/identity');
const { fesc, select } = require('../lib/social/airtable');
const { TABLES } = require('../lib/social/config');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s()-]{8,}$/;

// Pull an email / phone out of a lead's flattened question->answer map
// without knowing the question keys in advance.
function extractLeadContact(fields = {}) {
  let email = null;
  let phone = null;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string') continue;
    const val = v.trim();
    if (!email && EMAIL_RE.test(val)) email = val.toLowerCase();
    else if (!phone && PHONE_RE.test(val) && /phone|mobile|number/i.test(k)) phone = val;
  }
  // second pass: any phone-shaped value if the key heuristic found nothing
  if (!phone) {
    for (const v of Object.values(fields)) {
      if (typeof v === 'string' && PHONE_RE.test(v.trim()) && !EMAIL_RE.test(v.trim())) {
        phone = v.trim();
        break;
      }
    }
  }
  return { email, phone };
}

async function handleComment(evt) {
  const c = evt.comment || {};
  const author = c.author || {};
  if (!author.id) return { skipped: 'no author id' };

  const key = socialKey(c.platform, author.id);
  const identity = await upsertIdentity(key, {
    platform: c.platform,
    platform_user_id: author.id,
    display_name: author.name,
    username: author.username,
    profile_picture: author.picture,
    interaction_type: 'comment',
  });

  const contactId =
    identity.fields && identity.fields.contact && identity.fields.contact.length
      ? identity.fields.contact[0]
      : null;

  await appendEvent(
    `zrn_${evt.id}`,
    'Social Comment',
    {
      identity_key: key,
      platform: c.platform,
      author: { id: author.id, name: author.name, username: author.username },
      text: c.text,
      comment_id: c.id,
      post_id: c.postId,
      platform_post_id: c.platformPostId,
      ad: c.ad || null,
      zernio_event_id: evt.id,
    },
    { contact: contactId }
  );
  return { identity: key };
}

async function handleMessage(evt) {
  const m = evt.message || {};
  if (m.direction && m.direction !== 'incoming') return { skipped: 'outgoing' };

  // Resolve who sent it. Payload sender fields first, then a cached identity
  // that already carries this conversation_id, then one Zernio lookup.
  const sender = m.sender || m.from || m.author || {};
  let userId = sender.id || null;
  let name = sender.name || sender.username || null;
  let picture = sender.picture || null;

  if (!userId && m.conversationId) {
    const cached = await select(
      TABLES.IDENTITIES,
      `{conversation_id} = '${fesc(m.conversationId)}'`,
      null,
      1
    );
    if (cached.length) {
      const f = cached[0].fields || {};
      userId = f.platform_user_id || null;
      name = name || f.display_name || null;
    }
  }
  if (!userId && m.conversationId) {
    const p = await getConversationParticipant(m.conversationId);
    if (p && p.participantId) {
      userId = p.participantId;
      name = name || p.participantName;
      picture = picture || p.participantPicture;
    }
  }

  // Last resort: key on the conversation so the interaction is still captured.
  const key = userId
    ? socialKey(m.platform, userId)
    : `conv|${m.platform}|${m.conversationId}`;

  const identity = await upsertIdentity(key, {
    platform: m.platform,
    platform_user_id: userId || undefined,
    display_name: name || undefined,
    profile_picture: picture || undefined,
    conversation_id: m.conversationId,
    interaction_type: 'dm',
  });

  const contactId =
    identity.fields && identity.fields.contact && identity.fields.contact.length
      ? identity.fields.contact[0]
      : null;

  await appendEvent(
    `zrn_${evt.id}`,
    'Social DM',
    {
      identity_key: key,
      platform: m.platform,
      conversation_id: m.conversationId,
      message_id: m.id,
      platform_message_id: m.platformMessageId,
      text: m.text,
      attachments: (m.attachments || []).map((a) => ({ type: a.type })),
      zernio_event_id: evt.id,
    },
    { contact: contactId }
  );
  return { identity: key };
}

async function handleConversationStarted(evt) {
  const c = evt.conversation || {};
  const participantId = c.participantId || (c.participant && c.participant.id) || null;
  const participantName =
    c.participantName || (c.participant && c.participant.name) || null;

  const key = participantId
    ? socialKey(c.platform, participantId)
    : `conv|${c.platform}|${c.id}`;

  await upsertIdentity(key, {
    platform: c.platform,
    platform_user_id: participantId || undefined,
    display_name: participantName || undefined,
    conversation_id: c.id,
    interaction_type: 'conversation_started',
  });

  await appendEvent(`zrn_${evt.id}`, 'Conversation Started', {
    identity_key: key,
    platform: c.platform,
    conversation_id: c.id,
    ad_attribution: c.metadata || null,
    zernio_event_id: evt.id,
  });
  return { identity: key };
}

async function handleLead(evt) {
  const lead = evt.lead || {};
  const { email, phone } = extractLeadContact(lead.fields);
  if (!email && !phone) return { skipped: 'no contact fields on lead' };

  const key = email ? emailKey(email) : phoneKey(phone);
  const identity = await upsertIdentity(key, {
    platform: 'email',
    email: email || undefined,
    phone: phone || undefined,
    interaction_type: 'lead',
  });

  const contactId =
    identity.fields && identity.fields.contact && identity.fields.contact.length
      ? identity.fields.contact[0]
      : null;

  // Deduped against the existing lead pipeline by leadgenId as well as event id.
  await appendEvent(
    `zrnlead_${lead.leadgenId || evt.id}`,
    'Meta Lead (Zernio)',
    {
      identity_key: key,
      leadgen_id: lead.leadgenId,
      form_id: lead.formId,
      form_name: lead.formName,
      ad_id: lead.adId,
      adset_id: lead.adsetId,
      campaign_id: lead.campaignId,
      fields: lead.fields,
      zernio_event_id: evt.id,
    },
    { contact: contactId }
  );
  return { identity: key };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const rawBody = await readRawBody(req);
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  const sig = req.headers['x-zernio-signature'];

  if (!verifySignature(rawBody, sig, secret)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let evt;
  try {
    evt = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  try {
    let result;
    switch (evt.event) {
      case 'comment.received':
        result = await handleComment(evt);
        break;
      case 'message.received':
        result = await handleMessage(evt);
        break;
      case 'conversation.started':
        result = await handleConversationStarted(evt);
        break;
      case 'lead.received':
        result = await handleLead(evt);
        break;
      default:
        result = { skipped: `unhandled event ${evt.event}` };
    }
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    // Signature was valid, so acknowledge to stop retries from eventually
    // disabling the subscription; surface the error in logs instead.
    console.error('zernio-webhook handler error', evt && evt.event, e);
    res.status(200).json({ ok: false, error: String(e && e.message) });
  }
};
