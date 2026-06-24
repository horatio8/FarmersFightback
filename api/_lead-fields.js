// Shared normalizer for Meta Lead Ads field_data arrays. Used by both
// /api/meta-lead-webhook (native Meta webhook) and /api/event-log (Zapier
// relay) so a new form variant only needs a single alias edit.

const FIELD_ALIASES = {
  email: ["email", "email_address"],
  phone: ["phone_number", "phone", "mobile", "mobile_number"],
  postcode: ["post_code", "postcode", "zip", "zip_code", "postal_code"],
  first_name: ["first_name", "firstname"],
  last_name: ["last_name", "lastname", "surname"],
  full_name: ["full_name", "name"],
};

function normalizeLeadFields(field_data) {
  const arr = Array.isArray(field_data) ? field_data : [];
  const get = (aliases) => {
    for (const n of aliases) {
      const f = arr.find((x) => x && String(x.name).toLowerCase() === n);
      if (f && Array.isArray(f.values) && f.values[0]) return String(f.values[0]).trim();
    }
    return "";
  };
  const email = get(FIELD_ALIASES.email);
  const phone = get(FIELD_ALIASES.phone);
  const postcode = get(FIELD_ALIASES.postcode);
  let first_name = get(FIELD_ALIASES.first_name);
  let last_name = get(FIELD_ALIASES.last_name);
  if (!first_name && !last_name) {
    const full = get(FIELD_ALIASES.full_name);
    if (full) {
      const parts = full.split(/\s+/);
      first_name = parts[0] || "";
      last_name = parts.slice(1).join(" ") || "";
    }
  }
  return { first_name, last_name, email, mobile: phone, postcode };
}

module.exports = { FIELD_ALIASES, normalizeLeadFields };
