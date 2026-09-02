// Vercel serverless function: the merch catalogue, read from the Shopify
// store (shop.farmersfightback.com) and reshaped for the /shop page.
//
// Shopify publishes every online-store product at /products.json and each
// collection at /collections/<handle>/products.json without any token, so
// this needs no Storefront API key and nothing in Vercel env. Going through
// our own domain (rather than the browser calling Shopify directly) gives
// three things: one shape the page can trust, a CDN cache so a Shopify blip
// or rate limit does not blank the page, and a place to change the store
// address without touching the front end.
//
// GET /api/shop
// Response: {
//   store: { url, name, currency },
//   collections: [{ handle, title, count }],
//   products: [{
//     handle, title, type, tags, description, url,
//     price, priceMax, compareAt, available,
//     colour, fit,                     // read from Shopify tags
//     collections: [handle],
//     image: { src, alt, width, height } | null,
//     options: [{ name, values }],
//     variants: [{ id, title, price, available }],
//   }],
//   fetched_at
// }
//
// Purchases never touch this site: "Buy now" links go to Shopify's cart
// permalink, so checkout, payment, shipping and stock all stay in Shopify.

const site = require("../content/site.json");

const DEFAULT_STORE_URL = "https://shop.farmersfightback.com";
const UA = "Mozilla/5.0 (compatible; FarmersFightbackBot/1.0; +https://farmersfightback.com)";

// Tags Shopify carries on every product. The colour set is the merch
// palette; anything else in the tags is a category and stays in `tags`.
const COLOURS = ["Navy", "Beige", "Midnight Blue", "Red", "Black", "White", "Green", "Grey"];
const FITS = { "Men's": "mens", "Women's": "womens", Unisex: "unisex" };

function storeUrl() {
  const cfg = (site && site.shop) || {};
  return String(cfg.storeUrl || DEFAULT_STORE_URL).replace(/\/+$/, "");
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)\s*>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function money(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// One Shopify product (products.json shape) -> the shape the page renders.
function normaliseProduct(p, store, collectionsByHandle) {
  const variants = (p.variants || []).map((v) => ({
    id: v.id,
    title: v.title,
    price: money(v.price),
    compareAt: v.compare_at_price ? money(v.compare_at_price) : null,
    available: v.available !== false,
    sku: v.sku || null,
  }));
  const prices = variants.map((v) => v.price).filter((n) => n !== null);
  const img = (p.images && p.images[0]) || null;
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const colour = COLOURS.find((c) => tags.includes(c)) || null;
  const fitTag = Object.keys(FITS).find((f) => tags.includes(f));
  return {
    handle: p.handle,
    title: p.title,
    type: p.product_type || null,
    tags,
    description: stripHtml(p.body_html),
    url: `${store}/products/${p.handle}`,
    price: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    compareAt: variants.find((v) => v.compareAt)?.compareAt || null,
    available: variants.some((v) => v.available),
    colour,
    fit: fitTag ? FITS[fitTag] : null,
    collections: collectionsByHandle.get(p.handle) || [],
    image: img ? { src: img.src, alt: img.alt || p.title, width: img.width || null, height: img.height || null } : null,
    options: (p.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
    variants,
  };
}

// Shopify's cart permalink: /cart/<variant>:<qty> lands the shopper on
// checkout with that item already in the cart. Cart attributes travel onto
// the order, so the referral code and the fact that the sale came from the
// website are visible in Shopify against every order.
function buyUrl(store, variantId, { ref, source } = {}) {
  const q = new URLSearchParams();
  q.set("attributes[ff_source]", source || "farmersfightback.com");
  if (ref && String(ref).trim()) q.set("attributes[ff_ref]", String(ref).trim().toUpperCase());
  return `${store}/cart/${variantId}:1?${q.toString()}`;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function loadCatalogue(store = storeUrl()) {
  const [productsJson, collectionsJson] = await Promise.all([
    getJson(`${store}/products.json?limit=250`),
    getJson(`${store}/collections.json?limit=250`).catch(() => ({ collections: [] })),
  ]);

  // Shopify keeps collection membership on the collection, not the product,
  // so each collection is read once to map handle -> collections. "frontpage"
  // is Shopify's own homepage collection and is not a category.
  const collections = (collectionsJson.collections || [])
    .filter((c) => c.handle !== "frontpage")
    .map((c) => ({ handle: c.handle, title: c.title, count: c.products_count || 0 }));
  const byHandle = new Map();
  await Promise.all(collections.map(async (c) => {
    try {
      const j = await getJson(`${store}/collections/${c.handle}/products.json?limit=250`);
      for (const p of j.products || []) {
        if (!byHandle.has(p.handle)) byHandle.set(p.handle, []);
        byHandle.get(p.handle).push(c.handle);
      }
    } catch { /* a missing collection feed just leaves those products uncategorised */ }
  }));

  const products = (productsJson.products || [])
    .map((p) => normaliseProduct(p, store, byHandle))
    .filter((p) => p.variants.length);

  // A product in no collection would only ever show under "All", so it gets
  // a category of its own from its Shopify product type (e.g. the caps and
  // beanies, which sit outside every collection as of Sep 2026). The fix
  // proper is in Shopify: add the product to a collection and this goes away.
  const synthetic = new Map();
  for (const p of products) {
    if (p.collections.length || !p.type) continue;
    const handle = `type-${p.type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
    if (!synthetic.has(handle)) synthetic.set(handle, { handle, title: p.type, count: 0, synthetic: true });
    p.collections.push(handle);
  }
  const allCollections = [...collections, ...synthetic.values()];

  return {
    store: { url: store, name: (site.shop && site.shop.storeName) || "Farmers Fightback shop", currency: "AUD" },
    collections: allCollections.map((c) => ({ ...c, count: products.filter((p) => p.collections.includes(c.handle)).length })),
    products,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const out = await loadCatalogue();
    // Five minutes fresh at the edge, an hour of stale-while-revalidate: a
    // Shopify outage inside that window serves the last good catalogue.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json(out);
  } catch (err) {
    console.error("shop catalogue error:", err && err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not read the shop catalogue", store: storeUrl() });
  }
};

module.exports.storeUrl = storeUrl;
module.exports.normaliseProduct = normaliseProduct;
module.exports.buyUrl = buyUrl;
module.exports.loadCatalogue = loadCatalogue;
