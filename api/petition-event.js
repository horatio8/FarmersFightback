// Campaign Nucleus webhook receiver. CN POSTs here on form_entry.created.
// We validate the shared secret, check the form_id is one of ours, and
// bust the petition-count cache so the next /api/petition-count call
// returns fresh numbers without waiting on the 10s TTL.
//
// POST /api/petition-event
// Headers:    x-webhook-secret: <CN_WEBHOOK_SECRET>
// Body:       { form_id: <uuid>, ... }   (CN may nest under data.form_id)
//
// Environment variables:
//   CN_WEBHOOK_SECRET  — shared secret configured on the CN webhook
//
// IMPORTANT: on Vercel serverless, this function and /api/petition-count
// can run in different processes, so invalidating cache here may not
// affect the other function's in-process cache. The 10s TTL is the
// real-world ceiling for staleness. Promoting to Vercel KV would make
// the invalidation cross-process if low latency matters more than that.

const FF_FORM_IDS = new Set([
  "de602723-dce3-4a83-ab0b-b8156faf01e2", // Omnibus Petition
  "26c245da-cc8a-496b-976a-f4e399cdab68", // Hold the Gate
  "436f0df8-b0b2-42e9-a94f-2db7a80b0df0", // Baldwin Campaign
  "fb97da79-e214-424e-991f-092c4015affd", // Volunteer Subscription
  "4b9cac7f-1cff-4aa5-aefe-9f4391c47e5c", // Contact
  "08377f48-fc74-4c2e-a20d-de5e34353001", // Fuel & Fertiliser
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.headers["x-webhook-secret"] || req.headers["x-cn-webhook-secret"];
  if (!process.env.CN_WEBHOOK_SECRET || secret !== process.env.CN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const formId = body.form_id || (body.data && body.data.form_id);

  if (formId && FF_FORM_IDS.has(formId)) {
    try {
      const { invalidateCache } = require("./petition-count.js");
      if (typeof invalidateCache === "function") invalidateCache();
    } catch { /* fall through — TTL will refresh */ }
    return res.status(200).json({ ok: true, invalidated: true, formId });
  }

  return res.status(200).json({ ok: true, invalidated: false });
};
