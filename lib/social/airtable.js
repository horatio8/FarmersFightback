// Minimal Airtable REST helper. No SDK dependency.
// Rate limit is 5 req/s per base; every call here is sequential per invocation,
// and the batch helpers sleep 250ms between requests to stay under it.

const { AIRTABLE_BASE_ID, airtableToken } = require('./config');

const API = 'https://api.airtable.com/v0';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function at(method, table, path, body, query) {
  let url = `${API}/${AIRTABLE_BASE_ID}/${table}${path || ''}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(`${k}[]`, x));
      else if (v !== undefined && v !== null) qs.append(k, String(v));
    }
    url += `?${qs.toString()}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${airtableToken()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    await sleep(1200);
    return at(method, table, path, body, query);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json && json.error ? JSON.stringify(json.error) : res.statusText;
    throw new Error(`Airtable ${method} ${table} ${res.status}: ${msg}`);
  }
  return json;
}

// List one page of records. Returns { records, offset }.
async function listPage(table, opts = {}) {
  return at('GET', table, '', null, opts);
}

// Find records matching a formula (first page only).
async function select(table, formula, fields, maxRecords) {
  const query = { filterByFormula: formula };
  if (fields) query.fields = fields;
  if (maxRecords) query.maxRecords = maxRecords;
  const out = await at('GET', table, '', null, query);
  return out.records || [];
}

// Create records (max 10 per request). Accepts any length; batches internally.
async function create(table, records, typecast = true) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await at('POST', table, '', {
      records: batch.map((fields) => ({ fields })),
      typecast,
    });
    out.push(...(res.records || []));
    if (i + 10 < records.length) await sleep(250);
  }
  return out;
}

// Update records by id (max 10 per request). items: [{id, fields}]
async function update(table, items, typecast = true) {
  const out = [];
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const res = await at('PATCH', table, '', { records: batch, typecast });
    out.push(...(res.records || []));
    if (i + 10 < items.length) await sleep(250);
  }
  return out;
}

// Upsert on a merge field (max 10 per request). records: array of fields objects.
async function upsert(table, records, mergeOn, typecast = true) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await at('PATCH', table, '', {
      performUpsert: { fieldsToMergeOn: mergeOn },
      records: batch.map((fields) => ({ fields })),
      typecast,
    });
    out.push(...(res.records || []));
    if (i + 10 < records.length) await sleep(250);
  }
  return out;
}

// Escape a value for use inside an Airtable formula string literal.
function fesc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = { listPage, select, create, update, upsert, fesc, sleep };
