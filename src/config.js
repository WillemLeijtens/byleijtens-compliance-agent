try { require("dotenv").config(); } catch {}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FOUT: environment variable ${name} ontbreekt.`);
    process.exit(1);
  }
  return v;
}

// Sinds 1 januari 2026 leveren nieuwe (Dev Dashboard) custom apps geen
// statisch Admin API-token meer op — daarvoor is de client credentials
// grant nodig (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, zie src/shopify.js).
// Bestaande legacy custom apps (aangemaakt vóór 2026-01-01) blijven werken
// met een statisch SHOPIFY_ADMIN_ACCESS_TOKEN. Precies één van beide moet
// gezet zijn.
const hasClientCredentials = !!(process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_CLIENT_SECRET);
if (hasClientCredentials && (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET)) {
  console.error("FOUT: SHOPIFY_CLIENT_ID en SHOPIFY_CLIENT_SECRET moeten samen gezet zijn.");
  process.exit(1);
}
if (!hasClientCredentials && !process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.error("FOUT: stel SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (nieuwe custom apps) of SHOPIFY_ADMIN_ACCESS_TOKEN (legacy custom apps) in.");
  process.exit(1);
}

const CONFIG = {
  shopify: {
    storeDomain: required("SHOPIFY_STORE_DOMAIN"),
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    // Shopify versioneert per kwartaal (YYYY-01/04/07/10) en ondersteunt een
    // versie ~1 jaar. Controleer periodiek de actuele stabiele versie op
    // https://shopify.dev/docs/api/admin-graphql en werk dit bij.
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
    pageSize: Number(process.env.PAGE_SIZE || 50),
    maxRetries: 6,
  },
  github: {
    // In GitHub Actions automatisch beschikbaar — geen eigen secret nodig.
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "", // "owner/naam"
    openIssueOnViolation: (process.env.OPEN_GITHUB_ISSUE || "true") === "true",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  paths: {
    outputDir: process.env.OUTPUT_DIR || "reports",
    prohibitedListFile: process.env.PROHIBITED_LIST_FILE || "data/prohibited-list.json",
  },
  failOnViolation: (process.env.FAIL_ON_VIOLATION || "false") === "true",
  descriptionMaxLen: 400,
};

module.exports = CONFIG;
