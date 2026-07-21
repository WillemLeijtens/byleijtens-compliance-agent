// Lichte, losstaande Shopify-verbindingscheck voor het dashboard. Gebruikt
// bewust niet ./config.js — die doet process.exit(1) bij ontbrekende env
// vars, wat geschikt is voor het eenmalige sync-script maar niet voor de
// altijd-actieve dashboardserver (die moet gewoon "niet verbonden" tonen).
async function checkShopifyConnection() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) {
    return { ok: false, message: "SHOPIFY_STORE_DOMAIN niet gezet" };
  }

  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  let accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  try {
    if (!accessToken) {
      if (!clientId || !clientSecret) {
        return { ok: false, message: "geen SHOPIFY_ADMIN_ACCESS_TOKEN of SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET gezet" };
      }

      const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!tokenRes.ok) {
        return { ok: false, message: `kon geen access token ophalen (${tokenRes.status})` };
      }
      accessToken = (await tokenRes.json()).access_token;
    }

    const shopRes = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    });

    if (shopRes.status === 401 || shopRes.status === 403) {
      return { ok: false, message: `authenticatiefout (${shopRes.status}) — token ongeldig of ingetrokken` };
    }
    if (!shopRes.ok) {
      return { ok: false, message: `Shopify gaf status ${shopRes.status}` };
    }

    const shopJson = await shopRes.json();
    if (shopJson.errors?.length) {
      return { ok: false, message: shopJson.errors.map((e) => e.message).join("; ") };
    }

    return { ok: true, message: shopJson.data?.shop?.name || domain };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { checkShopifyConnection };
