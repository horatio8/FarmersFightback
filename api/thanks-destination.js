// GET /api/thanks-destination -> { destination: "/share" | "/donate" }
//
// One roll of the PETITION_SHARE_PERCENT dial (see _util.js) for flows that
// do not pass through /api/petition-signup -- today that is the volunteer
// form, whose submission goes to a form receiver rather than our own API.
// The petition pages get their verdict inside the signup response instead,
// so one signature never rolls twice.
//
// no-store, because a cached verdict would glue every visitor on a CDN edge
// to the same arm and quietly break the split.

const { rollThanksDestination } = require("./_util");

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  return res.status(200).json({ destination: rollThanksDestination() });
};
