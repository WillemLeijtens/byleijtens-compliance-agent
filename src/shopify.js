const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");

const ENDPOINT = `https://${CONFIG.shopify.storeDomain}/admin/api/${CONFIG.shopify.apiVersion}/graphql.json`;
const TOKEN_ENDPOINT = `https://${CONFIG.shopify.storeDomain}/admin/oauth/access_token`;
const CHECKPOINT_FILE = path.join(CONFIG.paths.outputDir, ".checkpoint.json");

// Nieuwe (Dev Dashboard) custom apps geven geen statisch token meer: het
// script vraagt zelf een token op via de client credentials grant. Tokens
// zijn 24u geldig; we cachen en vernieuwen ze met wat marge (zie
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant).
let cachedToken = null; // { accessToken, expiresAt }
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function fetchClientCredentialsToken() {
  let res;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CONFIG.shopify.clientId,
        client_secret: CONFIG.shopify.clientSecret,
      }),
    });
  } catch (networkErr) {
    throw new Error(`netwerkfout bij ophalen access token: ${networkErr.message}`);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`kon geen access token ophalen (${res.status}) — controleer SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET en of de app op deze store is geïnstalleerd. Response: ${body.slice(0, 500)}`);
  }

  const json = JSON.parse(body);
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
  };
}

/** Geeft een geldig Admin API-token terug: statisch token (legacy apps) of via client credentials grant (nieuwe apps). */
async function getAccessToken() {
  if (CONFIG.shopify.accessToken) return CONFIG.shopify.accessToken;

  if (!cachedToken || Date.now() > cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    cachedToken = await fetchClientCredentialsToken();
  }
  return cachedToken.accessToken;
}

const COUNT_QUERY = `
query ProductsCount {
  productsCount {
    count
  }
}`;

const QUERY = `
query ProductsWithIngredients($first: Int!, $cursor: String) {
  products(first: $first, after: $cursor) {
    edges {
      node {
        id
        title
        vendor
        status
        descriptionHtml
        featuredImage {
          url
          altText
        }
        variants(first: 5) {
          edges { node { sku } }
        }
        metafield(namespace: "custom", key: "ingredienten") {
          value
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(html, maxLen = CONFIG.descriptionMaxLen) {
  if (!html) return "";
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); } catch { return null; }
}
function saveCheckpoint(cursor, products, page) {
  fs.mkdirSync(CONFIG.paths.outputDir, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ cursor, products, page, savedAt: new Date().toISOString() }));
}
function clearCheckpoint() {
  try { fs.unlinkSync(CHECKPOINT_FILE); } catch {}
}

/**
 * Eén GraphQL-call met retry+backoff op netwerkfouten/5xx, expliciete
 * 429-afhandeling, directe fout bij 401/403, en proactieve throttling
 * op basis van Shopify's cost-extension.
 */
async function shopifyGraphQL(query, variables, attempt = 1) {
  let res;
  try {
    const accessToken = await getAccessToken();
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (networkErr) {
    if (attempt > CONFIG.shopify.maxRetries) throw new Error(`netwerkfout na ${attempt} pogingen: ${networkErr.message}`);
    const backoff = Math.min(2 ** attempt * 500, 20000) + Math.random() * 300;
    console.warn(`  ↻ netwerkfout, retry ${attempt}/${CONFIG.shopify.maxRetries} over ${Math.round(backoff)}ms`);
    await sleep(backoff);
    return shopifyGraphQL(query, variables, attempt + 1);
  }

  if (res.status === 429) {
    if (attempt > CONFIG.shopify.maxRetries) throw new Error("rate limit (429) — max retries bereikt.");
    const retryAfter = Number(res.headers.get("Retry-After")) || 2;
    console.warn(`  ↻ rate limited (429), wacht ${retryAfter}s…`);
    await sleep(retryAfter * 1000 + 200);
    return shopifyGraphQL(query, variables, attempt + 1);
  }

  if (res.status >= 500) {
    if (attempt > CONFIG.shopify.maxRetries) throw new Error(`Shopify server error ${res.status} na ${attempt} pogingen.`);
    const backoff = Math.min(2 ** attempt * 500, 20000);
    console.warn(`  ↻ server error ${res.status}, retry ${attempt}/${CONFIG.shopify.maxRetries} over ${backoff}ms`);
    await sleep(backoff);
    return shopifyGraphQL(query, variables, attempt + 1);
  }

  if (res.status === 401 || res.status === 403) {
    cachedToken = null; // eventueel verlopen/ingetrokken token niet opnieuw hergebruiken
    const body = await res.text().catch(() => "");
    const hint = CONFIG.shopify.accessToken
      ? "controleer SHOPIFY_ADMIN_ACCESS_TOKEN"
      : "controleer SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET en of de app op deze store is geïnstalleerd";
    throw new Error(`authenticatiefout (${res.status}) — ${hint}, de 'read_products'-scope, en metafield-toegang voor namespace "custom". Response: ${body.slice(0, 500)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`onverwachte HTTP-status ${res.status}. Response: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL-fout: ${json.errors.map((e) => e.message).join("; ")}`);

  const cost = json.extensions?.cost;
  if (cost?.throttleStatus) {
    const { currentlyAvailable, restoreRate } = cost.throttleStatus;
    const nextCost = cost.requestedQueryCost || 0;
    if (restoreRate > 0 && currentlyAvailable < nextCost * 1.5) {
      const waitMs = Math.ceil(((nextCost * 1.5 - currentlyAvailable) / restoreRate) * 1000);
      if (waitMs > 0) await sleep(waitMs);
    }
  }
  return json.data;
}

/** Vraagt het totaal aantal producten in de store op (los van de paginering
 * hieronder) — dient als referentiepunt om te zien of de sync alles ophaalde. */
async function fetchShopifyProductCount() {
  try {
    const data = await shopifyGraphQL(COUNT_QUERY, {});
    return data.productsCount?.count ?? null;
  } catch (e) {
    console.warn(`  ⚠ kon totaal aantal producten niet ophalen: ${e.message}`);
    return null;
  }
}

/** Haalt de volledige catalogus op (met resume vanaf checkpoint bij een eerdere mislukte run). */
async function fetchAllProducts() {
  const shopifyTotalCount = await fetchShopifyProductCount();

  const checkpoint = loadCheckpoint();
  let all = checkpoint?.products || [];
  let cursor = checkpoint?.cursor || null;
  let page = checkpoint?.page || 0;
  const errors = [];

  if (checkpoint) {
    console.log(`↻ Hervat vanaf checkpoint: pagina ${page}, ${all.length} producten al opgehaald (${checkpoint.savedAt}).`);
  }

  while (true) {
    page++;
    process.stdout.write(`Pagina ${page}… `);
    let data;
    try {
      data = await shopifyGraphQL(QUERY, { first: CONFIG.shopify.pageSize, cursor });
    } catch (e) {
      console.error(`FOUT: ${e.message}`);
      errors.push({ page, cursor, message: e.message, at: new Date().toISOString() });
      saveCheckpoint(cursor, all, page - 1);
      break;
    }

    const edges = data.products.edges;
    edges.forEach(({ node }) => {
      all.push({
        id: node.id,
        title: node.title,
        sku: node.variants.edges[0]?.node.sku || "",
        brand: node.vendor || "",
        description: stripHtml(node.descriptionHtml),
        inci: node.metafield?.value || "",
        status: node.status,
        image: node.featuredImage?.url || null,
      });
    });
    console.log(`${edges.length} producten (totaal ${all.length})`);

    if (page % 5 === 0) saveCheckpoint(data.products.pageInfo.endCursor, all, page);

    if (!data.products.pageInfo.hasNextPage) { clearCheckpoint(); break; }
    cursor = data.products.pageInfo.endCursor;
  }

  return { products: all, errors, shopifyTotalCount };
}

module.exports = { fetchAllProducts };
